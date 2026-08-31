/**
 * QA — adversarial review of the transactional exemption and of `optOut`
 * (hypotheses 3 and 4).
 *
 * Two separate attacks:
 *
 *  3. `consentCurrent` returns pass immediately for `transactional`. What does that
 *     let through, and what is the operator-facing cost of a single column value?
 *     The exemption is INTENDED (D5); the tests below characterise its extent so
 *     that extent cannot drift unnoticed.
 *
 *  4. `optOut` used to cancel the queue by (tenant, contact, channel) with no
 *     category predicate at all — including on the `category: null` path the live
 *     preference centre uses — so unsubscribing from marketing killed the order
 *     receipt already queued for you. Fixed (D23): transactional messages are never
 *     cancelled by an opt-out, and a category-scoped opt-out cancels only its own
 *     category. Those tests are now the regression guards.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import {
  seedAll,
  seedCampaign,
  seedCampaignMessage,
  seedEnrollment,
  optIn,
} from '../support/fixtures.ts';
import { harness, queueOne, queueRow } from '../support/delivery.ts';
import {
  processQueue,
  optOut,
  addSuppression,
  FakeClock,
  withTransaction,
  validateTemplate,
  isQuietHoursExempt,
} from '@campaign/core';
import type { Seeded } from '../support/fixtures.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

/** A second campaign on the same tenant/contact, in a different category. */
async function addCampaign(
  seeded: Seeded,
  category: string,
  opts: { windowStart?: string | null; windowEnd?: string | null } = {},
): Promise<Seeded> {
  const db = testDb();
  const { campaignId, versionId } = await seedCampaign(db, seeded.tenantId, {
    name: `${category} campaign`,
    category,
    windowStart: opts.windowStart ?? null,
    windowEnd: opts.windowEnd ?? null,
  });
  const messageId = await seedCampaignMessage(db, seeded.tenantId, campaignId, {
    body: 'Your order #1001 has shipped.',
  });
  const enrollmentId = await seedEnrollment(
    db,
    seeded.tenantId,
    campaignId,
    versionId,
    seeded.contactId,
  );
  return {
    ...seeded,
    campaignId,
    campaignVersionId: versionId,
    campaignMessageId: messageId,
    enrollmentId,
  };
}

describe('QA/consent — the transactional exemption (hypothesis 3)', () => {
  it('SAFE: a hard-bounced address cannot receive a transactional message', async () => {
    // `notSuppressed` runs AFTER `consentCurrent`, so the transactional early
    // return does not skip it.
    const base = await seedAll();
    const txn = await addCampaign(base, 'transactional');
    await addSuppression(testDb(), {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: base.tenantId,
      channel: 'email',
      address: 'recipient@example.com',
      reason: 'hard_bounce',
    });
    const id = await queueOne(txn);

    const { deps, provider } = harness();
    await processQueue(deps);

    expect(provider.sent).toHaveLength(0);
    const row = await queueRow(id);
    expect(row.status).toBe('cancelled');
    expect(row.provider_error_code).toBe('suppressed_hard_bounce');
  });

  it('CHARACTERISATION: a fully opted-out contact DOES receive a transactional message', async () => {
    const base = await seedAll();
    const txn = await addCampaign(base, 'transactional');
    await testDb().query(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source, occurred_at)
       VALUES ($1,$2,'email','opted_out','unsubscribe_link','2026-01-01T00:00:00Z')`,
      [base.tenantId, base.contactId],
    );
    const id = await queueOne(txn);

    const { deps, provider } = harness();
    await processQueue(deps);

    expect(provider.sent, 'documented and intended: a receipt is not marketing').toHaveLength(1);
    expect((await queueRow(id)).status).toBe('sent');
  });

  it('CHARACTERISATION: an active consent pause is also bypassed by transactional', async () => {
    const base = await seedAll();
    const txn = await addCampaign(base, 'transactional');
    await optIn(testDb(), base.tenantId, base.contactId);
    await testDb().query(
      `INSERT INTO consent_pauses (tenant_id, contact_id, channel, period)
       VALUES ($1,$2,'email',tstzrange('2026-06-01T00:00:00Z','2026-07-01T00:00:00Z','[)'))`,
      [base.tenantId, base.contactId],
    );
    await queueOne(txn);

    const { deps, provider } = harness({ now: '2026-06-15T12:00:00Z' });
    await processQueue(deps);
    expect(provider.sent).toHaveLength(1);
  });

  it('CHARACTERISATION: `operational` is quiet-hours exempt but still consent-gated', async () => {
    // isQuietHoursExempt: transactional OR operational.
    // consentCurrent:     transactional only.
    // So an operational message is allowed at 03:00 but refused without an opt-in,
    // while a transactional message is allowed at 03:00 AND without an opt-in.
    expect(isQuietHoursExempt('operational')).toBe(true);

    const base = await seedAll(testDb(), { tenant: { quietStart: '08:00', quietEnd: '21:00' } });
    const ops = await addCampaign(base, 'operational');
    await testDb().query(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source, occurred_at)
       VALUES ($1,$2,'email','opted_out','unsubscribe_link','2026-01-01T00:00:00Z')`,
      [base.tenantId, base.contactId],
    );
    const id = await queueOne(ops, { scheduledAt: '2026-06-15T02:00:00Z' });

    const { deps, provider } = harness({ now: '2026-06-15T03:00:00Z' });
    await processQueue(deps);

    expect(provider.sent).toHaveLength(0);
    expect((await queueRow(id)).provider_error_code).toBe('consent_opted_out');
  });

  it('BLAST RADIUS: one column value turns any campaign into "mail anyone, any hour, no opt-out"', async () => {
    // CHARACTERISATION, not a bug report. The transactional exemption is a
    // deliberate decision (D5): a "your order is out for delivery" message at 21:30
    // is expected and wanted, a promotion at the same time is not, and that is the
    // distinction CAN-SPAM and TCPA also draw. Keying it on the category — a closed
    // set enforced by a database CHECK — means a campaign cannot quietly grant
    // itself the exemption.
    //
    // What this test records is the SIZE of the exemption, because all three
    // protections key off the same column, and nothing in review makes that
    // visible: setting one campaign's category to 'transactional' removes the
    // consent gate, the quiet-hours gate AND the unsubscribe-link requirement in
    // one edit. If that ever needs narrowing, this is the test that says what
    // "transactional" currently buys.
    expect(
      validateTemplate(
        { channel: 'email', subject: 'Half price this week', body: 'Buy now! No opt-out here.' },
        'transactional',
      ).errors,
      'a transactional template needs no unsubscribe link',
    ).toEqual([]);
    expect(isQuietHoursExempt('transactional')).toBe(true);

    const base = await seedAll(testDb(), { tenant: { quietStart: '08:00', quietEnd: '21:00' } });
    const txn = await addCampaign(base, 'transactional');
    await testDb().query(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source, occurred_at)
       VALUES ($1,$2,'email','opted_out','unsubscribe_link','2026-01-01T00:00:00Z')`,
      [base.tenantId, base.contactId],
    );
    await queueOne(txn, { scheduledAt: '2026-06-15T02:00:00Z' });

    const { deps, provider } = harness({ now: '2026-06-15T03:00:00Z' });
    await processQueue(deps);

    expect(
      provider.sent,
      'an opted-out contact is mailed at 03:00 local with no unsubscribe link, ' +
        'because one column says "transactional" — intended (D5), and this is its ' +
        'full extent',
    ).toHaveLength(1);
  });
});

describe('QA/consent — optOut cancels only the category it was given (D23)', () => {
  it('GUARD: a PROMOTIONAL opt-out does not cancel a queued TRANSACTIONAL message', async () => {
    const base = await seedAll();
    await optIn(testDb(), base.tenantId, base.contactId);
    const txn = await addCampaign(base, 'transactional');
    const promo = await addCampaign(base, 'promotional');

    const receiptId = await queueOne(txn);
    const promoId = await queueOne(promo);

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    await withTransaction(testDb(), (tx) =>
      optOut(tx, {
        tenantId: base.tenantId,
        contactId: base.contactId,
        channel: 'email',
        address: 'recipient@example.com',
        category: 'promotional',
        source: 'preference_center',
        reason: 'unsubscribe',
        clock,
      }),
    );

    expect((await queueRow(promoId)).status, 'the promotional message should go').toBe('cancelled');
    expect(
      (await queueRow(receiptId)).status,
      'the order receipt must survive an opt-out from promotional email',
    ).toBe('pending');
  });

  it('GUARD: the live preference centre "unsubscribe from all" does not cancel receipts', async () => {
    // packages/api/src/routes/public.ts calls optOut with category: null for the
    // `unsubscribe_all` action. The gate chain deliberately exempts transactional
    // from consent; the cancellation sweep does not, so the queued receipt dies
    // before the gate ever sees it.
    const base = await seedAll();
    await optIn(testDb(), base.tenantId, base.contactId);
    const txn = await addCampaign(base, 'transactional');
    const receiptId = await queueOne(txn);

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    await withTransaction(testDb(), (tx) =>
      optOut(tx, {
        tenantId: base.tenantId,
        contactId: base.contactId,
        channel: 'email',
        address: 'recipient@example.com',
        category: null,
        source: 'unsubscribe_link',
        reason: 'unsubscribe',
        clock,
      }),
    );

    expect(
      (await queueRow(receiptId)).status,
      'unsubscribing from marketing must not cancel a queued transactional message',
    ).toBe('pending');
  });

  it('GUARD: a category-scoped cancellation is recorded as consent_opted_out, not as a suppression', async () => {
    // `provider_error_code` is set to suppressionReasonCode(reason) even on the
    // category-scoped path that deliberately writes no suppression. The queue then
    // reports "suppressed_unsubscribe" for a row that was never suppressed.
    const base = await seedAll();
    await optIn(testDb(), base.tenantId, base.contactId);
    const promo = await addCampaign(base, 'promotional');
    const id = await queueOne(promo);

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    await withTransaction(testDb(), (tx) =>
      optOut(tx, {
        tenantId: base.tenantId,
        contactId: base.contactId,
        channel: 'email',
        address: 'recipient@example.com',
        category: 'promotional',
        source: 'preference_center',
        reason: 'unsubscribe',
        clock,
      }),
    );

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM suppressions WHERE tenant_id = $1`,
      [base.tenantId],
    );
    expect(Number(rows[0]!.n), 'confirmed: no suppression row was written').toBe(0);
    expect(
      (await queueRow(id)).provider_error_code,
      'the queue claims the address was suppressed when it was not',
    ).toBe('consent_opted_out');
  });
});
