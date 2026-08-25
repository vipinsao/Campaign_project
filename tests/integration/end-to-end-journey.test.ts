/**
 * The whole pipeline, end to end.
 *
 * An order is delivered, a trigger fires, an audience is evaluated, an enrolment is
 * created, messages are rendered and queued against the recipient's local quiet
 * hours, a worker claims them, the gate chain runs again at send time, and the
 * provider is called. Every step leaves a decision row behind.
 *
 * This is the test that answers "does it actually work", as opposed to "does each
 * piece work in isolation". The invariant suites prove the guarantees; this proves
 * the parts are wired to each other.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedTenant, seedContact, seedCampaign, seedCampaignMessage, optIn } from '../support/fixtures.ts';
import { harness } from '../support/delivery.ts';
import {
  evaluateTrigger,
  processQueue,
  runTimeTriggers,
  evaluateStopConditions,
  resolveByOrderNumber,
  FakeClock,
} from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

const BASE_URL = 'https://demo.example.com';

async function seedStore(tenantId: string, code: string) {
  const { rows } = await testDb().query<{ id: string }>(
    `INSERT INTO stores (tenant_id, name, code) VALUES ($1,$2,$3) RETURNING id`,
    [tenantId, `Store ${code}`, code],
  );
  return rows[0]!.id;
}

async function seedOrder(
  tenantId: string,
  storeId: string,
  contactId: string,
  opts: { number: string; delivered?: string; placed?: string },
) {
  const { rows } = await testDb().query<{ id: string }>(
    `INSERT INTO orders (tenant_id, store_id, contact_id, order_number, status, total,
                         placed_at, shipped_at, delivered_at)
     VALUES ($1,$2,$3,$4,$5,49.99,$6::timestamptz,$6::timestamptz,$7::timestamptz)
     RETURNING id`,
    [
      tenantId,
      storeId,
      contactId,
      opts.number,
      opts.delivered ? 'delivered' : 'placed',
      opts.placed ?? '2026-06-10T09:00:00Z',
      opts.delivered ?? null,
    ],
  );
  return rows[0]!.id;
}

describe('a post-purchase journey, from delivery to send', () => {
  it('enrols, queues, gates and sends', async () => {
    const db = testDb();
    const clock = new FakeClock('2026-06-15T10:00:00Z');

    const tenantId = await seedTenant(db, { timezone: 'UTC', quietStart: '08:00', quietEnd: '21:00' });
    const storeId = await seedStore(tenantId, 'main');
    const contactId = await seedContact(db, tenantId, {
      email: 'jane@example.com',
      timezone: 'Europe/London',
    });
    await optIn(db, tenantId, contactId, 'email');

    const { campaignId, versionId } = await seedCampaign(db, tenantId, {
      name: 'Post-purchase review request',
      category: 'lifecycle',
      triggerType: 'order_delivered',
      status: 'active',
    });
    await seedCampaignMessage(db, tenantId, campaignId, {
      channel: 'email',
      sequenceOrder: 1,
      subject: 'How was your order {{order.number}}?',
      body: 'Hi {{contact.first_name}}, how did we do? {{unsubscribe_url}}',
    });
    expect(versionId).toBeTruthy();

    const orderId = await seedOrder(tenantId, storeId, contactId, {
      number: 'ORD-5001',
      delivered: '2026-06-14T12:00:00Z',
    });

    // ── the trigger ──────────────────────────────────────────────────────────
    const outcome = await evaluateTrigger(
      { db, clock, publicBaseUrl: BASE_URL },
      { type: 'order_delivered', tenantId, orderId },
    );

    expect(outcome.campaignsConsidered).toBe(1);
    expect(outcome.enrolled).toBe(1);
    expect(outcome.queued).toBe(1);

    // The message was rendered at enqueue time, with real values only.
    const { rows: queuedRows } = await db.query<{
      rendered_subject: string;
      rendered_body: string;
      status: string;
      recipient_address: string;
    }>(`SELECT rendered_subject, rendered_body, status, recipient_address FROM message_queue`);

    expect(queuedRows).toHaveLength(1);
    expect(queuedRows[0]!.rendered_subject).toBe('How was your order ORD-5001?');
    expect(queuedRows[0]!.rendered_body).toContain(`${BASE_URL}/u/`);
    expect(queuedRows[0]!.recipient_address).toBe('jane@example.com');

    // ── the worker ───────────────────────────────────────────────────────────
    const { deps, provider } = harness({ now: '2026-06-15T10:00:00Z' });
    const summary = await processQueue(deps);

    expect(summary.claimed).toBe(1);
    expect(summary.sent).toBe(1);
    expect(provider.sent[0]!.to).toBe('jane@example.com');
    expect(provider.sent[0]!.subject).toBe('How was your order ORD-5001?');

    // Sent, not delivered (I9).
    const { rows: after } = await db.query<{ status: string; delivered_at: Date | null }>(
      `SELECT status, delivered_at FROM message_queue`,
    );
    expect(after[0]!.status).toBe('sent');
    expect(after[0]!.delivered_at).toBeNull();

    // ── the audit trail (I14) ────────────────────────────────────────────────
    const { rows: decisions } = await db.query<{ stage: string; reason_code: string }>(
      `SELECT stage, reason_code FROM send_decisions ORDER BY id`,
    );
    expect(decisions.map((d) => `${d.stage}:${d.reason_code}`)).toEqual([
      'schedule:enqueued',
      'send:sent',
    ]);
  });

  it('is idempotent when the same delivery webhook arrives twice', async () => {
    const db = testDb();
    const clock = new FakeClock('2026-06-15T10:00:00Z');
    const tenantId = await seedTenant(db, { quietStart: '00:00', quietEnd: '23:59' });
    const storeId = await seedStore(tenantId, 'main');
    const contactId = await seedContact(db, tenantId, { email: 'dupe@example.com' });
    await optIn(db, tenantId, contactId);
    const { campaignId } = await seedCampaign(db, tenantId, {
      triggerType: 'order_delivered',
      status: 'active',
    });
    await seedCampaignMessage(db, tenantId, campaignId, {
      body: 'Thanks. {{unsubscribe_url}}',
    });
    const orderId = await seedOrder(tenantId, storeId, contactId, {
      number: 'ORD-5002',
      delivered: '2026-06-14T12:00:00Z',
    });

    const deps = { db, clock, publicBaseUrl: BASE_URL };
    const first = await evaluateTrigger(deps, { type: 'order_delivered', tenantId, orderId });
    const second = await evaluateTrigger(deps, { type: 'order_delivered', tenantId, orderId });

    expect(first.enrolled).toBe(1);
    expect(second.enrolled, 'a redelivered webhook must not double-enrol').toBe(0);
    expect(second.skipped[0]?.reason).toBe('already_enrolled');

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('gives a customer who orders twice two separate journeys', async () => {
    // The anchor is part of the dedup key precisely so this works.
    const db = testDb();
    const clock = new FakeClock('2026-06-15T10:00:00Z');
    const tenantId = await seedTenant(db, { quietStart: '00:00', quietEnd: '23:59' });
    const storeId = await seedStore(tenantId, 'main');
    const contactId = await seedContact(db, tenantId, { email: 'repeat@example.com' });
    await optIn(db, tenantId, contactId);
    const { campaignId } = await seedCampaign(db, tenantId, {
      triggerType: 'order_delivered',
      status: 'active',
    });
    await seedCampaignMessage(db, tenantId, campaignId, { body: 'Thanks. {{unsubscribe_url}}' });

    const orderA = await seedOrder(tenantId, storeId, contactId, {
      number: 'ORD-A',
      delivered: '2026-06-12T12:00:00Z',
    });
    const orderB = await seedOrder(tenantId, storeId, contactId, {
      number: 'ORD-B',
      delivered: '2026-06-14T12:00:00Z',
    });

    const deps = { db, clock, publicBaseUrl: BASE_URL };
    await evaluateTrigger(deps, { type: 'order_delivered', tenantId, orderId: orderA });
    await evaluateTrigger(deps, { type: 'order_delivered', tenantId, orderId: orderB });

    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM message_queue`);
    expect(Number(rows[0]!.n), 'the second order must get its own message').toBe(2);
  });

  it('logs but queues nothing while a campaign is in observe mode', async () => {
    const db = testDb();
    const clock = new FakeClock('2026-06-15T10:00:00Z');
    const tenantId = await seedTenant(db, { quietStart: '00:00', quietEnd: '23:59' });
    const storeId = await seedStore(tenantId, 'main');
    const contactId = await seedContact(db, tenantId, { email: 'observed@example.com' });
    await optIn(db, tenantId, contactId);
    const { campaignId } = await seedCampaign(db, tenantId, {
      triggerType: 'order_delivered',
      status: 'observe',
    });
    await seedCampaignMessage(db, tenantId, campaignId, { body: 'Hi. {{unsubscribe_url}}' });
    const orderId = await seedOrder(tenantId, storeId, contactId, {
      number: 'ORD-OBS',
      delivered: '2026-06-14T12:00:00Z',
    });

    const outcome = await evaluateTrigger(
      { db, clock, publicBaseUrl: BASE_URL },
      { type: 'order_delivered', tenantId, orderId },
    );

    expect(outcome.enrolled).toBe(0);
    expect(outcome.queued).toBe(0);

    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM message_queue`);
    expect(Number(rows[0]!.n)).toBe(0);

    // But the decision log knows exactly who WOULD have been mailed. This is the
    // cheapest insurance in the system: ship a campaign in observe for a day and
    // read this before anyone is contacted.
    const { rows: decisions } = await db.query<{ reason_code: string; inputs: { wouldEnrol: boolean } }>(
      `SELECT reason_code, inputs FROM send_decisions`,
    );
    expect(decisions[0]!.reason_code).toBe('observe_mode_no_enqueue');
    expect(decisions[0]!.inputs.wouldEnrol).toBe(true);
  });

  it('records an audience mismatch with the rule that failed', async () => {
    const db = testDb();
    const clock = new FakeClock('2026-06-15T10:00:00Z');
    const tenantId = await seedTenant(db, { quietStart: '00:00', quietEnd: '23:59' });
    const storeId = await seedStore(tenantId, 'main');
    const contactId = await seedContact(db, tenantId, { email: 'nomatch@example.com', tags: [] });
    await optIn(db, tenantId, contactId);
    const { campaignId } = await seedCampaign(db, tenantId, {
      triggerType: 'order_delivered',
      status: 'active',
    });
    await db.query(`UPDATE campaigns SET audience = $2 WHERE id = $1`, [
      campaignId,
      JSON.stringify({ all: [{ field: 'tags', op: 'contains', value: 'vip' }] }),
    ]);
    await seedCampaignMessage(db, tenantId, campaignId, { body: 'Hi. {{unsubscribe_url}}' });
    const orderId = await seedOrder(tenantId, storeId, contactId, {
      number: 'ORD-NM',
      delivered: '2026-06-14T12:00:00Z',
    });

    const outcome = await evaluateTrigger(
      { db, clock, publicBaseUrl: BASE_URL },
      { type: 'order_delivered', tenantId, orderId },
    );
    expect(outcome.enrolled).toBe(0);
    expect(outcome.skipped[0]?.reason).toBe('audience_mismatch');

    const { rows } = await db.query<{ reason_detail: string }>(
      `SELECT reason_detail FROM send_decisions WHERE reason_code = 'audience_mismatch'`,
    );
    // The operator gets the failing rule, not just "did not match".
    expect(rows[0]!.reason_detail.length).toBeGreaterThan(5);
  });
});

describe('time triggers fail closed', () => {
  async function setupWinback(lastOrderAt: string) {
    const db = testDb();
    const tenantId = await seedTenant(db, { quietStart: '00:00', quietEnd: '23:59' });
    const contactId = await seedContact(db, tenantId, { email: 'lapsed@example.com' });
    await optIn(db, tenantId, contactId);
    await db.query(`UPDATE contacts SET last_order_at = $2, order_count = 1 WHERE id = $1`, [
      contactId,
      lastOrderAt,
    ]);
    const { campaignId } = await seedCampaign(db, tenantId, {
      triggerType: 'days_since_last_order',
      status: 'active',
    });
    await db.query(`UPDATE campaigns SET trigger_config = '{"days":60}'::jsonb WHERE id = $1`, [
      campaignId,
    ]);
    await seedCampaignMessage(db, tenantId, campaignId, {
      body: 'We miss you. {{unsubscribe_url}}',
    });
    return { tenantId, contactId, campaignId };
  }

  it('does NOTHING when the cutoff floor is unset', async () => {
    // An unset floor is an unconfigured system, not an unrestricted one. This is
    // what stops a first deploy from mailing four years of order history.
    await setupWinback('2026-01-01T00:00:00Z');
    const clock = new FakeClock('2026-06-15T10:00:00Z');

    const run = await runTimeTriggers({
      db: testDb(),
      clock,
      publicBaseUrl: BASE_URL,
      triggerFloorAt: null,
      maxEnrolmentsPerRun: 100,
    });

    expect(run.refused).toBe('no_floor');
    expect(run.enrolled).toBe(0);

    const { rows } = await testDb().query<{ reason_code: string }>(
      `SELECT reason_code FROM send_decisions`,
    );
    expect(rows[0]!.reason_code).toBe('trigger_floor_not_set');
  });

  it('enrols a lapsed contact once a floor is configured', async () => {
    await setupWinback('2026-01-01T00:00:00Z');
    const clock = new FakeClock('2026-06-15T10:00:00Z');

    const run = await runTimeTriggers({
      db: testDb(),
      clock,
      publicBaseUrl: BASE_URL,
      triggerFloorAt: new Date('2025-12-01T00:00:00Z'),
      maxEnrolmentsPerRun: 100,
    });

    expect(run.refused).toBeNull();
    expect(run.enrolled).toBe(1);
    expect(run.queued).toBe(1);
  });

  it('excludes anyone whose anchor predates the floor', async () => {
    // The four-year-old order that must never be mailed about.
    await setupWinback('2022-03-01T00:00:00Z');
    const clock = new FakeClock('2026-06-15T10:00:00Z');

    const run = await runTimeTriggers({
      db: testDb(),
      clock,
      publicBaseUrl: BASE_URL,
      triggerFloorAt: new Date('2025-12-01T00:00:00Z'),
      maxEnrolmentsPerRun: 100,
    });

    expect(run.candidates).toBe(0);
    expect(run.enrolled).toBe(0);
  });

  it('enrols NOBODY when the circuit breaker trips', async () => {
    // Partially enrolling the first N would be worse than doing nothing: it
    // produces a send nobody authorised and leaves the rest in an unknown state.
    const db = testDb();
    const { tenantId, campaignId } = await setupWinback('2026-01-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      const id = await seedContact(db, tenantId, { email: `lapsed${i}@example.com` });
      await optIn(db, tenantId, id);
      await db.query(`UPDATE contacts SET last_order_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [id]);
    }
    expect(campaignId).toBeTruthy();

    const run = await runTimeTriggers({
      db,
      clock: new FakeClock('2026-06-15T10:00:00Z'),
      publicBaseUrl: BASE_URL,
      triggerFloorAt: new Date('2025-12-01T00:00:00Z'),
      maxEnrolmentsPerRun: 3,
    });

    expect(run.refused).toBe('circuit_breaker');
    expect(run.enrolled).toBe(0);

    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM message_queue`);
    expect(Number(rows[0]!.n), 'nobody at all should have been queued').toBe(0);

    const { rows: decision } = await db.query<{ inputs: { candidateCount: number } }>(
      `SELECT inputs FROM send_decisions WHERE reason_code = 'trigger_circuit_breaker'`,
    );
    expect(decision[0]!.inputs.candidateCount).toBe(6);
  });

  it('evaluates everything and queues nothing in dry run', async () => {
    await setupWinback('2026-01-01T00:00:00Z');
    const run = await runTimeTriggers({
      db: testDb(),
      clock: new FakeClock('2026-06-15T10:00:00Z'),
      publicBaseUrl: BASE_URL,
      triggerFloorAt: new Date('2025-12-01T00:00:00Z'),
      maxEnrolmentsPerRun: 100,
      dryRun: true,
    });

    expect(run.enrolled).toBe(0);
    const { rows } = await testDb().query<{ reason_code: string }>(
      `SELECT reason_code FROM send_decisions WHERE reason_code = 'trigger_dry_run'`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('stop conditions cancel what is still queued', () => {
  it('ends the journey and cancels the remaining messages', async () => {
    const db = testDb();
    const clock = new FakeClock('2026-06-15T10:00:00Z');
    const tenantId = await seedTenant(db, { quietStart: '00:00', quietEnd: '23:59' });
    const storeId = await seedStore(tenantId, 'main');
    const contactId = await seedContact(db, tenantId, { email: 'replier@example.com' });
    await optIn(db, tenantId, contactId);

    const { campaignId } = await seedCampaign(db, tenantId, {
      triggerType: 'order_delivered',
      status: 'active',
    });
    await seedCampaignMessage(db, tenantId, campaignId, {
      sequenceOrder: 1,
      body: 'First. {{unsubscribe_url}}',
    });
    await seedCampaignMessage(db, tenantId, campaignId, {
      sequenceOrder: 2,
      body: 'Second. {{unsubscribe_url}}',
    });
    await db.query(
      `INSERT INTO campaign_stop_conditions (tenant_id, campaign_id, condition_type)
       VALUES ($1,$2,'replied')`,
      [tenantId, campaignId],
    );

    const orderId = await seedOrder(tenantId, storeId, contactId, {
      number: 'ORD-STOP',
      delivered: '2026-06-14T12:00:00Z',
    });
    await evaluateTrigger({ db, clock, publicBaseUrl: BASE_URL }, {
      type: 'order_delivered',
      tenantId,
      orderId,
    });

    // The customer replies.
    await db.query(
      `INSERT INTO message_events (tenant_id, campaign_id, contact_id, event_type, channel,
                                   occurred_at, idempotency_key)
       VALUES ($1,$2,$3,'replied','email',$4,'reply-1')`,
      [tenantId, campaignId, contactId, clock.now()],
    );

    const result = await evaluateStopConditions({ db, clock });
    expect(result.stopped).toBe(1);
    expect(result.cancelled).toBe(2);

    const { rows } = await db.query<{ status: string }>(`SELECT status FROM message_queue`);
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);

    // And running the worker afterwards sends nothing.
    const { provider } = harness();
    const { deps } = harness();
    await processQueue(deps);
    expect(provider.sent).toHaveLength(0);
  });
});

describe('I13 — resolving a recipient from an order number', () => {
  it('returns none, single and ambiguous correctly', async () => {
    const db = testDb();
    const tenantId = await seedTenant(db);
    const storeA = await seedStore(tenantId, 'a');
    const storeB = await seedStore(tenantId, 'b');
    const alice = await seedContact(db, tenantId, { email: 'alice@example.com' });
    const bob = await seedContact(db, tenantId, { email: 'bob@example.com' });

    expect(await resolveByOrderNumber(db, { tenantId, orderNumber: 'NOPE' })).toEqual({
      kind: 'none',
    });

    await seedOrder(tenantId, storeA, alice, { number: 'ORD-1000' });
    const single = await resolveByOrderNumber(db, { tenantId, orderNumber: 'ORD-1000' });
    expect(single.kind).toBe('single');

    // The same order number in a different store, belonging to a DIFFERENT person.
    await seedOrder(tenantId, storeB, bob, { number: 'ORD-1000' });
    const ambiguous = await resolveByOrderNumber(db, { tenantId, orderNumber: 'ORD-1000' });

    expect(ambiguous.kind, 'two stores can share an order number; this must not resolve').toBe(
      'ambiguous',
    );
    if (ambiguous.kind !== 'ambiguous') return;
    expect(ambiguous.candidates).toHaveLength(2);
    expect(new Set(ambiguous.candidates.map((c) => c.contactId))).toEqual(new Set([alice, bob]));

    // Naming the store disambiguates it.
    const scoped = await resolveByOrderNumber(db, {
      tenantId,
      orderNumber: 'ORD-1000',
      storeId: storeB,
    });
    expect(scoped.kind).toBe('single');
    if (scoped.kind !== 'single') return;
    expect(scoped.match.contactId).toBe(bob);
  });
});
