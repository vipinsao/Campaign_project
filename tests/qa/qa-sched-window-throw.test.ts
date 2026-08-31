/**
 * QA — where does `effectiveWindow`'s throw actually land?  (hypothesis 8).
 *
 * The comment says the throw is "reachable only if a campaign window sits entirely
 * outside the tenant floor" and that "a CHECK constraint rejects an inverted
 * campaign window at write time". Both halves are true, and neither helps: the
 * CHECK is `send_window_start < send_window_end` WITHIN the campaign row. Nothing
 * in the schema, and nothing in the API, compares the campaign window to the
 * tenant's quiet-hours floor.
 *
 * So a perfectly legal pair of rows — tenant floor 08:00-21:00, campaign window
 * 22:00-23:00 — produces an unhandled throw. `runGates` does not catch. Neither
 * does `deliverClaimed`, nor `processQueue`. The nearest catch is `runJob`, which
 * records the failure and returns — so the worker process survives, and the entire
 * claimed batch is abandoned mid-flight with every remaining row stranded in
 * `processing`.
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
import { processQueue, scheduleMessages, FakeClock } from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

/** Tenant floor 08:00-21:00 with a campaign narrowed to 22:00-23:00. */
async function seedImpossibleWindow() {
  const db = testDb();
  const base = await seedAll(db, {
    tenant: { quietStart: '08:00', quietEnd: '21:00' },
    campaign: { windowStart: '22:00', windowEnd: '23:00' },
  });
  await optIn(db, base.tenantId, base.contactId);
  return base;
}

describe('QA/sched — the impossible window is a legal database state', () => {
  it('both CHECK constraints accept it: the campaign window is internally ordered', async () => {
    const base = await seedImpossibleWindow();
    const { rows } = await testDb().query<{ s: string; e: string; qs: string; qe: string }>(
      `SELECT to_char(c.send_window_start,'HH24:MI') s,
              to_char(c.send_window_end,'HH24:MI')   e,
              to_char(t.quiet_hours_start,'HH24:MI') qs,
              to_char(t.quiet_hours_end,'HH24:MI')   qe
         FROM campaigns c JOIN tenants t ON t.id = c.tenant_id
        WHERE c.id = $1`,
      [base.campaignId],
    );
    expect(rows[0]).toEqual({ s: '22:00', e: '23:00', qs: '08:00', qe: '21:00' });
  });
});

describe('QA/sched — the throw escapes the send path (BROKEN)', () => {
  it('FINDING: processQueue rejects instead of failing the message', async () => {
    const base = await seedImpossibleWindow();
    await queueOne(base, { scheduledAt: '2026-06-15T11:00:00Z' });

    const { deps } = harness({ now: '2026-06-15T12:00:00Z' });
    await expect(
      processQueue(deps),
      'a misconfigured campaign must fail its own message, not the queue run',
    ).resolves.toBeDefined();
  });

  it('FINDING: the message is left claimed, so a bad campaign burns attempts for ever', async () => {
    const base = await seedImpossibleWindow();
    const id = await queueOne(base, { scheduledAt: '2026-06-15T11:00:00Z' });

    const { deps } = harness({ now: '2026-06-15T12:00:00Z' });
    await processQueue(deps).catch(() => undefined);

    const row = await queueRow(id);
    expect(
      row.status,
      'the row is stuck in `processing` with an incremented attempt count, waiting ' +
        'for reclaim-stale to burn the next one',
    ).not.toBe('processing');
  });

  it('FINDING: one bad campaign strands every OTHER message claimed in the same batch', async () => {
    // This is the severity multiplier. `claimBatch` takes up to batchSize rows in
    // scheduled_at order; the throw aborts the loop, and every row after the bad
    // one is left `processing` having never been evaluated.
    const db = testDb();
    const base = await seedImpossibleWindow();

    // A second, perfectly healthy campaign for the same contact.
    const { campaignId, versionId } = await seedCampaign(db, base.tenantId, {
      name: 'Healthy',
      category: 'lifecycle',
    });
    const healthyMessageId = await seedCampaignMessage(db, base.tenantId, campaignId);
    const healthyEnrolment = await seedEnrollment(
      db,
      base.tenantId,
      campaignId,
      versionId,
      base.contactId,
    );

    // The broken campaign's row is claimed first.
    await queueOne(base, { scheduledAt: '2026-06-15T10:00:00Z' });
    const healthyId = await queueOne(
      {
        ...base,
        campaignId,
        campaignVersionId: versionId,
        campaignMessageId: healthyMessageId,
        enrollmentId: healthyEnrolment,
      },
      { scheduledAt: '2026-06-15T10:30:00Z' },
    );

    const { deps, provider } = harness({ now: '2026-06-15T12:00:00Z' });
    await processQueue(deps).catch(() => undefined);

    expect(
      provider.sent,
      'the healthy message was never evaluated: a config error in an unrelated ' +
        'campaign took the whole batch down',
    ).toHaveLength(1);
    expect((await queueRow(healthyId)).status).toBe('sent');
  });

  it('FINDING: the enqueue path throws too, so the trigger that would enrol also dies', async () => {
    const base = await seedImpossibleWindow();
    const clock = new FakeClock('2026-06-15T12:00:00Z');
    await expect(
      scheduleMessages(
        { db: testDb(), clock, publicBaseUrl: 'https://example.com' },
        {
          tenantId: base.tenantId,
          campaignId: base.campaignId,
          campaignVersionId: base.campaignVersionId,
          contactId: base.contactId,
          anchorType: 'manual',
          anchorId: null,
          anchorAt: clock.now(),
          orderId: null,
          enrollmentId: base.enrollmentId,
        },
      ),
      'enrolment should record a decision, not raise out of the trigger evaluator',
    ).resolves.toBeDefined();
  });
});

describe('QA/sched — a legal window that only NARROWS is fine (SAFE)', () => {
  it('a campaign window inside the floor schedules normally', async () => {
    const db = testDb();
    const base = await seedAll(db, {
      tenant: { quietStart: '08:00', quietEnd: '21:00' },
      campaign: { windowStart: '09:00', windowEnd: '17:00' },
    });
    await optIn(db, base.tenantId, base.contactId);
    await queueOne(base, { scheduledAt: '2026-06-15T11:00:00Z' });

    const { deps, provider } = harness({ now: '2026-06-15T12:00:00Z' });
    await expect(processQueue(deps)).resolves.toBeDefined();
    expect(provider.sent).toHaveLength(1);
  });
});
