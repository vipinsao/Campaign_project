/**
 * I6 — Consent is an append-only ledger, suppression is address-level, and an
 *      opt-out cancels messages ALREADY SITTING IN THE QUEUE.
 *
 * Failure it prevents: a customer says stop, and then receives the three messages
 * that were already queued. They have, correctly, not been listened to — and
 * "the opt-out worked, those were sent before it" is not a defence anyone outside
 * engineering accepts.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { harness, queueOne, queueRow } from '../support/delivery.ts';
import { processQueue, optOut, consentState, FakeClock, withTransaction } from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

describe('I6 — opting out cancels what is already queued', () => {
  it('cancels all five queued messages and sends none of them', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await queueOne(seeded, { anchorId: `0000000${i}-0000-4000-8000-000000000000` }));
    }

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    await withTransaction(testDb(), (tx) =>
      optOut(tx, {
        tenantId: seeded.tenantId,
        contactId: seeded.contactId,
        channel: 'email',
        address: 'recipient@example.com',
        source: 'unsubscribe_link',
        reason: 'unsubscribe',
        clock,
      }),
    );

    for (const id of ids) {
      expect((await queueRow(id)).status, `queued message ${id} should be cancelled`).toBe(
        'cancelled',
      );
    }

    // And running the worker immediately afterwards must still send nothing.
    const { deps, provider } = harness();
    const summary = await processQueue(deps);
    expect(provider.sent).toHaveLength(0);
    expect(summary.sent).toBe(0);
  });

  it('blocks a message queued AFTER the opt-out at the send-time gate too', async () => {
    // Cancelling the queue is not sufficient on its own: something has to stop the
    // next enqueue as well, and that something is the gate, at send time (I1).
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    await withTransaction(testDb(), (tx) =>
      optOut(tx, {
        tenantId: seeded.tenantId,
        contactId: seeded.contactId,
        channel: 'email',
        address: 'recipient@example.com',
        source: 'sms_stop',
        reason: 'unsubscribe',
        clock,
      }),
    );

    const id = await queueOne(seeded);
    const { deps, provider } = harness();
    await processQueue(deps);

    expect(provider.sent).toHaveLength(0);
    const row = await queueRow(id);
    expect(row.status).toBe('cancelled');

    // The reason recorded is 'consent_opted_out', not 'suppressed_unsubscribe',
    // and that is the gate ORDER showing through: consentCurrent runs before
    // notSuppressed, so the ledger answers first. Both facts are true here — the
    // contact opted out AND the address is suppressed — but the decision log
    // should report the person's own recorded intent rather than the derived
    // cache entry, because that is the answer an operator actually needs.
    expect(row.provider_error_code).toBe('consent_opted_out');
  });

  it('keeps the full consent history rather than overwriting a flag', async () => {
    const seeded = await seedAll();
    const db = testDb();

    // out -> in -> out, with explicit timestamps so the sequence is unambiguous.
    // A boolean column would retain only the last of these.
    await optIn(db, seeded.tenantId, seeded.contactId);
    await db.query(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source, occurred_at)
       VALUES ($1,$2,'email','opted_out','unsubscribe_link', $3)`,
      [seeded.tenantId, seeded.contactId, '2026-02-01T00:00:00Z'],
    );
    await db.query(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source, occurred_at)
       VALUES ($1,$2,'email','opted_in','preference_center', $3)`,
      [seeded.tenantId, seeded.contactId, '2026-03-01T00:00:00Z'],
    );
    await db.query(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source, occurred_at)
       VALUES ($1,$2,'email','opted_out','sms_stop', $3)`,
      [seeded.tenantId, seeded.contactId, '2026-04-01T00:00:00Z'],
    );

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM contact_consents WHERE contact_id = $1`,
      [seeded.contactId],
    );
    expect(Number(rows[0]!.n), 'every state change is retained').toBe(4);

    // Current state resolves to the most recent intent.
    expect(
      await consentState(db, {
        tenantId: seeded.tenantId,
        contactId: seeded.contactId,
        channel: 'email',
        category: 'lifecycle',
      }),
    ).toBe('opted_out');

    // And the question a boolean cannot answer: what was true on 15 March?
    const { rows: asOf } = await db.query<{ state: string }>(
      `SELECT state FROM contact_consents
        WHERE contact_id = $1 AND occurred_at <= $2
        ORDER BY occurred_at DESC LIMIT 1`,
      [seeded.contactId, '2026-03-15T00:00:00Z'],
    );
    expect(asOf[0]!.state, 'the ledger can answer "were they opted in on 15 March?"').toBe(
      'opted_in',
    );
  });

  it('records a category-scoped opt-out WITHOUT suppressing the whole address', async () => {
    // "Drop one category" must not become "never contact this person again".
    const seeded = await seedAll();
    const db = testDb();
    await optIn(db, seeded.tenantId, seeded.contactId);
    const clock = new FakeClock('2026-06-15T12:00:00Z');

    await withTransaction(db, (tx) =>
      optOut(tx, {
        tenantId: seeded.tenantId,
        contactId: seeded.contactId,
        channel: 'email',
        address: 'recipient@example.com',
        category: 'promotional',
        source: 'preference_center',
        reason: 'unsubscribe',
        clock,
      }),
    );

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM suppressions WHERE tenant_id = $1`,
      [seeded.tenantId],
    );
    expect(Number(rows[0]!.n), 'a category opt-out must not suppress the address').toBe(0);

    expect(
      await consentState(db, {
        tenantId: seeded.tenantId,
        contactId: seeded.contactId,
        channel: 'email',
        category: 'promotional',
      }),
    ).toBe('opted_out');
    expect(
      await consentState(db, {
        tenantId: seeded.tenantId,
        contactId: seeded.contactId,
        channel: 'email',
        category: 'lifecycle',
      }),
    ).toBe('opted_in');
  });
});
