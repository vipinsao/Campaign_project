/**
 * H3 — scheduleRetry vs deferClaimed, and the ownership fence that settles them.
 *
 * Both writers return a row to `pending`, and they disagree about WHICH column
 * gates the next claim:
 *
 *   deferClaimed  -> scheduled_at = until,  next_attempt_at = NULL
 *   scheduleRetry -> scheduled_at = LEAST(scheduled_at, retryAt), next_attempt_at = retryAt
 *
 * `claimBatch` requires BOTH (`scheduled_at <= now AND (next_attempt_at IS NULL OR
 * next_attempt_at <= now)`). Before the fix neither writer checked the row's status
 * or `claimed_by`, so whichever ran second wrote its half over a row it no longer
 * owned. The combined row was a lie: it advertised a retry a minute out while
 * actually being unclaimable for another 21 hours.
 *
 * The fix is one predicate — `AND claimed_by = $n AND status = 'processing'` — on
 * every terminal writer, plus `scheduled_at` moving with `next_attempt_at` so a
 * retry can never advertise a time the claim query will ignore.
 *
 * The consequence is what this file pins down: a writer that has lost the claim
 * writes NOTHING and returns false. Only one worker owns a row's outcome, so the
 * two writers can no longer interleave into an incoherent row, and no late or
 * duplicated writer can reopen a terminal one.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { queueOne } from '../support/delivery.ts';
import {
  claimBatch,
  deferClaimed,
  scheduleRetry,
  markSent,
  markCancelled,
  markFailed,
  FakeClock,
} from '@campaign/core';
import { fullQueueRow } from './support.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

/** The worker that claimBatch stamps on the row, and therefore the only owner. */
const OWNER = 'w1';

async function claimedRow() {
  const seeded = await seedAll();
  await optIn(testDb(), seeded.tenantId, seeded.contactId);
  const id = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z' });
  const clock = new FakeClock('2026-06-15T12:00:00Z');
  const claimed = await claimBatch(testDb(), { workerId: OWNER, batchSize: 1, clock });
  expect(claimed).toHaveLength(1);
  return { id, clock, seeded };
}

const retry = (id: string, clock: FakeClock, delayMs: number, claimedBy = OWNER) =>
  scheduleRetry(testDb(), {
    claimedBy,
    id,
    provider: 'mock',
    errorCode: 'transient_timeout',
    errorMessage: 'timed out',
    delayMs,
    clock,
  });

describe('H3 — a deferral and a retry on the same row can no longer interleave', () => {
  it('defer wins the row, and the late retry behind it writes nothing', async () => {
    const { id, clock } = await claimedRow();

    // Worker B's quiet-hours deferral lands first and releases the claim...
    expect(
      await deferClaimed(testDb(), {
        claimedBy: OWNER,
        id,
        until: new Date('2026-06-16T09:00:00Z'),
        clock,
      }),
      'the owner defers its own row',
    ).toBe(true);

    // ...then worker A, reclaimed out from under (see H2), posts a transient retry.
    expect(
      await retry(id, clock, 60_000),
      'the row is pending and unowned, so the retry matches zero rows',
    ).toBe(false);

    const row = await fullQueueRow(id);
    expect(row!.status).toBe('pending');
    // One writer owned the schedule, so both columns tell the same story.
    expect(row!.scheduled_at.toISOString(), 'the deferral, intact').toBe(
      '2026-06-16T09:00:00.000Z',
    );
    expect(row!.next_attempt_at, 'and no competing retry time').toBeNull();
    // A quiet-hours deferral is not a provider failure and must not be dressed as one.
    expect(row!.error_class).toBeNull();
    expect(row!.provider_error_code).toBeNull();

    const later = new FakeClock('2026-06-15T12:05:00Z');
    const claimed = await claimBatch(testDb(), { workerId: 'w2', batchSize: 5, clock: later });
    expect(claimed, 'still deferred to tomorrow morning, as the row says').toHaveLength(0);
  });

  it('a row is claimable at the next_attempt_at it advertises', async () => {
    const { id, clock } = await claimedRow();
    expect(await retry(id, clock, 60_000)).toBe(true);

    const row = await fullQueueRow(id);
    expect(row!.next_attempt_at!.toISOString(), 'retry says: one minute').toBe(
      '2026-06-15T12:01:00.000Z',
    );
    expect(
      row!.scheduled_at.getTime(),
      'scheduled_at moved with it rather than gating it out',
    ).toBeLessThanOrEqual(row!.next_attempt_at!.getTime());

    const later = new FakeClock('2026-06-15T12:05:00Z');
    const claimed = await claimBatch(testDb(), { workerId: 'w2', batchSize: 5, clock: later });
    expect(
      claimed.length,
      'the retry time the operator reads in /queue is the time the claim query honours',
    ).toBe(1);
  });

  it('retry wins the row, and the deferral behind it cannot erase the backoff', async () => {
    const { id, clock } = await claimedRow();
    expect(await retry(id, clock, 60_000)).toBe(true);

    expect(
      await deferClaimed(testDb(), {
        claimedBy: OWNER,
        id,
        until: new Date('2026-06-16T09:00:00Z'),
        clock,
      }),
      'the claim was released by the retry; the deferral matches zero rows',
    ).toBe(false);

    const row = await fullQueueRow(id);
    expect(row!.next_attempt_at!.toISOString(), 'the backoff survives').toBe(
      '2026-06-15T12:01:00.000Z',
    );
    expect(row!.attempts, 'and the attempt a real send consumed is not handed back').toBe(1);
    expect(row!.deferrals, 'nothing was deferred').toBe(0);
  });
});

describe('the ownership fence — no writer can reopen a row it does not own', () => {
  it('deferClaimed cannot resurrect a SENT row into the pending queue', async () => {
    const { id, clock } = await claimedRow();
    expect(
      await markSent(testDb(), {
        claimedBy: OWNER,
        id,
        provider: 'mock',
        providerMessageId: 'pm-1',
        clock,
      }),
    ).toBe(true);
    expect((await fullQueueRow(id))!.status).toBe('sent');

    expect(
      await deferClaimed(testDb(), {
        claimedBy: OWNER,
        id,
        until: new Date('2026-06-15T12:30:00Z'),
        clock,
      }),
      'sent is terminal and unowned; the deferral writes nothing',
    ).toBe(false);

    const row = await fullQueueRow(id);
    expect(row!.status, 'a message that reached the provider stays sent').toBe('sent');
    expect(row!.sent_at, 'carrying the timestamp of the send that happened').not.toBeNull();
  });

  it('scheduleRetry cannot resurrect a CANCELLED row into the pending queue', async () => {
    const { id, clock } = await claimedRow();
    expect(
      await markCancelled(testDb(), { claimedBy: OWNER, id, reasonCode: 'consent_opted_out', clock }),
    ).toBe(true);
    expect((await fullQueueRow(id))!.status).toBe('cancelled');

    expect(await retry(id, clock, 0), 'the retry matches zero rows').toBe(false);

    const row = await fullQueueRow(id);
    expect(row!.status, 'a row cancelled for opt-out is never queued again (I6)').toBe('cancelled');

    const claimed = await claimBatch(testDb(), {
      workerId: 'w3',
      batchSize: 1,
      clock: new FakeClock('2026-06-15T12:10:00Z'),
    });
    expect(claimed, 'and unclaimable').toHaveLength(0);
  });

  it('no queue writer can move a terminal row back to pending', async () => {
    const { id, clock } = await claimedRow();
    expect(
      await markFailed(testDb(), {
        claimedBy: OWNER,
        id,
        provider: 'mock',
        errorCode: 'terminal_bad_address',
        errorMessage: 'no',
        errorClass: 'terminal',
        clock,
      }),
    ).toBe(true);

    expect(
      await deferClaimed(testDb(), {
        claimedBy: OWNER,
        id,
        until: new Date('2026-06-15T12:30:00Z'),
        clock,
      }),
      'every writer in message-queue.ts now carries `AND claimed_by = $n AND ' +
        "status = 'processing'`, so a late or duplicated writer cannot reopen a " +
        'terminal row — the same fence that makes H2 a single send',
    ).toBe(false);

    expect((await fullQueueRow(id))!.status).toBe('failed');
  });
});
