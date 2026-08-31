/**
 * H6 — the ANCHOR_PARKED sentinel (`scheduled_at = 'infinity'`).
 *
 * Two claims to check: that `scheduled_at <= $1` excludes the sentinel, and that
 * the partial index `WHERE status='pending' AND scheduled_at < 'infinity'` is
 * actually usable by the claim query. The first is safe. The second is where the
 * interesting answer is: the index predicate is written against a literal, the
 * claim query filters against a PARAMETER, and the planner cannot prove
 * `scheduled_at <= $1` implies `scheduled_at < 'infinity'` for an unknown $1.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { enqueue, claimBatch, ANCHOR_PARKED, FakeClock } from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

const NOW = '2026-06-15T12:00:00Z';

const CLAIM_SQL = `WITH claimed AS (
         SELECT id FROM message_queue
          WHERE status = 'pending'
            AND scheduled_at <= $1
            AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY scheduled_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE message_queue m
          SET status = 'processing', claimed_at = $1, claimed_by = $3,
              attempts = m.attempts + 1, updated_at = $1
         FROM claimed
        WHERE m.id = claimed.id
       RETURNING m.id`;

async function seedMixed(parked: number, ready: number) {
  const seeded = await seedAll();
  await optIn(testDb(), seeded.tenantId, seeded.contactId);
  for (let i = 0; i < parked; i++) {
    await enqueue(testDb(), {
      tenantId: seeded.tenantId,
      enrollmentId: seeded.enrollmentId,
      campaignId: seeded.campaignId,
      campaignVersionId: seeded.campaignVersionId,
      campaignMessageId: seeded.campaignMessageId,
      contactId: seeded.contactId,
      anchorId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      channel: 'email',
      recipientAddress: 'r@example.com',
      renderedBody: 'body',
      scheduledAt: null, // -> ANCHOR_PARKED
    });
  }
  for (let i = 0; i < ready; i++) {
    await enqueue(testDb(), {
      tenantId: seeded.tenantId,
      enrollmentId: seeded.enrollmentId,
      campaignId: seeded.campaignId,
      campaignVersionId: seeded.campaignVersionId,
      campaignMessageId: seeded.campaignMessageId,
      contactId: seeded.contactId,
      anchorId: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      channel: 'email',
      recipientAddress: 'r@example.com',
      renderedBody: 'body',
      scheduledAt: new Date('2026-06-15T11:00:00Z'),
    });
  }
  return seeded;
}

describe('H6 — parked rows are correctly excluded from the claim', () => {
  it('SAFE: `scheduled_at <= now` excludes infinity, and ANCHOR_PARKED really is infinity', async () => {
    await seedMixed(5, 3);
    expect(ANCHOR_PARKED).toBe('infinity');

    const { rows: stored } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue WHERE scheduled_at = 'infinity'`,
    );
    expect(Number(stored[0]!.n), 'the sentinel is stored as a real infinity').toBe(5);

    const claimed = await claimBatch(testDb(), {
      workerId: 'w',
      batchSize: 100,
      clock: new FakeClock(NOW),
    });
    expect(claimed, 'only the three ready rows').toHaveLength(3);

    const { rows: left } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue
        WHERE scheduled_at = 'infinity' AND status = 'pending'`,
    );
    expect(Number(left[0]!.n), 'the parked rows were untouched').toBe(5);
  });

  it('SAFE: the partial index physically contains no parked rows', async () => {
    await seedMixed(5, 3);
    const client = await testDb().connect();
    try {
      await client.query('ANALYZE message_queue');
      await client.query('SET enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS OFF, COSTS OFF, TIMING OFF, SUMMARY OFF)
         SELECT id FROM message_queue
          WHERE status = 'pending' AND scheduled_at < 'infinity'`,
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan, 'the partial index is used and returns exactly the ready rows').toContain(
        'message_queue_claimable',
      );
      expect(plan).toMatch(/rows=3/);
    } finally {
      client.release();
    }
  });

  it('SAFE: the real claim query DOES use message_queue_claimable', async () => {
    await seedMixed(200, 20);
    const client = await testDb().connect();
    try {
      await client.query('ANALYZE message_queue');
      // enable_seqscan=off is the strongest possible hint: if the planner STILL
      // refuses the partial index, it is because it cannot prove the predicate.
      await client.query('SET enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) ${CLAIM_SQL}`,
        [new Date(NOW), 50, 'w'],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      // The hypothesis was that Postgres could not prove `scheduled_at <= $1`
      // implies `scheduled_at < 'infinity'` for an unknown $1, and would therefore
      // refuse the partial index. It can, because node-postgres sends parameter
      // values with the plan request, so the planner gets a CUSTOM plan with $1
      // substituted and the implication becomes trivial. The one way to lose this
      // is a NAMED prepared statement re-executed enough times for Postgres to
      // switch to a generic plan; this codebase never names a statement.
      expect(plan, `plan was:\n${plan}`).toContain('message_queue_claimable');
      expect(plan).toContain('Bitmap Index Scan on message_queue_claimable');
    } finally {
      client.release();
    }
  });
});

describe('H6 — the sentinel has no counterpart for deferred rows', () => {
  it('OBSERVED: expire-anchors only sweeps infinity rows, so a far-future deferral never expires', async () => {
    const seeded = await seedMixed(0, 1);
    // A frequency-cap deferral pushes scheduled_at to now + 24h; nothing stops a
    // gate from pushing it further, and nothing ever collects it.
    await testDb().query(
      `UPDATE message_queue SET scheduled_at = '2030-01-01T00:00:00Z', deferrals = 99`,
    );

    // This is verbatim the expire-anchors job predicate.
    const { rowCount } = await testDb().query(
      `UPDATE message_queue
          SET status = 'cancelled', provider_error_code = 'delivery_anchor_expired'
        WHERE status = 'pending' AND scheduled_at = 'infinity' AND created_at < now()`,
    );
    expect(rowCount, 'the sweep does not see it').toBe(0);

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue
        WHERE status = 'pending' AND scheduled_at > now() + interval '1 year'`,
    );
    expect(Number(rows[0]!.n), 'still pending, scheduled four years out').toBe(1);
    expect(seeded.tenantId).toBeTruthy();
  });
});
