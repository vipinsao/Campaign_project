import type { PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { type Db, query, queryOne } from '../db/pool.ts';
import type { Clock } from '../clock.ts';
import { enqueue } from '../queue/message-queue.ts';
import { recordDecision } from '../decisions/decision-log.ts';
import { isQuietHoursExempt, scheduleWithin } from '../scheduling/quiet-hours.ts';
import { render, hasClickableLink } from '../rendering/renderer.ts';
import type { Channel, DelayAnchor, SendCondition } from '@campaign/shared';

/**
 * Enrolment: turning "this campaign should fire for this contact" into queued rows.
 *
 * The two things worth knowing about this file:
 *
 *  - It renders each message at ENQUEUE time and stores the output on the queue
 *    row. That is deliberate. The alternative — rendering at send time — means the
 *    message a recipient receives can silently change between being scheduled and
 *    being sent, because someone edited the template in between. Storing the
 *    rendered body alongside the campaign version that produced it is what makes
 *    "what did this person actually receive?" answerable later.
 *
 *  - Every gate it applies here is an OPTIMISATION, not an authority. All of them
 *    run again at send time (I1). Skipping work early is worth doing; trusting
 *    that early decision hours later is not.
 */

export type CampaignMessageRow = {
  id: string;
  channel: Channel;
  sequence_order: number;
  delay_anchor: DelayAnchor;
  delay_minutes: number;
  send_condition: SendCondition;
  subject_template: string | null;
  html_template: string | null;
  body_template: string;
  is_enabled: boolean;
};

export type EnrolmentContext = {
  readonly tenantId: string;
  readonly campaignId: string;
  readonly campaignVersionId: string;
  readonly contactId: string;
  readonly anchorType: 'order' | 'contact' | 'manual';
  readonly anchorId: string | null;
  readonly anchorAt: Date;
  readonly orderId: string | null;
};

export type EnrolmentDeps = {
  readonly db: Db | PoolClient;
  readonly clock: Clock;
  /** Base URL used to build opt-out and preference links. */
  readonly publicBaseUrl: string;
};

/**
 * Mint a single-use-ish opt-out token.
 *
 * 32 bytes of crypto-random, base64url. Not a signed payload and not derived from
 * the contact id: an unsubscribe URL is handed to a mail client, forwarded, logged
 * by intermediaries, and occasionally posted publicly. A guessable or reversible
 * token there would let anyone unsubscribe anyone.
 */
export function mintUnsubscribeToken(): string {
  return randomBytes(32).toString('base64url');
}

type ContactRow = {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  locale: string | null;
  timezone: string | null;
};

type OrderRow = {
  id: string;
  order_number: string;
  total: string;
  currency: string;
  carrier: string | null;
  tracking_number: string | null;
  placed_at: Date | null;
  delivered_at: Date | null;
};

type TenantRow = {
  id: string;
  default_timezone: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
};

type CampaignRow = {
  id: string;
  category: 'lifecycle' | 'promotional' | 'transactional' | 'operational';
  send_window_start: string | null;
  send_window_end: string | null;
  send_days: number[];
  one_time_per_contact: boolean;
};

/**
 * Create an enrolment, or return the existing one.
 *
 * `ON CONFLICT DO NOTHING` against `enrollments_one_per_anchor` absorbs the
 * concurrent duplicate rather than racing against a prior SELECT. Two trigger
 * events for the same order arriving at once is not an exceptional case; it is
 * what a webhook retry looks like.
 */
export async function createEnrolment(
  db: Db | PoolClient,
  ctx: EnrolmentContext,
  clock: Clock,
): Promise<{ id: string; created: boolean }> {
  // enrolled_at comes from the INJECTED clock, not from the column's DEFAULT now().
  //
  // This is not a detail. Stop conditions ask "did an event occur since this
  // contact was enrolled?", so enrolled_at participates in a decision. Leaving it
  // to the database means that one comparison silently reads the server's wall
  // clock while everything around it reads the injected one - which makes the
  // whole system untestable at speed and makes `demo:simulate` produce a timeline
  // where nothing ever qualifies. A DEFAULT is a fallback, not an authority.
  const inserted = await queryOne<{ id: string }>(
    db,
    `INSERT INTO enrollments
       (tenant_id, campaign_id, campaign_version_id, contact_id, anchor_type, anchor_id,
        enrolled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (campaign_id, contact_id, anchor_id) DO NOTHING
     RETURNING id`,
    [
      ctx.tenantId,
      ctx.campaignId,
      ctx.campaignVersionId,
      ctx.contactId,
      ctx.anchorType,
      ctx.anchorId,
      clock.now(),
    ],
  );
  if (inserted) return { id: inserted.id, created: true };

  const existing = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM enrollments
      WHERE campaign_id = $1 AND contact_id = $2
        AND anchor_id IS NOT DISTINCT FROM $3`,
    [ctx.campaignId, ctx.contactId, ctx.anchorId],
  );
  if (!existing) {
    throw new Error(
      'Enrolment insert conflicted but no existing row was found. This means the ' +
        'unique constraint and the lookup disagree about identity.',
    );
  }
  return { id: existing.id, created: false };
}

/**
 * Render and queue every enabled message in a campaign for one enrolment.
 *
 * Returns the queued rows and the ones that were deduplicated away, because both
 * outcomes get a decision row: a message that was already queued is a normal,
 * expected result, not an error.
 */
export async function scheduleMessages(
  deps: EnrolmentDeps,
  ctx: EnrolmentContext & { enrollmentId: string },
): Promise<{ queued: string[]; duplicates: number; skipped: number }> {
  const { db, clock } = deps;

  const campaign = await queryOne<CampaignRow>(
    db,
    `SELECT id, category,
            to_char(send_window_start,'HH24:MI') AS send_window_start,
            to_char(send_window_end,'HH24:MI')   AS send_window_end,
            send_days, one_time_per_contact
       FROM campaigns WHERE id = $1`,
    [ctx.campaignId],
  );
  const tenant = await queryOne<TenantRow>(
    db,
    `SELECT id, default_timezone,
            to_char(quiet_hours_start,'HH24:MI') AS quiet_hours_start,
            to_char(quiet_hours_end,'HH24:MI')   AS quiet_hours_end
       FROM tenants WHERE id = $1`,
    [ctx.tenantId],
  );
  const contact = await queryOne<ContactRow>(
    db,
    `SELECT id, email, phone, first_name, last_name, locale, timezone
       FROM contacts WHERE id = $1`,
    [ctx.contactId],
  );
  if (!campaign || !tenant || !contact) {
    throw new Error('Enrolment references a campaign, tenant or contact that does not exist.');
  }

  const order = ctx.orderId
    ? await queryOne<OrderRow>(
        db,
        `SELECT id, order_number, total::text AS total, currency, carrier, tracking_number,
                placed_at, delivered_at
           FROM orders WHERE id = $1`,
        [ctx.orderId],
      )
    : undefined;

  const messages = await query<CampaignMessageRow>(
    db,
    `SELECT id, channel, sequence_order, delay_anchor, delay_minutes, send_condition,
            subject_template, html_template, body_template, is_enabled
       FROM campaign_messages
      WHERE campaign_id = $1 AND is_enabled
      ORDER BY sequence_order`,
    [ctx.campaignId],
  );

  const queued: string[] = [];
  let duplicates = 0;
  let skipped = 0;
  let previousScheduledAt = ctx.anchorAt;

  for (const message of messages) {
    const address = message.channel === 'email' ? contact.email : contact.phone;
    if (!address) {
      // No usable address on this channel. Recorded, not silently dropped.
      await recordDecision(db, {
        tenantId: ctx.tenantId,
        stage: 'schedule',
        decision: 'skip',
        reasonCode: 'no_recipient_address',
        detail: `Contact has no ${message.channel} address, so this message was not queued.`,
        campaignId: ctx.campaignId,
        campaignMessageId: message.id,
        contactId: ctx.contactId,
        orderId: ctx.orderId ?? undefined,
      });
      skipped++;
      continue;
    }

    const token = mintUnsubscribeToken();
    await db.query(
      `INSERT INTO unsubscribe_tokens (token, tenant_id, contact_id) VALUES ($1,$2,$3)`,
      [token, ctx.tenantId, ctx.contactId],
    );

    const mergeContext = {
      contact: {
        first_name: contact.first_name,
        last_name: contact.last_name,
        email: contact.email,
        phone: contact.phone,
        locale: contact.locale,
      },
      order: order
        ? {
            number: order.order_number,
            total: order.total,
            currency: order.currency,
            carrier: order.carrier,
            tracking_number: order.tracking_number,
            // Only present when the carrier actually supplied one. A missing
            // tracking number renders empty; it never becomes a plausible-looking
            // invented URL.
            tracking_url: order.tracking_number
              ? `${deps.publicBaseUrl}/track/${order.tracking_number}`
              : null,
            placed_at: order.placed_at?.toISOString() ?? null,
            delivered_at: order.delivered_at?.toISOString() ?? null,
          }
        : undefined,
      unsubscribe_url: `${deps.publicBaseUrl}/u/${token}`,
      preferences_url: `${deps.publicBaseUrl}/u/${token}`,
    };

    const renderedBody = render(message.body_template, mergeContext, { escape: false });
    const renderedHtml = message.html_template
      ? render(message.html_template, mergeContext, { escape: true })
      : null;
    const renderedSubject = message.subject_template
      ? render(message.subject_template, mergeContext, { escape: false })
      : null;

    // A delivery-anchored message cannot be scheduled yet: the order has not been
    // delivered, and the anchor instant is unknowable at enrolment time. Park it at
    // 'infinity' and let the delivery handler rewrite scheduled_at.
    const parked = message.delay_anchor === 'delivery' && !order?.delivered_at;

    let scheduledAt: Date | null = null;
    if (!parked) {
      const base =
        message.delay_anchor === 'previous'
          ? previousScheduledAt
          : message.delay_anchor === 'delivery'
            ? (order?.delivered_at ?? ctx.anchorAt)
            : ctx.anchorAt;

      const target = new Date(base.getTime() + message.delay_minutes * 60_000);

      scheduledAt = isQuietHoursExempt(campaign.category)
        ? target
        : scheduleWithin({
            target,
            timezone: contact.timezone,
            tenantTimezone: tenant.default_timezone,
            config: {
              floorStart: tenant.quiet_hours_start,
              floorEnd: tenant.quiet_hours_end,
              windowStart: campaign.send_window_start,
              windowEnd: campaign.send_window_end,
              sendDays: campaign.send_days,
            },
          });
      previousScheduledAt = scheduledAt;
    }

    const row = await enqueue(db, {
      tenantId: ctx.tenantId,
      enrollmentId: ctx.enrollmentId,
      campaignId: ctx.campaignId,
      campaignVersionId: ctx.campaignVersionId,
      campaignMessageId: message.id,
      contactId: ctx.contactId,
      orderId: ctx.orderId,
      anchorId: ctx.anchorId,
      channel: message.channel,
      recipientAddress: address,
      renderedSubject,
      renderedBody,
      renderedHtml,
      scheduledAt,
    });

    if (!row) {
      // I4: the database deduplicated it. Expected, not exceptional.
      duplicates++;
      await recordDecision(db, {
        tenantId: ctx.tenantId,
        stage: 'schedule',
        decision: 'skip',
        reasonCode: 'duplicate_suppressed',
        campaignId: ctx.campaignId,
        campaignMessageId: message.id,
        contactId: ctx.contactId,
        orderId: ctx.orderId ?? undefined,
      });
      continue;
    }

    queued.push(row.id);
    await db.query(`UPDATE unsubscribe_tokens SET message_queue_id = $2 WHERE token = $1`, [
      token,
      row.id,
    ]);

    await recordDecision(db, {
      tenantId: ctx.tenantId,
      stage: 'schedule',
      decision: 'proceed',
      reasonCode: 'enqueued',
      detail: parked
        ? 'Queued awaiting delivery of the order; it has no send time yet.'
        : `Queued for ${scheduledAt?.toISOString() ?? 'unknown'}.`,
      campaignId: ctx.campaignId,
      campaignMessageId: message.id,
      contactId: ctx.contactId,
      orderId: ctx.orderId ?? undefined,
      messageQueueId: row.id,
      inputs: {
        channel: message.channel,
        delayAnchor: message.delay_anchor,
        delayMinutes: message.delay_minutes,
        parkedAwaitingDelivery: parked,
        hasClickableLink: hasClickableLink(renderedBody, renderedHtml),
        quietHoursExempt: isQuietHoursExempt(campaign.category),
      },
    });

    await db.query(
      `INSERT INTO message_events (tenant_id, message_queue_id, campaign_id, contact_id,
                                   event_type, channel, occurred_at, idempotency_key)
       VALUES ($1,$2,$3,$4,'queued',$5,$6,$7)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [
        ctx.tenantId,
        row.id,
        ctx.campaignId,
        ctx.contactId,
        message.channel,
        clock.now(),
        `queued:${row.id}`,
      ],
    );
  }

  return { queued, duplicates, skipped };
}
