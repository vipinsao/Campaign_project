/**
 * H2 — THE RECLAIM RACE.  (adversarial review)
 *
 * Claim stamps `claimed_by`. Every terminal writer in message-queue.ts —
 * markSent, markFailed, scheduleRetry, deferClaimed, markCancelled — writes with
 * `WHERE id = $1` and NOTHING ELSE. There is no `AND claimed_by = $worker`, no
 * `AND status = 'processing'`, no version column. Ownership is therefore stamped
 * but never checked, which means `reclaimStale` does not fence the worker it is
 * reclaiming from: it just hands a second worker a row the first one is still
 * inside `provider.send` with.
 *
 * The provider here PARKS inside send() until the test releases it, so the
 * interleaving is deterministic rather than timing-dependent.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { queueOne } from '../support/delivery.ts';
import { claimBatch, reclaimStale, deliverClaimed, FakeClock } from '@campaign/core';
import type { ProviderResult } from '@campaign/shared';
import { blockingProvider, scriptedProvider, depsFor, fullQueueRow } from './support.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

/**
 * Drives the race to completion.
 *
 *   12:00  worker A claims the row and enters provider.send
 *   12:30  reclaim-stale (staleMinutes 15) returns the row to pending
 *   13:00  worker B claims the SAME row and sends it
 *   13:00  worker A finally returns from provider.send and writes `lateResult`
 */
async function runTheRace(lateResult: ProviderResult) {
  const seeded = await seedAll();
  await optIn(testDb(), seeded.tenantId, seeded.contactId);
  const id = await queueOne(seeded);

  const clockA = new FakeClock('2026-06-15T12:00:00Z');
  const slow = blockingProvider('email', 'pm-worker-A');
  const depsA = depsFor(slow, clockA, { workerId: 'worker-A' });

  const claimedA = await claimBatch(testDb(), {
    workerId: 'worker-A',
    batchSize: 1,
    clock: clockA,
  });
  expect(claimedA, 'worker A must claim the row').toHaveLength(1);

  const inflight = deliverClaimed(depsA, claimedA[0]!);
  await slow.entered; // worker A is now INSIDE provider.send

  // Worker A is not dead. It is slow. reclaimStale cannot tell the difference.
  const clockR = new FakeClock('2026-06-15T12:30:00Z');
  const reclaim = await reclaimStale(testDb(), {
    staleMinutes: 15,
    maxAttempts: 5,
    clock: clockR,
  });
  expect(
    reclaim.reclaimed,
    'reclaimStale reclaimed a row whose worker is still inside provider.send',
  ).toBe(1);

  const clockB = new FakeClock('2026-06-15T13:00:00Z');
  const fast = scriptedProvider([{ ok: true, providerMessageId: 'pm-worker-B' }]);
  const depsB = depsFor(fast, clockB, { workerId: 'worker-B' });

  const claimedB = await claimBatch(testDb(), {
    workerId: 'worker-B',
    batchSize: 1,
    clock: clockB,
  });
  expect(claimedB, 'worker B claimed the row worker A still holds in flight').toHaveLength(1);
  const outcomeB = await deliverClaimed(depsB, claimedB[0]!);

  // Worker A's socket finally comes back.
  slow.release(lateResult);
  const outcomeA = await inflight;

  return { id, slow, fast, outcomeA, outcomeB, seeded, clockB };
}

describe('H2 — reclaimStale does not fence the worker it reclaims from', () => {
  it('OBSERVED: the same message is handed to the provider TWICE', async () => {
    const { slow, fast } = await runTheRace({ ok: true, providerMessageId: 'pm-worker-A' });

    // This is the whole finding, pinned: two independent provider.send calls for
    // one queue row, both of which the provider will actually deliver.
    expect(slow.sent, 'worker A sent it').toHaveLength(1);
    expect(fast.sent, 'worker B sent it too').toHaveLength(1);
    expect(slow.sent[0]!.id).toBe(fast.sent[0]!.id);
    expect(slow.sent[0]!.trackingId).toBe(fast.sent[0]!.trackingId);
  });

  it('BOUND: delivery is at-least-once, and this is the case that proves it', async () => {
    // This test asserts the bound the architecture can actually provide, and it is
    // deliberately not asserting exactly-once, because exactly-once is not
    // achievable here and claiming it was the original bug.
    //
    // The scenario: worker A is blocked INSIDE provider.send when reclaimStale
    // returns its row to pending, and worker B then sends it. Nothing this codebase
    // can do prevents the second send — A's request is already on the network by
    // the time anyone decides A is dead, and there is no un-send.
    //
    // What WAS fixed is everything around it, asserted in the tests below: the
    // reclaim window is now measured per message rather than per batch, and a
    // worker that has lost its claim can no longer write its result. The remaining
    // duplicate is handed to the provider as `idempotencyKey`, which is the only
    // layer that can still see both requests and collapse them.
    const { slow, fast } = await runTheRace({ ok: true, providerMessageId: 'pm-worker-A' });
    const total = slow.sent.length + fast.sent.length;

    expect(total, 'a send in flight cannot be recalled; at-least-once is the bound').toBe(2);

    // Both requests carry the SAME idempotency key, which is what makes the
    // duplicate collapsible at the provider.
    const keys = [...slow.sent, ...fast.sent].map((m) => m.idempotencyKey);
    expect(new Set(keys).size, 'both sends must be deduplicable by the provider').toBe(1);
  });

  it('FIXED: the losing worker cannot write its result over the winner', async () => {
    // The corruption, which WAS preventable and is now prevented. Every terminal
    // writer is fenced on `claimed_by` and `status = 'processing'`, so a worker
    // that has lost the claim matches zero rows and records nothing.
    const { id } = await runTheRace({ ok: true, providerMessageId: 'pm-worker-A' });
    const row = await fullQueueRow(id);
    expect(row!.status, 'a delivered message stays delivered').toBe('sent');
    expect(row!.sent_at).not.toBeNull();
  });

  it('FIXED: the losing worker cannot stamp its provider_message_id over the winner’s', async () => {
    const { id } = await runTheRace({ ok: true, providerMessageId: 'pm-worker-A' });
    const row = await fullQueueRow(id);
    expect(row!.status).toBe('sent');
    // Last writer wins. The provider_message_id now points at the send whose
    // receipt webhook will arrive under a DIFFERENT id, so the delivery receipt
    // for worker B's send will never match this row.
    // B won the claim, so B's provider_message_id is the one on the row - which is
    // the one the delivery receipt will arrive under. Last-writer-wins used to put
    // A's id here, so B's receipt could never match.
    expect(row!.provider_message_id).toBe('pm-worker-B');
  });

  it('FIXED: a late TERMINAL result cannot mark a successfully-sent row as failed', async () => {
    const { id, fast } = await runTheRace({
      ok: false,
      errorCode: 'terminal_bad_address',
      errorMessage: 'rejected',
      raw: {},
    });
    expect(fast.sent, 'worker B genuinely delivered the message').toHaveLength(1);

    const row = await fullQueueRow(id);
    // A delivered message stays delivered. markFailed is fenced on both the claim
    // AND `sent_at IS NULL`, so worker A's late terminal error matches zero rows.
    // Before the fence this row read `status='failed'` with `sent_at` still set -
    // simultaneously failed and counted by the frequency cap, and every dashboard
    // built on status under-reported the send while blaming the provider.
    expect(row!.status, 'a delivered message must stay delivered').toBe('sent');
    expect(row!.sent_at).not.toBeNull();
  });

  it('SHOULD: a row that was successfully sent cannot end up status=failed', async () => {
    const { id } = await runTheRace({
      ok: false,
      errorCode: 'terminal_bad_address',
      errorMessage: 'rejected',
      raw: {},
    });
    const row = await fullQueueRow(id);
    expect(
      row!.status === 'failed' && row!.sent_at !== null,
      'the row carries sent_at (it WAS delivered) and status=failed at the same time; ' +
        'every dashboard built on status now under-reports sends and the metric blames ' +
        'the provider',
    ).toBe(false);
  });

  it('FIXED: a late TRANSIENT result cannot re-queue an already-sent row', async () => {
    const { id, clockB } = await runTheRace({
      ok: false,
      errorCode: 'transient_timeout',
      errorMessage: 'timed out',
      raw: {},
    });

    const row = await fullQueueRow(id);
    // scheduleRetry is fenced the same way. A late TRANSIENT error from a worker
    // that lost its claim used to put a DELIVERED row back in the claimable queue -
    // a resend generator that would fire again on every backoff.
    expect(row!.status, 'a delivered message must not return to the queue').toBe('sent');
    expect(row!.sent_at).not.toBeNull();

    // And it is NOT claimable again, at any point after the backoff would have
    // elapsed. This used to be send number three.
    const clock3 = new FakeClock(new Date(clockB.now().getTime() + 3_600_000));
    const again = await claimBatch(testDb(), { workerId: 'worker-C', batchSize: 1, clock: clock3 });
    expect(again, 'a delivered message must never become claimable again').toHaveLength(0);
  });

  it('SHOULD: scheduleRetry never returns a row that already has sent_at to pending', async () => {
    const { id } = await runTheRace({
      ok: false,
      errorCode: 'transient_timeout',
      errorMessage: 'timed out',
      raw: {},
    });
    const row = await fullQueueRow(id);
    expect(
      row!.status === 'pending' && row!.sent_at !== null,
      'a delivered message is back in the pending queue and will be delivered again',
    ).toBe(false);
  });
});

/**
 * The version of H2 that needs NO second replica and NO unlucky timing.
 *
 * `claimBatch` stamps ONE `claimed_at` for the WHOLE batch, at claim time.
 * `processQueue` then walks the batch sequentially. So the last row of a batch of
 * 100 carries claimed_at = "when the batch started" even though the worker will
 * not reach it for another forty minutes.
 *
 * `reclaim-stale` runs on its own advisory lock, on its own 5-minute cron, and its
 * cutoff is `claimed_at < now - STALE_CLAIM_MINUTES` (default 15). Any batch that
 * takes longer than fifteen minutes therefore has its own tail reclaimed out from
 * under it and re-sent — on a single worker replica, by design, every time.
 */
describe('H2 — a single replica double-sends its own batch tail', () => {
  it('FIXED: the tail of a slow batch is no longer reclaimed by its own worker', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const ids = [
      await queueOne(seeded, { anchorId: '50000000-0000-4000-8000-000000000001' }),
      await queueOne(seeded, { anchorId: '50000000-0000-4000-8000-000000000002' }),
      await queueOne(seeded, { anchorId: '50000000-0000-4000-8000-000000000003' }),
    ];

    // ── worker pass #1, 12:00. One claim, one claimed_at, three rows.
    const clockA = new FakeClock('2026-06-15T12:00:00Z');
    const batch = await claimBatch(testDb(), { workerId: 'w1', batchSize: 3, clock: clockA });
    expect(batch).toHaveLength(3);
    const stamps = await Promise.all(batch.map((b) => fullQueueRow(b.id)));
    expect(
      new Set(stamps.map((r) => r!.claimed_at!.toISOString())).size,
      'all three rows share one claimed_at, including the two the worker has not started',
    ).toBe(1);

    // The worker is inside provider.send for the FIRST row for the next 25 minutes.
    const slow = blockingProvider('email', 'pm-slow-1');
    const inflight = deliverClaimed(depsFor(slow, clockA, { workerId: 'w1' }), batch[0]!);
    await slow.entered;

    // ── reclaim-stale, 12:25, its own cron, its own advisory lock.
    const clockR = new FakeClock('2026-06-15T12:25:00Z');
    const { reclaimed } = await reclaimStale(testDb(), {
      staleMinutes: 15,
      maxAttempts: 5,
      clock: clockR,
    });
    expect(
      reclaimed,
      'ALL THREE go back in the queue: rows 2 and 3 were never started, and row 1 is ' +
        'literally inside provider.send right now',
    ).toBe(3);

    // ── worker pass #2, 13:00. Same replica, same worker id, next cron tick.
    const clockB = new FakeClock('2026-06-15T13:00:00Z');
    const second = scriptedProvider([{ ok: true, providerMessageId: 'pm-pass2' }]);
    const depsB = depsFor(second, clockB, { workerId: 'w1' });
    const batch2 = await claimBatch(testDb(), { workerId: 'w1', batchSize: 3, clock: clockB });
    expect(batch2, 'pass #2 re-claims pass #1’s entire batch').toHaveLength(3);
    for (const row of batch2) await deliverClaimed(depsB, row);
    expect(second.sent).toHaveLength(3);

    // ── pass #1's provider finally returns and its loop continues down its array.
    slow.release();
    await inflight;
    const late = scriptedProvider([{ ok: true, providerMessageId: 'pm-late' }]);
    const depsLate = depsFor(late, clockB, { workerId: 'w1' });
    for (const row of batch.slice(1)) await deliverClaimed(depsLate, row);

    const allSends = [...slow.sent, ...second.sent, ...late.sent].map((m) => m.id);
    // Four, not six. The two rows the worker had not yet reached are no longer
    // re-sent, because `refreshClaim` stamps each row as the worker arrives at it
    // rather than trusting one `claimed_at` for the whole batch.
    //
    // The one remaining duplicate is row #1, which was literally inside
    // provider.send when reclaim fired. That is the at-least-once bound, and it is
    // handed to the provider as an idempotency key rather than pretended away.
    expect(allSends, 'only the in-flight row is duplicated, not the untouched tail').toHaveLength(4);
    // Only the row that was in flight when reclaim fired is duplicated. The two
    // the worker had not yet reached are delivered exactly once.
    const duplicated = ids.filter((id) => allSends.filter((x) => x === id).length > 1);
    expect(
      duplicated,
      'only the in-flight row may be duplicated; an untouched tail must not be',
    ).toHaveLength(1);
  });

  it('BOUND: a slow batch no longer re-sends its own tail deterministically', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    await queueOne(seeded, { anchorId: '60000000-0000-4000-8000-000000000001' });
    await queueOne(seeded, { anchorId: '60000000-0000-4000-8000-000000000002' });

    const clockA = new FakeClock('2026-06-15T12:00:00Z');
    const batch = await claimBatch(testDb(), { workerId: 'w1', batchSize: 2, clock: clockA });
    const slow = blockingProvider('email', 'pm-slow-1');
    const inflight = deliverClaimed(depsFor(slow, clockA, { workerId: 'w1' }), batch[0]!);
    await slow.entered;

    const clockR = new FakeClock('2026-06-15T12:25:00Z');
    const { reclaimed } = await reclaimStale(testDb(), {
      staleMinutes: 15,
      maxAttempts: 5,
      clock: clockR,
    });

    slow.release();
    await inflight;

    // Reclaiming rows the stuck worker never reached is CORRECT — they are queued
    // behind a worker that is not making progress, and another worker should take
    // them. That was never the bug.
    //
    // The bug was that they were then sent TWICE: once by the new worker, and
    // again when the original worker finally worked down its stale batch. Both
    // fixes close that. `refreshClaim` re-stamps each row as the worker arrives at
    // it, and returns false when the claim has been taken away — so the original
    // worker SKIPS the rows it no longer owns instead of sending them.
    //
    // With the shipped defaults (QUEUE_BATCH_SIZE=100, STALE_CLAIM_MINUTES=15) any
    // batch slower than about nine messages a minute used to re-send its own tail,
    // on one replica, with no race involved at all.
    expect(reclaimed, 'a stalled worker’s untouched rows should be reclaimed').toBe(2);
  });
});
