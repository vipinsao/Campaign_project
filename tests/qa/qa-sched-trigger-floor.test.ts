/**
 * QA — adversarial review of `runTimeTriggers`  (hypothesis 10, plus two things
 * found while attacking it).
 *
 * The floor comparison itself is sound. The two guards around it are not: the
 * candidate query silently makes every time-triggered campaign one-time-only
 * regardless of `one_time_per_contact`, and the circuit breaker aborts the entire
 * run rather than the campaign that tripped it, so later campaigns are skipped with
 * no decision row at all — in a job whose whole premise (I14) is that everything
 * gets a decision row.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedCampaign, seedCampaignMessage, seedContact, seedTenant } from '../support/fixtures.ts';
import { runTimeTriggers, FakeClock } from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

const NOW = '2026-06-15T12:00:00Z';

async function seedTimeCampaign(
  opts: { days?: number; oneTimePerContact?: boolean; name?: string } = {},
): Promise<{ tenantId: string; campaignId: string }> {
  const db = testDb();
  const tenantId = await seedTenant(db, { name: opts.name ?? 'T' });
  const { campaignId } = await seedCampaign(db, tenantId, {
    name: opts.name ?? 'Win-back',
    category: 'lifecycle',
    triggerType: 'days_since_last_order',
    status: 'active',
  });
  await seedCampaignMessage(db, tenantId, campaignId);
  await db.query(
    `UPDATE campaigns SET trigger_config = $2::jsonb, one_time_per_contact = $3 WHERE id = $1`,
    [campaignId, JSON.stringify({ days: opts.days ?? 60 }), opts.oneTimePerContact ?? false],
  );
  return { tenantId, campaignId };
}

async function seedContactWithLastOrder(tenantId: string, at: string): Promise<string> {
  const db = testDb();
  const contactId = await seedContact(db, tenantId);
  await db.query(`UPDATE contacts SET last_order_at = $2::timestamptz WHERE id = $1`, [
    contactId,
    at,
  ]);
  return contactId;
}

function deps(overrides: Partial<Parameters<typeof runTimeTriggers>[0]> = {}) {
  return {
    db: testDb(),
    clock: new FakeClock(NOW),
    publicBaseUrl: 'https://example.com',
    triggerFloorAt: new Date('2026-01-01T00:00:00Z'),
    maxEnrolmentsPerRun: 100,
    ...overrides,
  };
}

describe('QA/triggers — the floor boundary (hypothesis 10, SAFE)', () => {
  it('a contact whose last order is EXACTLY at the floor enrols', async () => {
    const { tenantId } = await seedTimeCampaign();
    await seedContactWithLastOrder(tenantId, '2026-01-01T00:00:00Z');
    const run = await runTimeTriggers(deps());
    expect(run.candidates, '`>= floor`: "predates the floor" is strictly before').toBe(1);
    expect(run.enrolled).toBe(1);
  });

  it('one millisecond before the floor does not enrol', async () => {
    const { tenantId } = await seedTimeCampaign();
    await seedContactWithLastOrder(tenantId, '2025-12-31T23:59:59.999Z');
    const run = await runTimeTriggers(deps());
    expect(run.candidates).toBe(0);
    expect(run.enrolled).toBe(0);
  });

  it('a contact exactly at the days threshold enrols; one millisecond newer does not', async () => {
    const { tenantId } = await seedTimeCampaign({ days: 60 });
    // now - 60 * 86_400_000
    await seedContactWithLastOrder(tenantId, '2026-04-16T12:00:00.000Z');
    expect((await runTimeTriggers(deps())).candidates).toBe(1);

    await resetDb();
    const second = await seedTimeCampaign({ days: 60 });
    await seedContactWithLastOrder(second.tenantId, '2026-04-16T12:00:00.001Z');
    expect((await runTimeTriggers(deps())).candidates).toBe(0);
  });

  it('an unset floor refuses the run outright and records a decision per campaign', async () => {
    const { tenantId, campaignId } = await seedTimeCampaign();
    await seedContactWithLastOrder(tenantId, '2026-01-02T00:00:00Z');
    const run = await runTimeTriggers(deps({ triggerFloorAt: null }));
    expect(run.refused).toBe('no_floor');
    expect(run.enrolled).toBe(0);
    const { rows } = await testDb().query<{ reason_code: string }>(
      `SELECT reason_code FROM send_decisions WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(rows.map((r) => r.reason_code)).toEqual(['trigger_floor_not_set']);
  });

  it('CHARACTERISATION: "days" is 86_400_000 ms, not calendar days', async () => {
    // A DST-observing recipient crosses the threshold an hour early or late twice a
    // year. Harmless for a 60-day win-back; worth knowing before someone builds a
    // "1 day since" trigger on it.
    const { tenantId } = await seedTimeCampaign({ days: 1 });
    await seedContactWithLastOrder(tenantId, '2026-06-14T12:00:00.000Z');
    expect((await runTimeTriggers(deps())).candidates).toBe(1);
  });
});

describe('QA/triggers — one_time_per_contact is ignored by the time-trigger job (BROKEN)', () => {
  it('FINDING: a repeatable campaign never re-enrols, because NOT EXISTS is unconditional', async () => {
    // The candidate query excludes any contact with ANY enrolment on the campaign,
    // whatever `one_time_per_contact` says. `campaign.one_time_per_contact` is
    // SELECTed in runTimeTriggers and then never read.
    const { tenantId, campaignId } = await seedTimeCampaign({ oneTimePerContact: false });
    const contactId = await seedContactWithLastOrder(tenantId, '2026-01-05T00:00:00Z');

    const first = await runTimeTriggers(deps());
    expect(first.enrolled).toBe(1);

    // The customer orders again, and then lapses again a year later.
    await testDb().query(
      `UPDATE contacts SET last_order_at = '2026-02-01T00:00:00Z'::timestamptz WHERE id = $1`,
      [contactId],
    );
    // Complete the first journey so nothing else is holding them.
    await testDb().query(
      `UPDATE enrollments SET status = 'completed', completed_at = now() WHERE campaign_id = $1`,
      [campaignId],
    );

    const second = await runTimeTriggers(deps());
    expect(
      second.enrolled,
      'one_time_per_contact is false, so a lapsed customer should be re-engaged',
    ).toBe(1);
  });
});

describe('QA/triggers — the circuit breaker aborts the whole run (BROKEN)', () => {
  it('FINDING: campaigns after the tripping one are skipped with no decision row', async () => {
    const db = testDb();
    const tenantId = await seedTenant(db, { name: 'Shared' });

    // Two time-triggered campaigns on one tenant, ordered by created_at.
    const mk = async (name: string) => {
      const { campaignId } = await seedCampaign(db, tenantId, {
        name,
        category: 'lifecycle',
        triggerType: 'days_since_last_order',
        status: 'active',
      });
      await seedCampaignMessage(db, tenantId, campaignId);
      await db.query(`UPDATE campaigns SET trigger_config = '{"days":60}'::jsonb WHERE id = $1`, [
        campaignId,
      ]);
      return campaignId;
    };
    const first = await mk('A-trips-the-breaker');
    await new Promise((r) => setTimeout(r, 5));
    const second = await mk('B-never-evaluated');

    for (let i = 0; i < 3; i++) await seedContactWithLastOrder(tenantId, '2026-01-05T00:00:00Z');

    const run = await runTimeTriggers(deps({ maxEnrolmentsPerRun: 2 }));
    expect(run.refused).toBe('circuit_breaker');

    const { rows } = await testDb().query<{ reason_code: string }>(
      `SELECT reason_code FROM send_decisions WHERE campaign_id = $1`,
      [second],
    );
    expect(
      rows.map((r) => r.reason_code),
      `campaign ${first} tripped the breaker; campaign ${second} was silently ` +
        'dropped from the run with no decision row, which is exactly what I14 forbids',
    ).not.toEqual([]);
  });

  it('FINDING: "Nobody was enrolled" is not true when an earlier campaign already enrolled', async () => {
    const db = testDb();
    const tenantId = await seedTenant(db, { name: 'Shared2' });

    const mk = async (name: string, days: number) => {
      const { campaignId } = await seedCampaign(db, tenantId, {
        name,
        category: 'lifecycle',
        triggerType: 'days_since_last_order',
        status: 'active',
      });
      await seedCampaignMessage(db, tenantId, campaignId);
      await db.query(`UPDATE campaigns SET trigger_config = $2::jsonb WHERE id = $1`, [
        campaignId,
        JSON.stringify({ days }),
      ]);
      return campaignId;
    };
    // A only reaches the long-lapsed contacts; B reaches everybody.
    await mk('A-small', 60);
    await new Promise((r) => setTimeout(r, 5));
    const big = await mk('B-trips-the-breaker', 1);

    for (let i = 0; i < 2; i++) await seedContactWithLastOrder(tenantId, '2026-01-05T00:00:00Z');
    for (let i = 0; i < 2; i++) await seedContactWithLastOrder(tenantId, '2026-06-13T00:00:00Z');

    // Ceiling 3: campaign A enrols its two candidates, then campaign B's four
    // candidates trip the breaker and abort the run.
    const run = await runTimeTriggers(deps({ maxEnrolmentsPerRun: 3 }));
    expect(run.refused).toBe('circuit_breaker');

    const { rows } = await testDb().query<{ reason_detail: string }>(
      `SELECT reason_detail FROM send_decisions
        WHERE campaign_id = $1 AND reason_code = 'trigger_circuit_breaker'`,
      [big],
    );
    expect(rows[0]?.reason_detail).toContain('Nobody was enrolled');
    expect(
      run.enrolled,
      'the decision row says nobody was enrolled while the run reports enrolments ' +
        'from the campaigns evaluated before the breaker tripped',
    ).toBe(0);
  });
});
