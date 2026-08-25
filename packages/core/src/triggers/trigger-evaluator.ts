import type { PoolClient } from 'pg';
import { type Db, query, queryOne } from '../db/pool.ts';
import type { Clock } from '../clock.ts';
import { AudienceResolver } from '../audience/resolver.ts';
import { recordDecision } from '../decisions/decision-log.ts';
import { createEnrolment, scheduleMessages } from './enrolment.ts';
import type { AudienceDefinition, RecipientResolution, TriggerType } from '@campaign/shared';

/**
 * The trigger evaluator.
 *
 * Its output is not only "enrolments created". It is **a decision row for every
 * campaign considered, including the ones that did not fire** (I14).
 *
 * That is the part that makes the difference operationally. Without it, "the
 * review request didn't go out" is a question that can only be answered by reading
 * the source and reasoning about what must have happened. With it, the answer is a
 * row that says `audience_mismatch: contact has 1 order, the segment requires 2`.
 */

export type DomainEvent =
  | { readonly type: 'order_placed'; readonly tenantId: string; readonly orderId: string }
  | { readonly type: 'order_shipped'; readonly tenantId: string; readonly orderId: string }
  | { readonly type: 'order_delivered'; readonly tenantId: string; readonly orderId: string }
  | { readonly type: 'order_cancelled'; readonly tenantId: string; readonly orderId: string }
  | { readonly type: 'contact_created'; readonly tenantId: string; readonly contactId: string }
  | {
      readonly type: 'api_event';
      readonly tenantId: string;
      readonly contactId: string;
      readonly name: string;
    };

export type TriggerDeps = {
  readonly db: Db | PoolClient;
  readonly clock: Clock;
  readonly publicBaseUrl: string;
  /** Evaluate but never enqueue. New triggers run this way for their first day. */
  readonly dryRun?: boolean;
};

export type TriggerOutcome = {
  readonly campaignsConsidered: number;
  readonly enrolled: number;
  readonly queued: number;
  readonly skipped: { campaignId: string; reason: string }[];
};

type CampaignCandidate = {
  id: string;
  status: 'active' | 'observe';
  audience: AudienceDefinition;
  one_time_per_contact: boolean;
  active_version_id: string | null;
};

/**
 * Resolve the contact an event concerns.
 *
 * For order-driven events this reads the order's own `contact_id`, which is
 * unambiguous. The ambiguity that I13 guards against arises when a HUMAN or an
 * external system supplies an order NUMBER — see `resolveByOrderNumber` below.
 */
async function contactForEvent(
  db: Db | PoolClient,
  event: DomainEvent,
): Promise<{ contactId: string; orderId: string | null; anchorAt: Date } | undefined> {
  if (event.type === 'contact_created' || event.type === 'api_event') {
    const row = await queryOne<{ id: string; created_at: Date }>(
      db,
      `SELECT id, created_at FROM contacts WHERE id = $1 AND tenant_id = $2`,
      [event.contactId, event.tenantId],
    );
    return row ? { contactId: row.id, orderId: null, anchorAt: row.created_at } : undefined;
  }

  const order = await queryOne<{
    contact_id: string;
    id: string;
    placed_at: Date;
    shipped_at: Date | null;
    delivered_at: Date | null;
    cancelled_at: Date | null;
  }>(
    db,
    `SELECT contact_id, id, placed_at, shipped_at, delivered_at, cancelled_at
       FROM orders WHERE id = $1 AND tenant_id = $2`,
    [event.orderId, event.tenantId],
  );
  if (!order) return undefined;

  // The anchor is the instant the thing being reacted to actually happened, not
  // the instant the event was processed. "Three days after delivery" must mean
  // three days after the parcel arrived, even if the webhook was late by a day.
  const anchorAt =
    event.type === 'order_delivered'
      ? (order.delivered_at ?? order.placed_at)
      : event.type === 'order_shipped'
        ? (order.shipped_at ?? order.placed_at)
        : event.type === 'order_cancelled'
          ? (order.cancelled_at ?? order.placed_at)
          : order.placed_at;

  return { contactId: order.contact_id, orderId: order.id, anchorAt };
}

/**
 * Resolve a recipient from an order NUMBER  (I13).
 *
 * Order numbers are unique per store, not per tenant — the schema says so, and the
 * unique constraint includes `store_id` precisely to keep that true. So a lookup by
 * number alone genuinely can match more than one order, and the return type makes
 * the caller deal with it.
 *
 * The tempting implementation is `ORDER BY placed_at DESC LIMIT 1`. It is wrong in
 * a way that is invisible in testing and severe in production: it sends one
 * customer's order details to a different customer.
 */
export async function resolveByOrderNumber(
  db: Db | PoolClient,
  opts: { tenantId: string; orderNumber: string; storeId?: string | null },
): Promise<RecipientResolution<{ orderId: string; contactId: string; storeId: string }>> {
  const rows = await query<{ id: string; contact_id: string; store_id: string }>(
    db,
    `SELECT id, contact_id, store_id FROM orders
      WHERE tenant_id = $1 AND order_number = $2
        AND ($3::uuid IS NULL OR store_id = $3::uuid)
      ORDER BY placed_at DESC`,
    [opts.tenantId, opts.orderNumber, opts.storeId ?? null],
  );

  if (rows.length === 0) return { kind: 'none' };

  const candidates = rows.map((r) => ({
    orderId: r.id,
    contactId: r.contact_id,
    storeId: r.store_id,
  }));

  const [first] = candidates;
  if (candidates.length === 1 && first) return { kind: 'single', match: first };
  return { kind: 'ambiguous', candidates };
}

const EVENT_TO_TRIGGER: Record<DomainEvent['type'], TriggerType> = {
  order_placed: 'order_placed',
  order_shipped: 'order_shipped',
  order_delivered: 'order_delivered',
  order_cancelled: 'order_cancelled',
  contact_created: 'contact_created',
  api_event: 'api_event',
};

/**
 * Evaluate one domain event against every campaign that could react to it.
 */
export async function evaluateTrigger(
  deps: TriggerDeps,
  event: DomainEvent,
): Promise<TriggerOutcome> {
  const { db } = deps;
  const skipped: { campaignId: string; reason: string }[] = [];
  let enrolled = 0;
  let queued = 0;

  const subject = await contactForEvent(db, event);
  if (!subject) {
    await recordDecision(db, {
      tenantId: event.tenantId,
      stage: 'trigger',
      decision: 'skip',
      reasonCode: 'recipient_not_found',
      detail: `No contact could be resolved for a '${event.type}' event.`,
      inputs: { event: event.type },
    });
    return { campaignsConsidered: 0, enrolled: 0, queued: 0, skipped: [] };
  }

  const candidates = await query<CampaignCandidate>(
    db,
    `SELECT id, status, audience, one_time_per_contact, active_version_id
       FROM campaigns
      WHERE tenant_id = $1 AND trigger_type = $2 AND status IN ('active','observe')
      ORDER BY created_at`,
    [event.tenantId, EVENT_TO_TRIGGER[event.type]],
  );

  const resolver = new AudienceResolver(deps.clock);

  for (const campaign of candidates) {
    const base = {
      tenantId: event.tenantId,
      campaignId: campaign.id,
      contactId: subject.contactId,
      orderId: subject.orderId ?? undefined,
      stage: 'trigger' as const,
    };

    // A campaign that has never been activated has no version to snapshot against,
    // so there is nothing to enrol into. This is a configuration state, not an
    // error, and it gets a decision row like everything else.
    if (!campaign.active_version_id) {
      await recordDecision(db, {
        ...base,
        decision: 'skip',
        reasonCode: 'campaign_not_active',
        detail: 'Campaign has never been activated, so it has no version to enrol against.',
      });
      skipped.push({ campaignId: campaign.id, reason: 'campaign_not_active' });
      continue;
    }

    const audience = await resolver.matches(
      db,
      event.tenantId,
      subject.contactId,
      campaign.audience,
    );
    if (!audience.matched) {
      await recordDecision(db, {
        ...base,
        stage: 'audience',
        decision: 'skip',
        reasonCode: 'audience_mismatch',
        detail: audience.failedRule ?? 'Contact did not match the campaign audience.',
        inputs: { failedRule: audience.failedRule ?? null },
      });
      skipped.push({ campaignId: campaign.id, reason: 'audience_mismatch' });
      continue;
    }

    if (campaign.one_time_per_contact) {
      const ever = await queryOne<{ id: string }>(
        db,
        `SELECT id FROM enrollments WHERE campaign_id = $1 AND contact_id = $2 LIMIT 1`,
        [campaign.id, subject.contactId],
      );
      if (ever) {
        await recordDecision(db, {
          ...base,
          decision: 'skip',
          reasonCode: 'one_time_per_contact',
        });
        skipped.push({ campaignId: campaign.id, reason: 'one_time_per_contact' });
        continue;
      }
    }

    // ── observe mode ────────────────────────────────────────────────────────
    // Everything above ran. Nothing below will. This is the cheapest insurance in
    // the system: ship a new campaign in observe for a day, read the decision log,
    // and find out who WOULD have been mailed before anybody is.
    if (campaign.status === 'observe') {
      await recordDecision(db, {
        ...base,
        decision: 'proceed',
        reasonCode: 'observe_mode_no_enqueue',
        detail: 'Campaign is in observe mode: this contact would have been enrolled.',
        inputs: { wouldEnrol: true, anchorAt: subject.anchorAt.toISOString() },
      });
      skipped.push({ campaignId: campaign.id, reason: 'observe_mode_no_enqueue' });
      continue;
    }

    if (deps.dryRun) {
      await recordDecision(db, {
        ...base,
        decision: 'proceed',
        reasonCode: 'trigger_dry_run',
        detail: 'Trigger is in dry-run: this contact would have been enrolled.',
        inputs: { wouldEnrol: true },
      });
      skipped.push({ campaignId: campaign.id, reason: 'trigger_dry_run' });
      continue;
    }

    const ctx = {
      tenantId: event.tenantId,
      campaignId: campaign.id,
      campaignVersionId: campaign.active_version_id,
      contactId: subject.contactId,
      anchorType: subject.orderId ? ('order' as const) : ('contact' as const),
      anchorId: subject.orderId,
      anchorAt: subject.anchorAt,
      orderId: subject.orderId,
    };

    const enrolment = await createEnrolment(db, ctx, deps.clock);
    if (!enrolment.created) {
      // Idempotent: the same order webhook delivered twice must not double-enrol.
      await recordDecision(db, {
        ...base,
        decision: 'skip',
        reasonCode: 'already_enrolled',
      });
      skipped.push({ campaignId: campaign.id, reason: 'already_enrolled' });
      continue;
    }

    enrolled++;
    const result = await scheduleMessages(deps, { ...ctx, enrollmentId: enrolment.id });
    queued += result.queued.length;
  }

  return { campaignsConsidered: candidates.length, enrolled, queued, skipped };
}
