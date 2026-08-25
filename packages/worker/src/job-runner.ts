import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Clock } from '@campaign/core';

/**
 * The job runner.
 *
 * Every scheduled job in this system goes through here, and gets four things it
 * would otherwise be trusted to remember:
 *
 *  1. A POSTGRES ADVISORY LOCK, so a second worker replica does not double-run it.
 *     Scaling the worker to two instances must not mean every campaign fires
 *     twice, and "we only run one replica" is an operational assumption that
 *     survives exactly until the first autoscaling event.
 *
 *  2. A `job_runs` ROW, recording outcome, duration and counts. A job that fails
 *     silently is worse than a job that does not exist: the second is noticed.
 *
 *  3. A STRUCTURED START AND FINISH LOG with the counts it chose to report, so a
 *     "did anything happen?" question is answerable from logs alone.
 *
 *  4. AN ERROR PATH THAT RECORDS BEFORE IT RETHROWS. An exception that escapes
 *     without leaving a row behind is a job whose failure is only visible in a
 *     platform log that may have rotated away by the time anyone looks.
 */

export type JobContext = {
  readonly db: Pool;
  readonly clock: Clock;
  readonly log: Logger;
  readonly workerId: string;
};

export type JobResult = {
  /** Whatever the job wants to be able to answer later. Recorded verbatim. */
  readonly counts: Record<string, number | string | boolean | null>;
};

export type Job = {
  readonly name: string;
  /** node-cron expression. */
  readonly schedule: string;
  run(ctx: JobContext): Promise<JobResult>;
};

/**
 * A stable 64-bit key per job name, for `pg_try_advisory_lock`.
 *
 * Advisory locks are keyed by integer, not by string, so the name has to be
 * hashed. Collisions between two job names would mean one silently never runs
 * while the other holds the lock — so the hash is wide and the job names are
 * few and fixed.
 */
export function advisoryKey(jobName: string): bigint {
  // FNV-1a, 64-bit.
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(jobName, 'utf8')) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  // Postgres advisory locks take a signed bigint.
  return BigInt.asIntN(64, hash);
}

export type RunOutcome =
  | { readonly status: 'ok'; readonly counts: JobResult['counts']; readonly durationMs: number }
  | { readonly status: 'skipped_locked' }
  | { readonly status: 'failed'; readonly error: Error; readonly durationMs: number };

export async function runJob(job: Job, ctx: JobContext): Promise<RunOutcome> {
  const { db, clock, log, workerId } = ctx;
  const key = advisoryKey(job.name);

  // A dedicated connection: a session-level advisory lock belongs to the session
  // that took it, so it must be released on the same connection, and a pooled
  // query could otherwise release it from a different one.
  const client = await db.connect();

  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key.toString()],
    );

    if (!rows[0]?.locked) {
      // Another replica is already running this job. Normal, and worth recording:
      // a job that is ALWAYS skipped_locked means one replica is wedged holding it.
      log.debug({ job: job.name, workerId }, 'job skipped: another worker holds the lock');
      await db.query(
        `INSERT INTO job_runs (job_name, worker_id, status, started_at, finished_at, duration_ms)
         VALUES ($1,$2,'skipped_locked',$3,$3,0)`,
        [job.name, workerId, clock.now()],
      );
      return { status: 'skipped_locked' };
    }

    const startedAt = clock.now();
    const startedHr = process.hrtime.bigint();
    log.info({ job: job.name, workerId }, 'job started');

    const { rows: started } = await db.query<{ id: string }>(
      `INSERT INTO job_runs (job_name, worker_id, status, started_at)
       VALUES ($1,$2,'running',$3) RETURNING id`,
      [job.name, workerId, startedAt],
    );
    const runId = started[0]?.id;

    try {
      const result = await job.run(ctx);
      const durationMs = Number((process.hrtime.bigint() - startedHr) / 1_000_000n);

      await db.query(
        `UPDATE job_runs
            SET status='ok', finished_at=$2, duration_ms=$3, counts=$4
          WHERE id=$1`,
        [runId, clock.now(), durationMs, JSON.stringify(result.counts)],
      );
      log.info({ job: job.name, workerId, durationMs, ...result.counts }, 'job finished');
      return { status: 'ok', counts: result.counts, durationMs };
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const durationMs = Number((process.hrtime.bigint() - startedHr) / 1_000_000n);

      // Recorded BEFORE rethrowing. An exception that escapes without leaving a
      // row behind is a failure visible only in a platform log that may have
      // rotated away by the time anybody looks for it.
      await db.query(
        `UPDATE job_runs
            SET status='failed', finished_at=$2, duration_ms=$3, error=$4
          WHERE id=$1`,
        [runId, clock.now(), durationMs, `${error.name}: ${error.message}\n${error.stack ?? ''}`],
      );
      log.error({ job: job.name, workerId, durationMs, err: error }, 'job failed');
      return { status: 'failed', error, durationMs };
    }
  } finally {
    // Release on the same session that took it, then hand the connection back.
    await client.query('SELECT pg_advisory_unlock($1)', [key.toString()]).catch(() => undefined);
    client.release();
  }
}
