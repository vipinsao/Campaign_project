import type { Pool, PoolClient } from 'pg';

/**
 * Rebuilding `campaign_daily_stats` from `message_events`.
 *
 * The rollup is DERIVED. It can be dropped entirely and rebuilt from the event
 * store, and a test asserts the rebuild is byte-identical to what the incremental
 * job produced. That property is the whole reason analytics are event-sourced
 * here rather than maintained as counters.
 *
 * Counters incremented in-line by the sender drift, and the ways they drift are
 * all mundane: a crash between the send and the increment, a retry that increments
 * twice, a backfill that increments none, a deploy that changes which code path
 * does the incrementing. Once a counter has drifted there is no way to recover the
 * truth, because the evidence was never written down. Here the events ARE the
 * evidence, and the aggregate is disposable.
 *
 * Note what this function does NOT compute: any rate. Rates are defined once, in
 * `core/metrics/denominators.ts`, and computed at read time from these counts.
 * A rate stored in a rollup is a rate that can disagree with its own definition.
 */

export type RebuildRange = { readonly from: Date; readonly to: Date };

export type RebuildResult = { readonly days: number; readonly rows: number };

/**
 * Rebuild every (campaign, day, channel) tuple touched by events in the range.
 *
 * Deleting and reinserting the range, rather than upserting each counter, is
 * deliberate: an upsert leaves stale rows behind for tuples whose events were
 * later deleted or re-attributed, and those stale rows are indistinguishable from
 * real ones. Rebuilding a range means the range is correct, not merely updated.
 */
export async function rebuildRollups(
  db: Pool | PoolClient,
  range: RebuildRange,
): Promise<RebuildResult> {
  const from = startOfUtcDay(range.from);
  const to = startOfUtcDay(range.to);

  await db.query(
    `DELETE FROM campaign_daily_stats
      WHERE day >= $1::date AND day <= $2::date`,
    [from, to],
  );

  const { rows } = await db.query<{ inserted: string }>(
    `
    WITH scoped AS (
      SELECT e.tenant_id,
             e.campaign_id,
             (e.occurred_at AT TIME ZONE 'UTC')::date AS day,
             e.channel,
             e.event_type,
             e.contact_id,
             e.message_queue_id
        FROM message_events e
       WHERE e.campaign_id IS NOT NULL
         AND e.channel IS NOT NULL
         AND e.occurred_at >= $1::date
         AND e.occurred_at < ($2::date + interval '1 day')
    ),
    counted AS (
      SELECT tenant_id, campaign_id, day, channel,
             count(*) FILTER (WHERE event_type = 'queued')     AS queued,
             count(*) FILTER (WHERE event_type = 'sent')       AS sent,
             count(*) FILTER (WHERE event_type = 'delivered')  AS delivered,
             count(*) FILTER (WHERE event_type = 'failed')     AS failed,
             count(*) FILTER (WHERE event_type = 'bounced')    AS bounced,
             count(*) FILTER (WHERE event_type = 'complained') AS complained,
             count(*) FILTER (WHERE event_type = 'unsubscribed') AS unsubscribes,
             count(*) FILTER (WHERE event_type = 'opened')     AS total_opens,
             count(*) FILTER (WHERE event_type = 'clicked')    AS total_clicks,
             -- "Unique" here means unique per contact PER DAY, which is what a
             -- daily grain can express. Summing this across a range is NOT a
             -- range-unique count, and denominators.ts says so in the tooltip;
             -- range queries count distinct contacts from the events directly.
             count(DISTINCT contact_id) FILTER (WHERE event_type = 'opened')  AS unique_opens,
             count(DISTINCT contact_id) FILTER (WHERE event_type = 'clicked') AS unique_clicks,
             count(*) FILTER (WHERE event_type = 'converted')  AS attributed_orders
        FROM scoped
       GROUP BY tenant_id, campaign_id, day, channel
    ),
    clickable AS (
      -- Delivered messages whose rendered body actually contained something to
      -- click. This is the denominator of click rate (I12): a message with no
      -- link must never sit in it, or campaigns get graded on whether they
      -- happened to contain a link at all.
      SELECT e.campaign_id,
             (e.occurred_at AT TIME ZONE 'UTC')::date AS day,
             e.channel,
             count(DISTINCT e.message_queue_id) AS clickable_delivered
        FROM message_events e
        JOIN message_queue q ON q.id = e.message_queue_id
       WHERE e.event_type = 'delivered'
         AND e.campaign_id IS NOT NULL
         AND e.channel IS NOT NULL
         AND e.occurred_at >= $1::date
         AND e.occurred_at < ($2::date + interval '1 day')
         AND EXISTS (SELECT 1 FROM tracking_links tl WHERE tl.message_queue_id = q.id)
       GROUP BY e.campaign_id, day, e.channel
    ),
    inserted AS (
      INSERT INTO campaign_daily_stats
        (tenant_id, campaign_id, day, channel, queued, sent, delivered, failed, bounced,
         complained, unique_opens, total_opens, unique_clicks, total_clicks, unsubscribes,
         clickable_delivered, attributed_orders, rebuilt_at)
      SELECT c.tenant_id, c.campaign_id, c.day, c.channel,
             c.queued, c.sent, c.delivered, c.failed, c.bounced, c.complained,
             c.unique_opens, c.total_opens, c.unique_clicks, c.total_clicks, c.unsubscribes,
             COALESCE(k.clickable_delivered, 0),
             c.attributed_orders,
             -- Constant, not now(): a rebuild must be byte-identical to the
             -- incremental result, and a wall-clock stamp would make every
             -- comparison fail for a reason that has nothing to do with the data.
             '2000-01-01T00:00:00Z'::timestamptz
        FROM counted c
        LEFT JOIN clickable k
               ON k.campaign_id = c.campaign_id AND k.day = c.day AND k.channel = c.channel
      RETURNING 1
    )
    SELECT count(*)::text AS inserted FROM inserted
    `,
    [from, to],
  );

  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  return { days, rows: Number(rows[0]?.inserted ?? '0') };
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
