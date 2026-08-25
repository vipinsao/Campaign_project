import { Hono } from 'hono';
import { query, queryOne } from '@campaign/core';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { tenantOf } from '../middleware/context.ts';
import { notFound } from '../errors.ts';
import { pagination } from './campaigns.ts';

/**
 * Three endpoints the operator UI needs and nothing else provides.
 *
 * Each was built because a page was rendering an honest "this endpoint does not
 * exist" panel rather than inventing the data — which is the correct behaviour for
 * the page, and a bug report for the API.
 */
export function operationsRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * Tenant settings.
   *
   * The quiet-hours floor, the default timezone and the frequency cap are read by
   * the scheduler on every send and were exposed by nothing. Without them the
   * Schedule tab's timezone preview could only reason about the campaign window,
   * and therefore could not show the one thing that matters: that campaign
   * configuration NARROWS the tenant floor and can never widen it.
   */
  app.get('/tenant', async (c) => {
    const tenantId = tenantOf(c);
    const tenant = await queryOne<Record<string, unknown>>(
      deps.db,
      `SELECT id, name, default_timezone,
              to_char(quiet_hours_start,'HH24:MI') AS quiet_hours_start,
              to_char(quiet_hours_end,'HH24:MI')   AS quiet_hours_end,
              freq_cap_count, freq_cap_window::text AS freq_cap_window,
              confidence_threshold, auto_send, monthly_token_budget, created_at
         FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (!tenant) throw notFound('tenant', tenantId);
    return c.json({ tenant });
  });

  /**
   * The mock provider's outbox.
   *
   * `mock_outbox` is written on every simulated send and was read by nothing, so
   * the whole point of the mock being a first-class citizen — a reviewer watching
   * the complete lifecycle with no credentials — stopped at the database.
   *
   * Gated on SEND_MODE: in a live deployment this would expose message bodies to
   * anyone with an operator login, and the mock outbox has no reason to exist
   * there anyway.
   */
  app.get('/mock-outbox', async (c) => {
    const tenantId = tenantOf(c);
    if (deps.sendMode === 'live') {
      return c.json({
        messages: [],
        available: false,
        reason: 'SEND_MODE is live; there is no mock outbox.',
      });
    }

    const { limit, offset } = pagination(c.req.query('limit'), c.req.query('offset'));
    const channel = c.req.query('channel');

    const messages = await query<Record<string, unknown>>(
      deps.db,
      `SELECT o.id, o.channel, o.to_address, o.from_address, o.subject, o.body, o.html,
              o.provider_message_id, o.simulated_outcome, o.sent_at,
              o.message_queue_id, q.status AS queue_status, q.delivered_at,
              c.name AS campaign_name
         FROM mock_outbox o
         LEFT JOIN message_queue q ON q.id = o.message_queue_id
         LEFT JOIN campaigns c     ON c.id = q.campaign_id
        WHERE o.tenant_id = $1
          AND ($2::text IS NULL OR o.channel = $2::text)
        ORDER BY o.sent_at DESC, o.id
        LIMIT $3 OFFSET $4`,
      [tenantId, channel ?? null, limit, offset],
    );

    const counts = await queryOne<{ total: string; email: string; sms: string }>(
      deps.db,
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE channel = 'email')::text AS email,
              count(*) FILTER (WHERE channel = 'sms')::text   AS sms
         FROM mock_outbox WHERE tenant_id = $1`,
      [tenantId],
    );

    return c.json({
      messages,
      available: true,
      counts: {
        total: Number(counts?.total ?? 0),
        email: Number(counts?.email ?? 0),
        sms: Number(counts?.sms ?? 0),
      },
      page: { limit, offset },
    });
  });

  /**
   * The daily series, straight off the rollup.
   *
   * Counts only — no rates. Rates are defined once in core's `denominators.ts` and
   * computed at read time from these counts, so that a number on a chart cannot
   * disagree with the same number in a table.
   *
   * `unique_opens` here is unique per contact PER DAY, which is what a daily grain
   * can express. Summing it across the range would not be a range-unique count, so
   * the range totals are computed separately from the events, and the response
   * labels both.
   */
  app.get('/campaigns/:id/timeseries', async (c) => {
    const tenantId = tenantOf(c);
    const campaignId = c.req.param('id');

    const campaign = await queryOne<{ id: string }>(
      deps.db,
      `SELECT id FROM campaigns WHERE id = $1 AND tenant_id = $2`,
      [campaignId, tenantId],
    );
    if (!campaign) throw notFound('campaign', campaignId);

    const from = c.req.query('from') ?? null;
    const to = c.req.query('to') ?? null;

    const series = await query<Record<string, unknown>>(
      deps.db,
      `SELECT day, channel, queued, sent, delivered, failed, bounced, complained,
              unique_opens, total_opens, unique_clicks, total_clicks, unsubscribes,
              clickable_delivered, attributed_orders, attributed_revenue
         FROM campaign_daily_stats
        WHERE campaign_id = $1
          AND ($2::date IS NULL OR day >= $2::date)
          AND ($3::date IS NULL OR day <= $3::date)
        ORDER BY day, channel`,
      [campaignId, from, to],
    );

    // Range-unique counts, computed from the events rather than by summing the
    // daily uniques. A contact who opened on Monday and again on Tuesday is one
    // unique opener across the range and two across the daily rows.
    const ranged = await queryOne<{ unique_openers: string; unique_clickers: string }>(
      deps.db,
      `SELECT count(DISTINCT contact_id) FILTER (WHERE event_type = 'opened')::text  AS unique_openers,
              count(DISTINCT contact_id) FILTER (WHERE event_type = 'clicked')::text AS unique_clickers
         FROM message_events
        WHERE campaign_id = $1
          AND ($2::date IS NULL OR occurred_at >= $2::date)
          AND ($3::date IS NULL OR occurred_at < ($3::date + interval '1 day'))`,
      [campaignId, from, to],
    );

    return c.json({
      series,
      grain: 'day',
      notes: {
        uniqueOpens:
          'unique_opens in each row is unique per contact per day. Summing the ' +
          'column across the range is not a range-unique count; use rangeUnique.',
      },
      rangeUnique: {
        openers: Number(ranged?.unique_openers ?? 0),
        clickers: Number(ranged?.unique_clickers ?? 0),
      },
    });
  });

  return app;
}
