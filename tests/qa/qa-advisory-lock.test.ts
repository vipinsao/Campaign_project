/**
 * H8 — advisory locks in job-runner.ts.
 *
 * `pg_try_advisory_lock` is taken on a DEDICATED pooled client and released in a
 * `finally` whose failure is swallowed by `.catch(() => undefined)` before the
 * connection goes back into the pool.
 *
 * Two distinct things to establish:
 *   (a) does a throwing `job.run` leak the lock? — no. The throw is caught by the
 *       INNER try/catch (which returns rather than rethrowing, contradicting the
 *       function's own doc comment), and the finally still runs. SAFE.
 *   (b) is the swallowed unlock failure a real hazard? — the mechanism is real: a
 *       session-level advisory lock survives `client.release()`, so a connection
 *       whose unlock failed is handed to the next caller still holding the lock,
 *       and every subsequent run of that job returns `skipped_locked` forever.
 *
 * And a third thing the hypothesis did not ask about, which is worse than either:
 *   (c) runJob holds one pool connection for the WHOLE run while `job.run` needs
 *       further connections from the SAME pool. The shared pool is created with
 *       `max: 10` and no `connectionTimeoutMillis`, so exhaustion is an unbounded
 *       wait, not an error.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { runJob, advisoryKey, type Job, type JobContext } from '@campaign/worker';
import { FakeClock } from '@campaign/core';
import type { Logger } from 'pino';

afterAll(closeTestDb);
beforeEach(resetDb);

const silentLog = {
  info: () => undefined,
  debug: () => undefined,
  error: () => undefined,
  warn: () => undefined,
} as unknown as Logger;

function ctxFor(db: Pool): JobContext {
  return { db, clock: new FakeClock('2026-06-15T12:00:00Z'), log: silentLog, workerId: 'qa' };
}

/** Ask an INDEPENDENT session whether the key is free. */
async function keyIsFree(name: string): Promise<boolean> {
  const probe = new Pool({ connectionString: process.env['DATABASE_URL']!, max: 1 });
  try {
    const { rows } = await probe.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [advisoryKey(name).toString()],
    );
    return rows[0]!.locked;
  } finally {
    await probe.end();
  }
}

describe('H8(a) — a throwing job does not leak the lock', () => {
  it('SAFE: runJob returns `failed` and the advisory key is free afterwards', async () => {
    const job: Job = {
      name: 'qa-throwing-job',
      schedule: '* * * * *',
      run: () => Promise.reject(new Error('boom')),
    };

    const outcome = await runJob(job, ctxFor(testDb()));
    expect(outcome.status).toBe('failed');
    expect(await keyIsFree('qa-throwing-job'), 'the lock was released').toBe(true);

    const { rows } = await testDb().query<{ status: string; error: string }>(
      `SELECT status, error FROM job_runs WHERE job_name = 'qa-throwing-job'`,
    );
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).toContain('boom');
  });

  it('OBSERVED: runJob does NOT rethrow, contrary to its own doc comment', async () => {
    const job: Job = {
      name: 'qa-throwing-job-2',
      schedule: '* * * * *',
      run: () => Promise.reject(new Error('boom')),
    };
    // "AN ERROR PATH THAT RECORDS BEFORE IT RETHROWS" — it records and returns.
    // Harmless here (the caller in index.ts inspects outcome.status), but the
    // comment is what a future maintainer will trust.
    await expect(runJob(job, ctxFor(testDb()))).resolves.toMatchObject({ status: 'failed' });
  });
});

describe('H8(b) — the swallowed unlock failure is a real hazard', () => {
  it('OBSERVED: a session advisory lock survives client.release() back into the pool', async () => {
    const url = process.env['DATABASE_URL']!;
    const pool = new Pool({ connectionString: url, max: 1 });
    const probe = new Pool({ connectionString: url, max: 1 });
    const key = advisoryKey('qa-leak-probe').toString();

    try {
      const client = await pool.connect();
      await client.query('SELECT pg_advisory_lock($1)', [key]);
      // This is exactly what job-runner.ts does when its unlock query fails and
      // the `.catch(() => undefined)` eats the error.
      client.release();

      const { rows } = await probe.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [key],
      );
      expect(
        rows[0]!.locked,
        'the connection went back into the pool still holding the lock; the next ' +
          'caller to be handed it inherits it, and every later run of that job ' +
          'records skipped_locked forever with no error anywhere',
      ).toBe(false);

      // And it is still held by a live backend, not a dead one.
      const { rows: held } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`,
      );
      expect(Number(held[0]!.n)).toBeGreaterThan(0);
    } finally {
      await pool.end();
      await probe.end();
    }
  });
});

describe('H8(c) — runJob needs at least two connections from the pool it is handed', () => {
  const singleJob: Job = {
    name: 'qa-pool-single',
    schedule: '* * * * *',
    run: () => Promise.resolve({ counts: { did: 1 } }),
  };

  it('OBSERVED: runJob cannot complete on a one-connection pool, even for a job that does nothing', async () => {
    const pool = new Pool({
      connectionString: process.env['DATABASE_URL']!,
      max: 1,
      // The real pool (packages/core/src/db/pool.ts) sets NO connectionTimeoutMillis,
      // so in production this wait is UNBOUNDED — the job hangs rather than erroring,
      // and its job_runs row is never even written. A timeout is used here only so
      // the test can observe the deadlock instead of hanging.
      connectionTimeoutMillis: 2_000,
    });

    try {
      // runJob checks out a dedicated client for the session advisory lock and
      // holds it for the whole run, then writes its job_runs bookkeeping through
      // ctx.db — the same pool. Two connections, minimum, per in-flight job.
      await expect(runJob(singleJob, ctxFor(pool))).rejects.toThrow(/timeout/i);

      const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM job_runs`);
      expect(Number(rows[0]!.n), 'not even a job_runs row was written').toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('SHOULD: one job needs one connection', async () => {
    const pool = new Pool({
      connectionString: process.env['DATABASE_URL']!,
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    try {
      const outcome = await runJob(singleJob, ctxFor(pool)).catch((e: unknown) => ({
        status: `threw: ${String(e)}`,
      }));
      expect(
        outcome.status,
        'the worker fires four jobs on the same quarter-hour boundary (process-queue, ' +
          'reclaim-stale, delivery-anchors, rollups) against a shared pool of 10 that ' +
          'delivery ALSO draws from — claimBatch opens a transaction, so a batch in ' +
          'flight holds one too. Four jobs need eight before any work starts. When it ' +
          'runs out the pool waits forever, and the only symptom is job_runs rows ' +
          'stuck in `running` (or missing entirely)',
      ).toBe('ok');
    } finally {
      await pool.end();
    }
  });
});
