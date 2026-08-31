/**
 * H7 — the frequency cap counts `sent_at IS NOT NULL` rows in the window.
 *
 * Three questions:
 *   (a) does it count the message currently being evaluated? — no. SAFE.
 *   (b) does it count messages that later BOUNCED / were marked failed? — yes,
 *       because nothing ever clears `sent_at`. Defensible for a soft bounce,
 *       wrong for a hard bounce, and definitely wrong for the H2 artefact where a
 *       row carries `sent_at` and `status='failed'` for a send that DID land.
 *   (c) is the count race-free? — no. It is a plain SELECT with no lock and no
 *       reservation, so N workers evaluating the same contact concurrently all
 *       read the same pre-send count and all pass.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { queueOne } from '../support/delivery.ts';
import { claimBatch, deliverClaimed, processQueue, FakeClock } from '@campaign/core';
import { scriptedProvider, blockingProvider, depsFor, fullQueueRow } from './support.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

const A1 = '30000000-0000-4000-8000-000000000001';
const A2 = '30000000-0000-4000-8000-000000000002';

async function tenantWithCap(cap: number) {
  const seeded = await seedAll(testDb(), { tenant: { freqCapCount: cap, freqCapWindow: '7 days' } });
  await optIn(testDb(), seeded.tenantId, seeded.contactId);
  return seeded;
}

describe('H7(a) — self-counting', () => {
  it('SAFE: the message under evaluation does not count itself', async () => {
    const seeded = await tenantWithCap(1);
    const id = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z', anchorId: A1 });

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    const provider = scriptedProvider([{ ok: true, providerMessageId: 'pm-1' }]);
    await processQueue(depsFor(provider, clock));

    // Cap of 1, zero prior sends: it must go out. (sent_at is NULL while the row is
    // in `processing`, so the count sees 0.)
    expect(provider.sent).toHaveLength(1);
    expect((await fullQueueRow(id))!.status).toBe('sent');
  });

  it('SAFE: the second message for the same contact is correctly capped', async () => {
    const seeded = await tenantWithCap(1);
    await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z', anchorId: A1 });
    const second = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z', anchorId: A2 });

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    const provider = scriptedProvider([{ ok: true, providerMessageId: 'pm-1' }]);
    const summary = await processQueue(depsFor(provider, clock));

    expect(summary.claimed).toBe(2);
    expect(provider.sent, 'one sent, one capped').toHaveLength(1);
    const row = await fullQueueRow(second);
    expect(row!.status).toBe('pending');
    expect(row!.deferrals).toBe(1);
  });
});

describe('H7(b) — bounced and failed messages still count', () => {
  it('OBSERVED: a message the provider BOUNCED still consumes a slot in the cap', async () => {
    const seeded = await tenantWithCap(1);
    const first = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z', anchorId: A1 });
    const second = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z', anchorId: A2 });

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    await processQueue(depsFor(scriptedProvider([{ ok: true, providerMessageId: 'pm-1' }]), clock));
    expect((await fullQueueRow(first))!.status).toBe('sent');

    // The provider webhook comes back: hard bounce. The recipient never saw it.
    await testDb().query(`UPDATE message_queue SET status = 'bounced' WHERE id = $1`, [first]);

    // `sent_at` was never cleared, so the cap query still counts it.
    clock.advanceHours(2);
    await testDb().query(`UPDATE message_queue SET scheduled_at = $2 WHERE id = $1`, [
      second,
      clock.now(),
    ]);
    const provider2 = scriptedProvider([{ ok: true, providerMessageId: 'pm-2' }]);
    await processQueue(depsFor(provider2, clock));

    expect(
      provider2.sent,
      'the bounce consumed the contact’s only slot for the next 7 days',
    ).toHaveLength(0);
    const { rows } = await testDb().query<{ reason_code: string }>(
      `SELECT reason_code FROM send_decisions WHERE message_queue_id = $1 ORDER BY id DESC LIMIT 1`,
      [second],
    );
    expect(rows[0]!.reason_code).toBe('frequency_cap');
  });

  it('OBSERVED: a row with status=failed but a surviving sent_at also counts (the H2 artefact)', async () => {
    const seeded = await tenantWithCap(1);
    const first = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z', anchorId: A1 });
    const second = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z', anchorId: A2 });

    // Exactly the state H2's late-terminal-write produces: delivered, recorded failed.
    await testDb().query(
      `UPDATE message_queue
          SET status='failed', error_class='terminal', sent_at='2026-06-15T11:30:00Z'
        WHERE id = $1`,
      [first],
    );

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    const provider = scriptedProvider([{ ok: true, providerMessageId: 'pm-2' }]);
    await processQueue(depsFor(provider, clock));

    expect(provider.sent, 'a "failed" row consumed the cap').toHaveLength(0);
    expect((await fullQueueRow(second))!.deferrals).toBe(1);
  });
});

describe('H7(c) — the cap is a read with no reservation', () => {
  /**
   * Worker A claims message 1 and enters provider.send. Worker B then claims
   * message 2 for the SAME contact and runs its own gates. At that moment message
   * 1 has sent_at = NULL (still `processing`), so B's count is 0 and B passes a cap
   * of 1. Both send.
   */
  async function raceTwoWorkers() {
    const seeded = await tenantWithCap(1);
    const id1 = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z', anchorId: A1 });
    const id2 = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z', anchorId: A2 });

    const clockA = new FakeClock('2026-06-15T12:00:00Z');
    const slow = blockingProvider('email', 'pm-A');
    const claimedA = await claimBatch(testDb(), { workerId: 'A', batchSize: 1, clock: clockA });
    expect(claimedA).toHaveLength(1);
    const inflight = deliverClaimed(depsFor(slow, clockA, { workerId: 'A' }), claimedA[0]!);
    await slow.entered;

    const clockB = new FakeClock('2026-06-15T12:00:01Z');
    const fast = scriptedProvider([{ ok: true, providerMessageId: 'pm-B' }]);
    const claimedB = await claimBatch(testDb(), { workerId: 'B', batchSize: 1, clock: clockB });
    expect(claimedB, 'worker B claimed the other message for the same contact').toHaveLength(1);
    await deliverClaimed(depsFor(fast, clockB, { workerId: 'B' }), claimedB[0]!);

    slow.release();
    await inflight;
    return { slow, fast, ids: [id1, id2] };
  }

  it('OBSERVED: two workers both pass a cap of 1 and both send', async () => {
    const { slow, fast } = await raceTwoWorkers();
    expect(slow.sent, 'worker A sent').toHaveLength(1);
    expect(fast.sent, 'worker B sent too, against a cap of 1').toHaveLength(1);
  });

  it('SHOULD: the frequency cap holds under concurrency', async () => {
    const { slow, fast, ids } = await raceTwoWorkers();

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue
        WHERE id = ANY($1::uuid[]) AND sent_at IS NOT NULL`,
      [ids],
    );
    expect(
      Number(rows[0]!.n),
      'underFrequencyCap is an unlocked SELECT count(*) with no reservation and no ' +
        'row lock on the contact, so every worker evaluating the same contact in the ' +
        'same instant reads the same pre-send total. With batchSize 100 and one ' +
        'worker the cap holds because sends are sequential; add a second replica ' +
        '(which the advisory lock explicitly permits for delivery, since only ONE ' +
        'process-queue run is locked at a time but reclaimStale hands rows to ' +
        'whoever asks) and the cap becomes advisory. Sent: ' +
        `${slow.sent.length + fast.sent.length}`,
    ).toBe(1);
  });
});
