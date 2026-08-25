/**
 * I3 — Claiming is atomic and crash-safe.
 *
 * Failure it prevents: double sends under concurrency, and messages permanently
 * stuck in `processing` because the worker that claimed them died.
 *
 * This test is the reason the suite runs against a real PostgreSQL. FOR UPDATE
 * SKIP LOCKED is a property of the server's lock manager; a mocked database would
 * mock away precisely the behaviour under test and the test would pass whatever
 * the implementation did.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { claimBatch, reclaimStale } from '@campaign/core';
import { FakeClock } from '@campaign/core';

const ROWS = 100;
const WORKERS = 8;

const NOW = '2026-06-15T12:00:00Z';

async function queueMessages(count: number, scheduledAt: Date = new Date('2026-06-15T11:00:00Z')) {
  const db = testDb();
  const seeded = await seedAll(db);
  await optIn(db, seeded.tenantId, seeded.contactId);

  // Distinct anchors give distinct generated dedup keys, so all `count` rows insert.
  await db.query(
    `INSERT INTO message_queue
       (tenant_id, enrollment_id, campaign_id, campaign_version_id, campaign_message_id,
        contact_id, anchor_id, channel, recipient_address, rendered_body, scheduled_at)
     SELECT $1,$2,$3,$4,$5,$6, gen_random_uuid(), 'email', 'r@example.com', 'body', $7::timestamptz
       FROM generate_series(1, $8)`,
    [
      seeded.tenantId,
      seeded.enrollmentId,
      seeded.campaignId,
      seeded.campaignVersionId,
      seeded.campaignMessageId,
      seeded.contactId,
      scheduledAt,
      count,
    ],
  );
  return seeded;
}

afterAll(closeTestDb);
beforeEach(resetDb);

describe('I3 — concurrent claim is exactly once', () => {
  it(`gives ${WORKERS} concurrent workers disjoint sets covering all ${ROWS} rows`, async () => {
    await queueMessages(ROWS);
    const clock = new FakeClock(NOW);
    const url = process.env['DATABASE_URL']!;

    // Genuinely separate connection pools, so the workers contend in the server's
    // lock manager rather than being serialised by one client-side pool.
    const pools = Array.from(
      { length: WORKERS },
      () => new Pool({ connectionString: url, max: 4 }),
    );

    try {
      const results = await Promise.all(
        pools.map((pool, i) => claimBatch(pool, { workerId: `worker-${i}`, batchSize: 40, clock })),
      );

      const claimedIds = results.flat().map((r) => r.id);
      const unique = new Set(claimedIds);

      expect(
        claimedIds.length,
        `${claimedIds.length - unique.size} row(s) were claimed by more than one worker`,
      ).toBe(unique.size);

      expect(unique.size, 'every queued row should have been claimed exactly once').toBe(ROWS);

      // And each row records WHICH worker owns it — the stamp reclaimStale needs.
      const { rows } = await testDb().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM message_queue
          WHERE status = 'processing' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL`,
      );
      expect(Number(rows[0]!.n)).toBe(ROWS);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('increments attempts exactly once per claim', async () => {
    await queueMessages(10);
    const clock = new FakeClock(NOW);
    await claimBatch(testDb(), { workerId: 'w1', batchSize: 10, clock });

    const { rows } = await testDb().query<{ attempts: number }>(
      `SELECT DISTINCT attempts FROM message_queue`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(1);
  });
});

describe('I3 — stranded rows are reclaimed, not abandoned', () => {
  it('returns rows whose worker died back to pending', async () => {
    await queueMessages(5);
    const clock = new FakeClock(NOW);
    await claimBatch(testDb(), { workerId: 'doomed-worker', batchSize: 5, clock });

    // The worker is OOM-killed here. Nothing releases the rows.
    clock.advanceMinutes(30);

    const { reclaimed, exhausted } = await reclaimStale(testDb(), {
      staleMinutes: 15,
      maxAttempts: 5,
      clock,
    });
    expect(reclaimed).toBe(5);
    expect(exhausted).toBe(0);

    const { rows } = await testDb().query<{ status: string; claimed_by: string | null }>(
      `SELECT status, claimed_by FROM message_queue`,
    );
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.every((r) => r.claimed_by === null)).toBe(true);
  });

  it('does not reclaim a row that is still within the stale window', async () => {
    await queueMessages(3);
    const clock = new FakeClock(NOW);
    await claimBatch(testDb(), { workerId: 'busy-worker', batchSize: 3, clock });

    clock.advanceMinutes(5);
    const { reclaimed } = await reclaimStale(testDb(), { staleMinutes: 15, maxAttempts: 5, clock });
    expect(reclaimed).toBe(0);
  });

  it('fails a row that has exhausted its attempts rather than reclaiming it forever', async () => {
    await queueMessages(2);
    const clock = new FakeClock(NOW);
    await testDb().query(`UPDATE message_queue SET attempts = 5`);
    await testDb().query(
      `UPDATE message_queue SET status='processing', claimed_at = $1::timestamptz - interval '1 hour', claimed_by='dead'`,
      [NOW],
    );

    const { reclaimed, exhausted } = await reclaimStale(testDb(), {
      staleMinutes: 15,
      maxAttempts: 5,
      clock,
    });
    expect(reclaimed).toBe(0);
    expect(exhausted).toBe(2);

    const { rows } = await testDb().query<{ status: string; provider_error_code: string }>(
      `SELECT status, provider_error_code FROM message_queue`,
    );
    expect(rows.every((r) => r.status === 'failed')).toBe(true);
    expect(rows.every((r) => r.provider_error_code === 'stale_claim_exhausted')).toBe(true);
  });
});
