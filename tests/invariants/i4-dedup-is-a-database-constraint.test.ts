/**
 * I4 — Deduplication is a UNIQUE index, and a conflicting insert is an idempotent
 *      no-op rather than an error.
 *
 * Failure it prevents: duplicate sends from concurrent triggers, webhook
 * redeliveries and retried API calls.
 *
 * Application-level "check whether it exists, then insert" is banned, and the
 * reason is visible in the concurrency test below: between the check and the
 * insert, every concurrent caller passes the check. Check-then-insert does not
 * remove duplicates, it makes them rare enough to be unreproducible.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedAll } from '../support/fixtures.ts';
import { enqueue } from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

async function base() {
  const db = testDb();
  const s = await seedAll(db);
  return {
    tenantId: s.tenantId,
    enrollmentId: s.enrollmentId,
    campaignId: s.campaignId,
    campaignVersionId: s.campaignVersionId,
    campaignMessageId: s.campaignMessageId,
    contactId: s.contactId,
    channel: 'email' as const,
    recipientAddress: 'dedupe@example.com',
    renderedBody: 'body',
    scheduledAt: new Date('2026-06-15T12:00:00Z'),
  };
}

describe('I4 — dedup is enforced by the database', () => {
  it('is an idempotent no-op on conflict, not an error', async () => {
    const input = await base();
    const first = await enqueue(testDb(), input);
    expect(first).toBeDefined();

    // The same logical message again. This must not throw, and must not insert.
    const second = await enqueue(testDb(), input);
    expect(second).toBeUndefined();

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('holds under concurrent enqueues of the same logical message', async () => {
    const input = await base();
    const url = process.env['DATABASE_URL']!;
    const pools = Array.from({ length: 8 }, () => new Pool({ connectionString: url, max: 2 }));

    try {
      const results = await Promise.all(pools.map((p) => enqueue(p, input)));
      const inserted = results.filter((r) => r !== undefined);

      expect(inserted, 'exactly one concurrent enqueue should win').toHaveLength(1);

      const { rows } = await testDb().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM message_queue`,
      );
      expect(Number(rows[0]!.n)).toBe(1);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('keys on the ANCHOR, so a second order gets its own journey', async () => {
    // Without the anchor in the key, a customer who orders twice has the second
    // order's messages silently swallowed by the first order's dedup key.
    const input = await base();
    const orderA = '11111111-1111-4111-8111-111111111111';
    const orderB = '22222222-2222-4222-8222-222222222222';

    const first = await enqueue(testDb(), { ...input, anchorId: orderA });
    const second = await enqueue(testDb(), { ...input, anchorId: orderB });
    const duplicateOfFirst = await enqueue(testDb(), { ...input, anchorId: orderA });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(duplicateOfFirst).toBeUndefined();

    expect(first!.dedupKey).toContain(orderA);
    expect(second!.dedupKey).toContain(orderB);
    expect(first!.dedupKey).not.toBe(second!.dedupKey);
  });

  it('computes the key in the database, so application code cannot get it wrong', async () => {
    const input = await base();
    const row = await enqueue(testDb(), { ...input, anchorId: null });
    expect(row!.dedupKey).toBe(
      `${input.campaignId}:${input.campaignMessageId}:${input.contactId}:none`,
    );

    // And it is not writable: an attempt to set it directly is rejected outright.
    await expect(
      testDb().query(
        `INSERT INTO message_queue
        (tenant_id, enrollment_id, campaign_id, campaign_version_id, campaign_message_id,
         contact_id, channel, recipient_address, rendered_body, scheduled_at, dedup_key)
        VALUES ($1,$2,$3,$4,$5,$6,'email','x@example.com','b',now(),'hand-written')`,
        [
          input.tenantId,
          input.enrollmentId,
          input.campaignId,
          input.campaignVersionId,
          input.campaignMessageId,
          input.contactId,
        ],
      ),
    ).rejects.toThrow(/non-DEFAULT value into column|generated/i);
  });
});
