/**
 * I2 — The environment guard runs BEFORE the queue row is claimed.
 *
 * Failure it prevents — and this one is worth reading slowly, because it survived
 * in a real production system for months:
 *
 *   A non-production worker is pointed at a production database. The environment
 *   guard is inside the send function rather than before the claim. So the worker
 *   claims a row, increments `attempts`, declines to send, and releases it. Three
 *   passes later the message is permanently failed — a message production itself
 *   would have sent perfectly well.
 *
 *   It is invisible in production, because production never refuses. The guard
 *   looks correct in the only environment where anyone is watching.
 *
 * The lesson generalises: the POSITION of a guard relative to a state transition
 * is part of its correctness. That is what this test pins down.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { harness, queueOne, queueRow } from '../support/delivery.ts';
import { processQueue, liveSendAllowed } from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

describe('I2 — a worker that may not send never claims a row', () => {
  it('does not increment attempts when SEND_MODE is off', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded);

    const { deps, provider } = harness({ sendMode: 'off' });
    const summary = await processQueue(deps);

    expect(summary.refusedWithoutClaim).toBe(true);
    expect(summary.claimed).toBe(0);
    expect(provider.sent).toHaveLength(0);

    const row = await queueRow(id);
    // The whole invariant, in one assertion. A refusal must cost the message nothing.
    expect(row.attempts, 'a refusal must not consume a delivery attempt').toBe(0);
    expect(row.status).toBe('pending');
    expect(row.deferrals).toBe(0);
  });

  it('leaves the row claimable by a worker that IS permitted to send', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded);

    await processQueue(harness({ sendMode: 'off' }).deps);
    expect((await queueRow(id)).status).toBe('pending');

    const { deps, provider } = harness({ sendMode: 'mock' });
    const summary = await processQueue(deps);

    expect(summary.claimed).toBe(1);
    expect(summary.sent).toBe(1);
    expect(provider.sent).toHaveLength(1);
    expect((await queueRow(id)).attempts).toBe(1);
  });

  it('refuses repeatedly without ever exhausting the message', async () => {
    // The realistic shape of the bug: a misconfigured worker polling every minute.
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded);

    const { deps } = harness({ sendMode: 'off' });
    for (let i = 0; i < 10; i++) await processQueue(deps);

    const row = await queueRow(id);
    expect(row.attempts, 'ten refusals should still cost nothing').toBe(0);
    expect(row.status).toBe('pending');
  });

  it('treats only off as not-permitted; mock and live may both send', () => {
    expect(liveSendAllowed('off')).toBe(false);
    expect(liveSendAllowed('mock')).toBe(true);
    expect(liveSendAllowed('live')).toBe(true);
  });
});
