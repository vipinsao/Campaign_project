/**
 * The worker process.
 *
 * The only process in this system that schedules anything. The API process is
 * structurally forbidden from it — see packages/api/src/no-scheduler.ts — because
 * three API replicas would mean every job firing three times, and because a long
 * job in the request-serving process blocks the health check until the platform
 * restarts the container mid-run.
 *
 * This process runs as a SINGLE instance by convention, and does not depend on
 * that convention holding: every job takes a Postgres advisory lock, so a second
 * replica skips rather than duplicates. The convention is an optimisation; the lock
 * is the guarantee.
 */
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import pino from 'pino';
import { SystemClock, getPool, closePool, type DeliveryDeps, type SendMode } from '@campaign/core';
import { MockProvider, classify, nextAttemptDelayMs, resolveProvider } from '@campaign/providers';
import type { Channel, MessageProvider } from '@campaign/shared';
import { runJob, type Job, type JobContext } from './job-runner.ts';
import { buildJobs, type WorkerConfig } from './jobs/index.ts';

const log = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'campaign-worker' },
});

function parseSendMode(raw: string | undefined): SendMode {
  // Anything unrecognised is `off`. A typo in SEND_MODE must fail CLOSED (I2):
  // refusing to send because the config is unreadable is recoverable, and sending
  // because it was unreadable is not.
  return raw === 'live' || raw === 'mock' ? raw : 'off';
}

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function buildWorkerConfig(): WorkerConfig {
  const sendMode = parseSendMode(process.env['SEND_MODE']);
  const clock = new SystemClock();
  const db = getPool();

  // The mock providers are constructed once and reused, because their pending
  // webhook queue is in-process state: rebuilding them per job would drop the
  // simulated receipts that have not yet come due.
  const mockEmail = new MockProvider('email', { db, clock });
  const mockSms = new MockProvider('sms', { db, clock });

  const providerFor = (channel: Channel, provider: string): MessageProvider => {
    if (provider === 'mock' || sendMode === 'mock') {
      return channel === 'email' ? mockEmail : mockSms;
    }
    return resolveProvider(channel, provider, { db, clock });
  };

  const deliveryDeps = (ctx: JobContext): DeliveryDeps => ({
    db: ctx.db,
    clock: ctx.clock,
    sendMode,
    workerId: ctx.workerId,
    batchSize: intFromEnv('QUEUE_BATCH_SIZE', 100),
    resolveProvider: providerFor,
    resolveSender: async (tenantId, channel) => {
      // I11: iterate every ACTIVE credential rather than taking a single row. A
      // tenant legitimately holds several senders per channel, and `.single()`
      // here is the bug that rejects every provider callback the day a second one
      // is added.
      const { rows } = await ctx.db.query<{ provider: string; from_address: string }>(
        `SELECT provider, from_address FROM provider_credentials
          WHERE tenant_id = $1 AND channel = $2 AND is_active
          ORDER BY created_at
          LIMIT 1`,
        [tenantId, channel],
      );
      const configured = rows[0];
      if (configured)
        return { provider: configured.provider, fromAddress: configured.from_address };

      // No credential row at all. In mock mode that is the normal state for the
      // seeded demo, so fall back rather than refusing to send anything; in live
      // mode there is nothing to fall back to and the gate chain records the skip.
      if (sendMode === 'mock') {
        return { provider: 'mock', fromAddress: process.env['MOCK_FROM'] ?? 'demo@example.com' };
      }
      return undefined;
    },
    classifyError: (provider, code) => {
      const classification = classify(provider, code);
      return { class: classification.class, maxAttempts: classification.maxAttempts };
    },
    backoffMs: (attempts) => nextAttemptDelayMs(attempts, Math.random),
    maxAttempts: intFromEnv('MAX_ATTEMPTS', 5),
  });

  const floorRaw = process.env['TRIGGER_FLOOR_AT'];
  const floor = floorRaw ? new Date(floorRaw) : null;
  if (floorRaw && Number.isNaN(floor?.getTime())) {
    // A malformed floor is more dangerous than a missing one: it could parse as
    // an epoch date and admit the entire history of the database.
    throw new Error(
      `TRIGGER_FLOOR_AT is set to '${floorRaw}', which is not a valid ISO instant. ` +
        `Refusing to start rather than guessing at a cutoff.`,
    );
  }

  return {
    deliveryDeps,
    publicBaseUrl: (process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000').replace(/\/+$/, ''),
    staleClaimMinutes: intFromEnv('STALE_CLAIM_MINUTES', 15),
    maxAttempts: intFromEnv('MAX_ATTEMPTS', 5),
    triggerFloorAt: floor,
    maxEnrolmentsPerRun: intFromEnv('MAX_ENROLMENTS_PER_RUN', 500),
    triggerDryRun: process.env['TRIGGER_DRY_RUN'] === 'true',
    deliveryAnchorMaxWaitDays: intFromEnv('DELIVERY_ANCHOR_MAX_WAIT_DAYS', 60),
  };
}

export function startWorker(): () => Promise<void> {
  const clock = new SystemClock();
  const db = getPool();
  const workerId = process.env['WORKER_ID'] ?? `worker-${process.pid}`;
  const sendMode = parseSendMode(process.env['SEND_MODE']);

  const jobs = buildJobs(buildWorkerConfig());
  const ctx: JobContext = { db, clock, log, workerId };

  log.info(
    { workerId, sendMode, jobs: jobs.map((j) => j.name) },
    sendMode === 'off'
      ? 'worker started in SEND_MODE=off: it will claim nothing and send nothing'
      : 'worker started',
  );

  const tasks = jobs.map((job: Job) =>
    cron.schedule(job.schedule, () => {
      // Deliberately not awaited: node-cron does not serialise overlapping runs,
      // and the advisory lock inside runJob is what prevents a slow run from
      // colliding with the next tick. Rejections cannot escape because runJob
      // records and returns rather than throwing.
      void runJob(job, ctx).then((outcome) => {
        if (outcome.status === 'failed') {
          log.error({ job: job.name, err: outcome.error }, 'scheduled job failed');
        }
      });
    }),
  );

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.info({ workerId }, 'worker shutting down');
    for (const task of tasks) await task.stop();
    // Rows this worker has claimed are left in `processing` on purpose. They are
    // recovered by reclaim-stale rather than force-released here: a release path
    // that races a send in flight is how the same message goes out twice.
    await closePool();
  };

  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));

  return shutdown;
}

/**
 * Run every job once and exit.
 *
 * The scheduled worker is a long-running process, which on most free hosting tiers
 * is the one thing you cannot have. This mode lets an external scheduler — a
 * GitHub Actions cron, a platform cron job, an operator at a terminal — drive the
 * same jobs, in the same order, through the same `runJob` and therefore the same
 * advisory lock.
 *
 * It is a different TRIGGER, not a different code path. Nothing here reimplements
 * a job, and nothing skips a gate: the sends still go out through
 * `deliverClaimed`, which is still the only call site of `provider.send` (I1).
 *
 * Returns the number of jobs that failed, so a caller can exit non-zero and a red
 * cron run means something.
 */
export async function runAllJobsOnce(): Promise<number> {
  const clock = new SystemClock();
  const db = getPool();
  const workerId = process.env['WORKER_ID'] ?? `once-${process.pid}`;
  const sendMode = parseSendMode(process.env['SEND_MODE']);

  const jobs = buildJobs(buildWorkerConfig());
  const ctx: JobContext = { db, clock, log, workerId };
  log.info({ workerId, sendMode, jobs: jobs.map((j) => j.name) }, 'running every job once');

  let failed = 0;
  try {
    for (const job of jobs) {
      const outcome = await runJob(job, ctx);
      if (outcome.status === 'failed') {
        failed++;
        log.error({ job: job.name, err: outcome.error }, 'job failed');
      } else {
        log.info({ job: job.name, status: outcome.status }, 'job finished');
      }
    }
  } finally {
    await closePool();
  }
  return failed;
}

export { runJob, advisoryKey } from './job-runner.ts';
export { buildJobs } from './jobs/index.ts';
export type { Job, JobContext, JobResult, RunOutcome } from './job-runner.ts';
export type { WorkerConfig } from './jobs/index.ts';
export { rebuildRollups } from './jobs/rollups.ts';

// Only start when executed directly, so tests can import the builders without
// scheduling anything.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--once')) {
    const failed = await runAllJobsOnce();
    process.exit(failed > 0 ? 1 : 0);
  } else {
    startWorker();
  }
}
