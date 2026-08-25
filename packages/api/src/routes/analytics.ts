import { Hono } from 'hono';
import { METRICS, query, queryOne, rate } from '@campaign/core';
import type { MetricInputs, MetricKey } from '@campaign/core';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { tenantOf } from '../middleware/context.ts';
import { loadCampaign } from '../services/campaigns.ts';
import { pagination } from './campaigns.ts';

/**
 * Campaign analytics  (I12).
 *
 * This layer COUNTS. It does not define a single rate — every rate comes from
 * `METRICS` in packages/core/src/metrics/denominators.ts, and every one is
 * computed by that module's `rate()`. Two things follow from that, both of which
 * are the point:
 *
 *  1. The denominator travels with the number. Each rate is returned alongside the
 *     `denominatorLabel` and `caveat` the core definition carries, so the warning
 *     lives in the payload rather than in a tooltip somebody removes during a
 *     redesign.
 *
 *  2. `null` and `0` stay different. `rate()` returns null when the denominator is
 *     zero, and this endpoint passes that through untouched. Coercing it to 0 here
 *     would assert "nobody opened it" about a campaign that has not delivered
 *     anything yet, which is the source of almost every "0% open rate" panic in a
 *     messaging product.
 *
 * The one rule this file has to keep on its own is about UNIQUES: they are
 * COUNT(DISTINCT contact_id) straight from `message_events`, never a sum of
 * `campaign_daily_stats.unique_opens`. That column is unique-per-contact-per-DAY,
 * so summing it over a range double-counts anyone who opened on two days.
 */

type EventCount = { event_type: string; total: string; uniques: string };

const REPORTED_METRICS: readonly MetricKey[] = [
  'delivery_rate',
  'bounce_rate',
  'open_rate',
  'click_rate',
  'click_to_open_rate',
  'complaint_rate',
  'unsubscribe_rate',
];

function ratesFor(inputs: MetricInputs, channels: readonly string[]) {
  return REPORTED_METRICS.map((key) => {
    const definition = METRICS[key];
    return {
      key,
      label: definition.label,
      value: rate(key, inputs),
      denominator: definition.denominatorLabel,
      // SMS has no opens at all, so an open rate on an SMS-only campaign is not
      // "zero", it is not a thing. Reporting it as applicable would invite someone
      // to optimise a number that cannot exist.
      applicable: definition.channels.some((ch) => channels.includes(ch)),
      ...(definition.caveat === undefined ? {} : { caveat: definition.caveat }),
    };
  });
}

export function analyticsRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/campaigns/:id/stats', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));

    const queue = await queryOne<Record<string, string>>(
      deps.db,
      `SELECT count(*)::text                                              AS total,
              count(*) FILTER (WHERE status IN ('pending','processing'))::text AS queued,
              count(*) FILTER (WHERE sent_at IS NOT NULL)::text            AS sent,
              count(*) FILTER (WHERE status = 'delivered')::text           AS delivered,
              count(*) FILTER (WHERE status = 'failed')::text              AS failed,
              count(*) FILTER (WHERE status = 'bounced')::text             AS bounced,
              count(*) FILTER (WHERE status = 'complained')::text          AS complained,
              count(*) FILTER (WHERE status = 'cancelled')::text           AS cancelled,
              count(*) FILTER (WHERE status = 'suppressed')::text          AS suppressed
         FROM message_queue WHERE tenant_id = $1 AND campaign_id = $2`,
      [tenantId, campaign.id],
    );

    const events = await query<EventCount>(
      deps.db,
      `SELECT event_type, count(*)::text AS total,
              count(DISTINCT contact_id)::text AS uniques
         FROM message_events
        WHERE tenant_id = $1 AND campaign_id = $2
        GROUP BY event_type`,
      [tenantId, campaign.id],
    );

    const byEvent = Object.fromEntries(
      events.map((e) => [e.event_type, { total: Number(e.total), uniqueContacts: Number(e.uniques) }]),
    );

    const clickable = await queryOne<{ n: string }>(
      deps.db,
      `SELECT count(DISTINCT q.id)::text AS n
         FROM message_queue q
         JOIN tracking_links tl ON tl.message_queue_id = q.id
        WHERE q.tenant_id = $1 AND q.campaign_id = $2 AND q.status = 'delivered'`,
      [tenantId, campaign.id],
    );

    const attributed = await queryOne<{ n: string }>(
      deps.db,
      `SELECT count(*)::text AS n FROM message_events
        WHERE tenant_id = $1 AND campaign_id = $2 AND event_type = 'converted'`,
      [tenantId, campaign.id],
    );

    const inputs: MetricInputs = {
      queued: Number(queue?.['queued'] ?? '0'),
      sent: Number(queue?.['sent'] ?? '0'),
      delivered: Number(queue?.['delivered'] ?? '0'),
      failed: Number(queue?.['failed'] ?? '0'),
      bounced: Number(queue?.['bounced'] ?? '0'),
      complained: Number(queue?.['complained'] ?? '0'),
      uniqueOpens: byEvent['opened']?.uniqueContacts ?? 0,
      uniqueClicks: byEvent['clicked']?.uniqueContacts ?? 0,
      unsubscribes: byEvent['unsubscribed']?.uniqueContacts ?? 0,
      // I12: only messages that actually contained something to click. A campaign
      // with no link in it must never sit in the denominator of a click rate, or
      // campaigns get graded on whether they happened to contain a link.
      clickableDelivered: Number(clickable?.n ?? '0'),
      attributedOrders: Number(attributed?.n ?? '0'),
    };

    return c.json({
      campaignId: campaign.id,
      status: campaign.status,
      channels: campaign.channels,
      counts: {
        ...Object.fromEntries(Object.entries(queue ?? {}).map(([k, v]) => [k, Number(v)])),
        clickableDelivered: inputs.clickableDelivered,
      },
      events: byEvent,
      rates: ratesFor(inputs, campaign.channels),
    });
  });

  app.get('/campaigns/:id/funnel', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));

    const enrolled = await queryOne<{ n: string }>(
      deps.db,
      `SELECT count(*)::text AS n FROM enrollments WHERE tenant_id = $1 AND campaign_id = $2`,
      [tenantId, campaign.id],
    );
    const queue = await queryOne<Record<string, string>>(
      deps.db,
      `SELECT count(*)::text AS queued,
              count(*) FILTER (WHERE sent_at IS NOT NULL)::text  AS sent,
              count(*) FILTER (WHERE status = 'delivered')::text AS delivered
         FROM message_queue WHERE tenant_id = $1 AND campaign_id = $2`,
      [tenantId, campaign.id],
    );
    const events = await query<EventCount>(
      deps.db,
      `SELECT event_type, count(*)::text AS total, count(DISTINCT contact_id)::text AS uniques
         FROM message_events
        WHERE tenant_id = $1 AND campaign_id = $2
          AND event_type IN ('opened','clicked','converted','unsubscribed')
        GROUP BY event_type`,
      [tenantId, campaign.id],
    );
    const byEvent = Object.fromEntries(events.map((e) => [e.event_type, Number(e.uniques)]));

    const stages = [
      { stage: 'enrolled', count: Number(enrolled?.n ?? '0'), unit: 'contacts' },
      { stage: 'queued', count: Number(queue?.['queued'] ?? '0'), unit: 'messages' },
      { stage: 'sent', count: Number(queue?.['sent'] ?? '0'), unit: 'messages' },
      { stage: 'delivered', count: Number(queue?.['delivered'] ?? '0'), unit: 'messages' },
      { stage: 'opened', count: byEvent['opened'] ?? 0, unit: 'contacts' },
      { stage: 'clicked', count: byEvent['clicked'] ?? 0, unit: 'contacts' },
      { stage: 'converted', count: byEvent['converted'] ?? 0, unit: 'contacts' },
    ];

    // The skip reasons are part of the funnel, not a footnote. "Where did the other
    // 4,000 go?" is the question a funnel that only counts successes cannot answer.
    const skips = await query<{ reason_code: string; n: string }>(
      deps.db,
      `SELECT reason_code, count(*)::text AS n FROM send_decisions
        WHERE tenant_id = $1 AND campaign_id = $2 AND decision = 'skip'
        GROUP BY reason_code ORDER BY count(*) DESC`,
      [tenantId, campaign.id],
    );

    return c.json({
      campaignId: campaign.id,
      stages,
      // Mixed units are labelled rather than silently summed: `enrolled` counts
      // people and `sent` counts messages, and a journey sends several messages per
      // person, so a "conversion rate" between the two is a category error.
      note: 'Stages count different units; see `unit` on each stage.',
      skipsByReason: skips.map((s) => ({ reasonCode: s.reason_code, count: Number(s.n) })),
      unsubscribes: byEvent['unsubscribed'] ?? 0,
    });
  });

  app.get('/campaigns/:id/messages/stats', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));

    const rows = await query<Record<string, unknown>>(
      deps.db,
      // COUNT(DISTINCT q.id) throughout, because the joins to `message_events` fan
      // each queue row out once per event. A plain count(q.id) here would report a
      // message opened five times as five sends.
      `SELECT cm.id, cm.sequence_order, cm.channel, cm.send_condition, cm.is_enabled,
              count(DISTINCT q.id)::text                                        AS queued,
              count(DISTINCT q.id) FILTER (WHERE q.sent_at IS NOT NULL)::text   AS sent,
              count(DISTINCT q.id) FILTER (WHERE q.status = 'delivered')::text  AS delivered,
              count(DISTINCT q.id) FILTER (WHERE q.status = 'cancelled')::text  AS cancelled,
              count(DISTINCT opened.contact_id)::text                           AS unique_opens,
              count(DISTINCT clicked.contact_id)::text                          AS unique_clicks
         FROM campaign_messages cm
         LEFT JOIN message_queue q
                ON q.campaign_message_id = cm.id AND q.tenant_id = $1
         LEFT JOIN message_events opened
                ON opened.message_queue_id = q.id AND opened.event_type = 'opened'
         LEFT JOIN message_events clicked
                ON clicked.message_queue_id = q.id AND clicked.event_type = 'clicked'
        WHERE cm.campaign_id = $2
        GROUP BY cm.id, cm.sequence_order, cm.channel, cm.send_condition, cm.is_enabled
        ORDER BY cm.sequence_order`,
      [tenantId, campaign.id],
    );

    return c.json({
      campaignId: campaign.id,
      messages: rows.map((row) => ({
        id: row['id'],
        sequenceOrder: row['sequence_order'],
        channel: row['channel'],
        sendCondition: row['send_condition'],
        isEnabled: row['is_enabled'],
        queued: Number(row['queued']),
        sent: Number(row['sent']),
        delivered: Number(row['delivered']),
        cancelled: Number(row['cancelled']),
        uniqueOpens: Number(row['unique_opens']),
        uniqueClicks: Number(row['unique_clicks']),
      })),
    });
  });

  app.get('/campaigns/:id/enrollments', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const { limit, offset } = pagination(c.req.query('limit'), c.req.query('offset'));
    const status = c.req.query('status');

    const rows = await query<Record<string, unknown>>(
      deps.db,
      `SELECT e.id, e.contact_id, e.campaign_version_id, e.anchor_type, e.anchor_id,
              e.status, e.stop_reason, e.enrolled_at, e.completed_at, e.stopped_at,
              ct.email::text AS contact_email
         FROM enrollments e
         JOIN contacts ct ON ct.id = e.contact_id
        WHERE e.tenant_id = $1 AND e.campaign_id = $2
          AND ($3::text IS NULL OR e.status = $3::text)
        ORDER BY e.enrolled_at DESC
        LIMIT $4 OFFSET $5`,
      [tenantId, campaign.id, status ?? null, limit, offset],
    );
    const total = await queryOne<{ n: string }>(
      deps.db,
      `SELECT count(*)::text AS n FROM enrollments
        WHERE tenant_id = $1 AND campaign_id = $2 AND ($3::text IS NULL OR status = $3::text)`,
      [tenantId, campaign.id, status ?? null],
    );

    return c.json({
      campaignId: campaign.id,
      enrollments: rows,
      page: { limit, offset, total: Number(total?.n ?? '0') },
    });
  });

  return app;
}
