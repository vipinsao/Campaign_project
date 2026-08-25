import type { PoolClient } from 'pg';
import { type Db, query } from '../db/pool.ts';
import type { Clock } from '../clock.ts';
import { AudienceResolver } from '../audience/resolver.ts';
import { recordDecision, recordDecisions } from '../decisions/decision-log.ts';
import { createEnrolment, scheduleMessages } from './enrolment.ts';
import type { AudienceDefinition } from '@campaign/shared';

/**
 * Time-based triggers, and the three guards that make them safe to deploy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A trigger like "sixty days since the last order" is different in kind from an
 * event trigger, and the difference is the thing that bites.
 *
 * An event trigger fires once, for one person, when something happens. A time
 * trigger evaluates the ENTIRE HISTORY of the database every time it runs — and
 * the first time it runs, every customer who has ever gone sixty days without
 * ordering qualifies simultaneously. On a four-year-old store that is not a
 * campaign, it is an incident: tens of thousands of people receiving a "we miss
 * you" message about a purchase they made in 2022, all at once, from a system
 * that has never sent anything before.
 *
 * Three guards, each of which fails CLOSED:
 *
 *   1. A CUTOFF FLOOR. Nothing whose anchor predates `triggerFloorAt` may ever
 *      enrol. If the floor is unset the job does nothing at all and says so. An
 *      unset floor is not "no restriction"; it is an unconfigured system, and an
 *      unconfigured system must not mail anyone.
 *
 *   2. A CIRCUIT BREAKER. If the candidate count exceeds `maxEnrolmentsPerRun`,
 *      enrol NOBODY, log the whole candidate list, and raise. Partially enrolling
 *      the first N would be worse than doing nothing: it produces a send that
 *      nobody authorised and leaves the remainder in an unknown state.
 *
 *   3. DRY RUN. Evaluate everything, write every decision row, queue nothing. New
 *      triggers run this way for their first day, by convention, and the decision
 *      log is read before the switch is flipped.
 *
 * Backfilling deliberately is a separate, explicit command. It is not something a
 * scheduled job should be able to do by accident.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type TimeTriggerDeps = {
  readonly db: Db | PoolClient;
  readonly clock: Clock;
  readonly publicBaseUrl: string;
  /** ISO instant. Nothing older than this may enrol. Unset means the job refuses. */
  readonly triggerFloorAt: Date | null;
  /** Refuse the whole run above this many candidates. */
  readonly maxEnrolmentsPerRun: number;
  readonly dryRun?: boolean;
};

export type TimeTriggerRun = {
  readonly campaignsEvaluated: number;
  readonly candidates: number;
  readonly enrolled: number;
  readonly queued: number;
  readonly refused: 'no_floor' | 'circuit_breaker' | null;
};

type TimeCampaign = {
  id: string;
  tenant_id: string;
  audience: AudienceDefinition;
  trigger_config: { days?: number };
  status: 'active' | 'observe';
  one_time_per_contact: boolean;
  active_version_id: string | null;
};

export async function runTimeTriggers(deps: TimeTriggerDeps): Promise<TimeTriggerRun> {
  const { db, clock } = deps;
  const now = clock.now();

  const campaigns = await query<TimeCampaign>(
    db,
    `SELECT id, tenant_id, audience, trigger_config, status, one_time_per_contact,
            active_version_id
       FROM campaigns
      WHERE trigger_type = 'days_since_last_order' AND status IN ('active','observe')
      ORDER BY created_at`,
  );

  // ── Guard 1: the floor, checked BEFORE any work ─────────────────────────────
  if (!deps.triggerFloorAt) {
    for (const campaign of campaigns) {
      await recordDecision(db, {
        tenantId: campaign.tenant_id,
        campaignId: campaign.id,
        stage: 'trigger',
        decision: 'skip',
        reasonCode: 'trigger_floor_not_set',
        detail:
          'TRIGGER_FLOOR_AT is not configured, so the time-trigger job refused to ' +
          'run. An unset floor is an unconfigured system, not an unrestricted one.',
      });
    }
    return {
      campaignsEvaluated: campaigns.length,
      candidates: 0,
      enrolled: 0,
      queued: 0,
      refused: 'no_floor',
    };
  }

  const resolver = new AudienceResolver(clock);
  let totalCandidates = 0;
  let enrolled = 0;
  let queued = 0;

  for (const campaign of campaigns) {
    const days = campaign.trigger_config.days;
    if (typeof days !== 'number' || days <= 0) {
      await recordDecision(db, {
        tenantId: campaign.tenant_id,
        campaignId: campaign.id,
        stage: 'trigger',
        decision: 'skip',
        reasonCode: 'trigger_floor_not_set',
        detail: `trigger_config.days is missing or not a positive number.`,
        inputs: { triggerConfig: campaign.trigger_config },
      });
      continue;
    }
    if (!campaign.active_version_id) continue;

    const threshold = new Date(now.getTime() - days * 86_400_000);

    // Candidates: last ordered before the threshold, but NOT before the floor, and
    // not already enrolled. The floor lives in the SQL rather than in a later
    // filter so that a large historical population never becomes a candidate list
    // in the first place.
    const candidates = await query<{ id: string; last_order_at: Date }>(
      db,
      `SELECT c.id, c.last_order_at
         FROM contacts c
        WHERE c.tenant_id = $1
          AND c.last_order_at IS NOT NULL
          AND c.last_order_at <= $2
          AND c.last_order_at >= $3
          AND NOT EXISTS (
                SELECT 1 FROM enrollments e
                 WHERE e.campaign_id = $4 AND e.contact_id = c.id
              )
        ORDER BY c.last_order_at DESC`,
      [campaign.tenant_id, threshold, deps.triggerFloorAt, campaign.id],
    );

    totalCandidates += candidates.length;

    // ── Guard 2: the circuit breaker ────────────────────────────────────────
    if (candidates.length > deps.maxEnrolmentsPerRun) {
      await recordDecision(db, {
        tenantId: campaign.tenant_id,
        campaignId: campaign.id,
        stage: 'trigger',
        decision: 'skip',
        reasonCode: 'trigger_circuit_breaker',
        detail:
          `${candidates.length} candidates exceeds the per-run ceiling of ` +
          `${deps.maxEnrolmentsPerRun}. Nobody was enrolled. If this is a ` +
          `deliberate backfill, run the backfill command explicitly.`,
        inputs: {
          candidateCount: candidates.length,
          ceiling: deps.maxEnrolmentsPerRun,
          // The list itself, so the decision is reviewable rather than merely reported.
          sampleContactIds: candidates.slice(0, 50).map((c) => c.id),
        },
      });
      return {
        campaignsEvaluated: campaigns.length,
        candidates: totalCandidates,
        enrolled,
        queued,
        refused: 'circuit_breaker',
      };
    }

    for (const candidate of candidates) {
      const audience = await resolver.matches(
        db,
        campaign.tenant_id,
        candidate.id,
        campaign.audience,
      );
      if (!audience.matched) {
        await recordDecision(db, {
          tenantId: campaign.tenant_id,
          campaignId: campaign.id,
          contactId: candidate.id,
          stage: 'audience',
          decision: 'skip',
          reasonCode: 'audience_mismatch',
          detail: audience.failedRule ?? 'Contact did not match the campaign audience.',
        });
        continue;
      }

      // ── Guard 3: dry run, and observe mode ────────────────────────────────
      if (deps.dryRun || campaign.status === 'observe') {
        await recordDecision(db, {
          tenantId: campaign.tenant_id,
          campaignId: campaign.id,
          contactId: candidate.id,
          stage: 'trigger',
          decision: 'proceed',
          reasonCode: deps.dryRun ? 'trigger_dry_run' : 'observe_mode_no_enqueue',
          detail: 'Evaluated and logged; nothing was queued.',
          inputs: { lastOrderAt: candidate.last_order_at.toISOString(), daysThreshold: days },
        });
        continue;
      }

      const ctx = {
        tenantId: campaign.tenant_id,
        campaignId: campaign.id,
        campaignVersionId: campaign.active_version_id,
        contactId: candidate.id,
        anchorType: 'contact' as const,
        // Anchored on the contact rather than an order: the campaign is about the
        // ABSENCE of a recent order, so there is no order to anchor to.
        anchorId: null,
        anchorAt: now,
        orderId: null,
      };

      const enrolment = await createEnrolment(db, ctx, deps.clock);
      if (!enrolment.created) continue;
      enrolled++;
      const result = await scheduleMessages(deps, { ...ctx, enrollmentId: enrolment.id });
      queued += result.queued.length;
    }
  }

  return {
    campaignsEvaluated: campaigns.length,
    candidates: totalCandidates,
    enrolled,
    queued,
    refused: null,
  };
}

/**
 * Stop conditions: end a contact's journey and cancel what remains queued.
 *
 * Cancelling the remaining messages is the whole point. A stop condition that
 * merely marks the enrolment stopped, while three already-queued messages go out
 * over the next week, has not stopped anything a recipient can perceive.
 */
export async function evaluateStopConditions(deps: {
  readonly db: Db | PoolClient;
  readonly clock: Clock;
}): Promise<{ stopped: number; cancelled: number }> {
  const { db, clock } = deps;
  const now = clock.now();

  const conditions = await query<{
    campaign_id: string;
    tenant_id: string;
    condition_type: string;
  }>(
    db,
    `SELECT sc.campaign_id, sc.tenant_id, sc.condition_type
       FROM campaign_stop_conditions sc
       JOIN campaigns c ON c.id = sc.campaign_id
      WHERE sc.is_active AND c.status = 'active'`,
  );

  let stopped = 0;
  let cancelled = 0;

  for (const condition of conditions) {
    const eventType =
      condition.condition_type === 'replied'
        ? 'replied'
        : condition.condition_type === 'clicked'
          ? 'clicked'
          : condition.condition_type === 'unsubscribed'
            ? 'unsubscribed'
            : null;
    if (!eventType) continue;

    const triggered = await query<{ id: string; contact_id: string }>(
      db,
      `SELECT e.id, e.contact_id
         FROM enrollments e
        WHERE e.campaign_id = $1 AND e.status = 'active'
          AND EXISTS (
                SELECT 1 FROM message_events me
                 WHERE me.campaign_id = e.campaign_id
                   AND me.contact_id = e.contact_id
                   AND me.event_type = $2
                   AND me.occurred_at >= e.enrolled_at
              )`,
      [condition.campaign_id, eventType],
    );

    for (const enrolment of triggered) {
      await db.query(
        `UPDATE enrollments
            SET status = 'stopped', stop_reason = $2, stopped_at = $3
          WHERE id = $1`,
        [enrolment.id, `stop_condition_${condition.condition_type}`, now],
      );
      stopped++;

      const rows = await query<{ id: string }>(
        db,
        `UPDATE message_queue
            SET status = 'cancelled',
                provider_error_code = $2,
                updated_at = $3
          WHERE enrollment_id = $1 AND status IN ('pending','processing')
          RETURNING id`,
        [enrolment.id, 'enrollment_stopped', now],
      );
      cancelled += rows.length;

      if (rows.length > 0) {
        await recordDecisions(
          db,
          rows.map((r) => ({
            tenantId: condition.tenant_id,
            campaignId: condition.campaign_id,
            contactId: enrolment.contact_id,
            messageQueueId: r.id,
            stage: 'enrollment' as const,
            decision: 'skip' as const,
            reasonCode: 'enrollment_stopped' as const,
            detail: `Journey ended by the '${condition.condition_type}' stop condition.`,
          })),
        );
      }
    }
  }

  return { stopped, cancelled };
}
