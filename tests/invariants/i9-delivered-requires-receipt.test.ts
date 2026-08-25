/**
 * I9 — `delivered` is written ONLY by a provider receipt. It is never inferred
 *      from a successful send.
 *
 * Failure it prevents: a delivery-rate metric that reads 100% forever, because the
 * code marks the row delivered on the line after it marks it sent. The number looks
 * healthy, is reported to people who make decisions with it, and means nothing.
 *
 * Absent a receipt the state stays `sent`, and the UI renders "awaiting receipt" —
 * which is the honest answer and is more useful than a confident wrong one.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { harness, queueOne, queueRow } from '../support/delivery.ts';
import { processQueue } from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

describe('I9 — delivery is a fact only the provider can report', () => {
  it('leaves a successfully-sent message at sent, not delivered', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded);

    const { deps, provider } = harness();
    await processQueue(deps);

    expect(provider.sent).toHaveLength(1);
    const row = await queueRow(id);
    expect(row.status, 'a successful send is "sent"; delivery has not been confirmed').toBe('sent');
    expect(row.sent_at).not.toBeNull();
    expect(row.delivered_at, 'delivered_at must stay null until a receipt arrives').toBeNull();
  });

  it('refuses at the database level to record a delivery that was never sent', async () => {
    const seeded = await seedAll();
    const id = await queueOne(seeded);

    // Even a direct write cannot fabricate a receipt for an unsent message.
    await expect(
      testDb().query(`UPDATE message_queue SET delivered_at = now() WHERE id = $1`, [id]),
    ).rejects.toThrow(/message_queue_delivered_implies_sent/);
  });

  it('refuses a delivery timestamp that precedes the send', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded);
    await processQueue(harness().deps);

    await expect(
      testDb().query(
        `UPDATE message_queue SET delivered_at = sent_at - interval '1 hour' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/message_queue_delivered_implies_sent/);
  });

  it('accepts delivered once a receipt supplies it', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded);
    await processQueue(harness().deps);

    // What the webhook handler does when the provider confirms.
    await testDb().query(
      `UPDATE message_queue SET status='delivered', delivered_at = sent_at + interval '4 seconds'
        WHERE id = $1`,
      [id],
    );
    const row = await queueRow(id);
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).not.toBeNull();
  });

  it('has no code path that sets delivered alongside sent', async () => {
    // Static backstop: markSent must not touch delivered_at.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../../packages/core/src/queue/message-queue.ts', import.meta.url),
      'utf8',
    );
    const markSentBody = src.slice(
      src.indexOf('export async function markSent'),
      src.indexOf('export async function markFailed'),
    );
    expect(
      markSentBody.includes('delivered_at'),
      'markSent must never write delivered_at — that is what inferring delivery looks like',
    ).toBe(false);
  });
});
