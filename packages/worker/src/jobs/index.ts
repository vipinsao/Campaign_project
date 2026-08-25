import {
  processQueue,
  reclaimStale,
  runTimeTriggers,
  evaluateStopConditions,
  type DeliveryDeps,
} from '@campaign/core';
import type { Job, JobContext } from '../job-runner.ts';
import { rebuildRollups } from './rollups.ts';

/**
 * Every scheduled job in the system.
 *
 * All of them live on the WORKER process. The API process is structurally
 * forbidden from registering a scheduler, for three reasons recorded in
 * docs/ARCHITECTURE.md: a scheduler competes with request handling for the event
 * loop; it multiplies per replica, so three API replicas means every job firing
 * three times; and a long job blocks the health check until the platform restarts
 * the container mid-run.
 */

export type WorkerConfig = {
  readonly deliveryDeps: (ctx: JobContext) => DeliveryDeps;
  readonly publicBaseUrl: string;
  readonly staleClaimMinutes: number;
  readonly maxAttempts: number;
  readonly triggerFloorAt: Date | null;
  readonly maxEnrolmentsPerRun: number;
  readonly triggerDryRun: boolean;
  readonly deliveryAnchorMaxWaitDays: number;
};

export function buildJobs(config: WorkerConfig): Job[] {
  return [
    {
      name: 'process-queue',
      schedule: '*/1 * * * *',
      async run(ctx) {
        const summary = await processQueue(config.deliveryDeps(ctx));
        return {
          counts: {
            claimed: summary.claimed,
            sent: summary.sent,
            failed: summary.failed,
            deferred: summary.deferred,
            skipped: summary.skipped,
            // Surfaced rather than swallowed: a worker that refuses on every run
            // is a misconfiguration, and it should be visible as one.
            refusedWithoutClaim: summary.refusedWithoutClaim,
          },
        };
      },
    },

    {
      name: 'reclaim-stale',
      schedule: '*/5 * * * *',
      async run(ctx) {
        // Rows whose worker died mid-send. Without this they sit in `processing`
        // with no owner forever, and the symptom is a queue that looks like it is
        // draining while a growing tail silently never sends.
        const result = await reclaimStale(ctx.db, {
          staleMinutes: config.staleClaimMinutes,
          maxAttempts: config.maxAttempts,
          clock: ctx.clock,
        });
        return { counts: { reclaimed: result.reclaimed, exhausted: result.exhausted } };
      },
    },

    {
      name: 'time-triggers',
      schedule: '0 * * * *',
      async run(ctx) {
        const run = await runTimeTriggers({
          db: ctx.db,
          clock: ctx.clock,
          publicBaseUrl: config.publicBaseUrl,
          triggerFloorAt: config.triggerFloorAt,
          maxEnrolmentsPerRun: config.maxEnrolmentsPerRun,
          dryRun: config.triggerDryRun,
        });
        return {
          counts: {
            campaigns: run.campaignsEvaluated,
            candidates: run.candidates,
            enrolled: run.enrolled,
            queued: run.queued,
            refused: run.refused,
          },
        };
      },
    },

    {
      name: 'delivery-anchors',
      schedule: '*/15 * * * *',
      async run(ctx) {
        // Messages anchored to 'delivery' were parked at 'infinity' because their
        // send time was unknowable at enrolment. Now that the order has been
        // delivered, rewrite scheduled_at for exactly those rows.
        const { rows } = await ctx.db.query<{ id: string }>(
          `UPDATE message_queue q
              SET scheduled_at = o.delivered_at + (cm.delay_minutes * interval '1 minute'),
                  updated_at = $1
             FROM orders o, campaign_messages cm
            WHERE q.order_id = o.id
              AND cm.id = q.campaign_message_id
              AND cm.delay_anchor = 'delivery'
              AND q.status = 'pending'
              AND q.scheduled_at = 'infinity'
              AND o.delivered_at IS NOT NULL
            RETURNING q.id`,
          [ctx.clock.now()],
        );
        return { counts: { resolved: rows.length } };
      },
    },

    {
      name: 'expire-anchors',
      schedule: '0 3 * * *',
      async run(ctx) {
        // The interesting half of delivery anchoring: an order that is never
        // delivered leaves its messages parked forever. Unbounded pending state is
        // a leak, and a leak in a message queue eventually becomes a mass send the
        // day somebody "fixes" the anchor.
        const cutoff = new Date(
          ctx.clock.now().getTime() - config.deliveryAnchorMaxWaitDays * 86_400_000,
        );
        const { rows } = await ctx.db.query<{ id: string }>(
          `UPDATE message_queue
              SET status = 'cancelled',
                  provider_error_code = 'delivery_anchor_expired',
                  updated_at = $1
            WHERE status = 'pending'
              AND scheduled_at = 'infinity'
              AND created_at < $2
            RETURNING id`,
          [ctx.clock.now(), cutoff],
        );
        return { counts: { expired: rows.length, cutoff: cutoff.toISOString() } };
      },
    },

    {
      name: 'stop-conditions',
      schedule: '*/10 * * * *',
      async run(ctx) {
        const result = await evaluateStopConditions({ db: ctx.db, clock: ctx.clock });
        return { counts: { stopped: result.stopped, cancelled: result.cancelled } };
      },
    },

    {
      name: 'rollups',
      schedule: '*/15 * * * *',
      async run(ctx) {
        // Only the last three days, because that is where late-arriving events
        // land. A full rebuild is `npm run rollups:rebuild` and is deliberately a
        // separate, explicit command.
        const from = new Date(ctx.clock.now().getTime() - 3 * 86_400_000);
        const result = await rebuildRollups(ctx.db, { from, to: ctx.clock.now() });
        return { counts: { days: result.days, rows: result.rows } };
      },
    },

    {
      name: 'suppression-expiry',
      schedule: '30 3 * * *',
      async run(ctx) {
        // Housekeeping only. The send-time gate evaluates expiry itself, so a
        // failure here delays nothing and blocks nobody - which is the correct
        // relationship between a nightly sweep and a correctness guarantee.
        const { rows } = await ctx.db.query<{ id: string }>(
          `DELETE FROM suppressions
            WHERE expires_at IS NOT NULL AND expires_at <= $1
            RETURNING id`,
          [ctx.clock.now()],
        );
        return { counts: { expired: rows.length } };
      },
    },
  ];
}
