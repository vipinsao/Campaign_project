import type { Channel } from '@campaign/shared';
import type { Clock, Db } from './deps.ts';

/**
 * A token bucket that lives in Postgres.
 *
 * The limiter is in the database because it has to hold ACROSS PROCESSES. An
 * in-process counter is correct on one worker and wrong on two: run a second
 * replica and the system enforces exactly twice the configured limit, quietly.
 * The symptom is provider throttling, which reads as the provider's fault, gets
 * escalated to the provider, and is diagnosed a week later by somebody who
 * notices the deploy that added a replica. Putting the counter where every worker
 * already agrees about state removes the failure mode instead of documenting it.
 *
 * The bucket is a bucket rather than a fixed window because a fixed window admits
 * twice the limit across a boundary -- the whole allowance at 09:59:59 and the
 * whole allowance again at 10:00:00 -- which is the burst the provider is
 * throttling us to prevent.
 */

export type RateLimitConfig = {
  readonly tenantId: string;
  readonly provider: string;
  readonly channel: Channel;
  /** The burst allowance: how many sends may happen back to back from a full bucket. */
  readonly capacity: number;
  /** The sustained rate, in sends per second. */
  readonly refillPerSecond: number;
};

export type RateLimitDecision = {
  readonly allowed: boolean;
  /** Set only when denied: how long until one token exists. */
  readonly retryAfterMs?: number;
};

/**
 * Attempt to take one token.
 *
 * Time comes from the injected clock and is passed into the statement rather than
 * read with `now()`. The refill is an integral over elapsed time, so the limiter
 * has to measure elapsed time on the same timeline as everything else in the
 * system; a simulation that fast-forwards three days would otherwise refill by
 * three days of database wall clock in the middle of a run that thinks it took a
 * second.
 */
export async function tryAcquire(
  db: Db,
  config: RateLimitConfig,
  clock: Clock,
): Promise<RateLimitDecision> {
  if (config.capacity <= 0 || config.refillPerSecond <= 0) {
    // The table's CHECK constraint says the same thing, but reaching it would mean
    // a failed INSERT on the hot path rather than a clear message here.
    throw new Error(
      `Rate limit for ${config.provider}/${config.channel} must have a positive capacity and ` +
        `refill rate; got capacity=${config.capacity}, refillPerSecond=${config.refillPerSecond}.`,
    );
  }

  const now = clock.now();

  // Ensure the bucket exists. This is idempotent and separate from the decision
  // below on purpose: two workers racing to create the same bucket are resolved by
  // the primary key, and neither outcome affects the accounting. Folding it into
  // the decision statement would need a data-modifying CTE whose later branch
  // cannot see the row the earlier branch just inserted -- the classic upsert-CTE
  // hazard, and one that silently denies the first send of every new bucket.
  await db.query(
    `INSERT INTO provider_rate_buckets
       (tenant_id, provider, channel, tokens, capacity, refill_per_second, updated_at)
     VALUES ($1, $2, $3, $4::numeric, $4::numeric, $5::numeric, $6)
     ON CONFLICT (tenant_id, provider, channel) DO NOTHING`,
    [config.tenantId, config.provider, config.channel, config.capacity, config.refillPerSecond, now],
  );

  // The decision itself is one statement. Refill and decrement happen inside a
  // single row lock, so two workers cannot both read four tokens and both spend
  // the fourth. The WHERE clause is what carries the answer: if the refilled
  // balance is under one token the UPDATE matches nothing, writes nothing, and
  // returns nothing -- there is no window in which a caller has been charged for a
  // token it was not given.
  const acquired = await db.query<{ tokens: string }>(
    `UPDATE provider_rate_buckets AS b
        SET tokens = LEAST(
                       $4::numeric,
                       b.tokens + GREATEST(EXTRACT(EPOCH FROM ($6::timestamptz - b.updated_at)), 0)
                                  * $5::numeric
                     ) - 1,
            capacity = $4::numeric,
            refill_per_second = $5::numeric,
            updated_at = $6::timestamptz
      WHERE b.tenant_id = $1 AND b.provider = $2 AND b.channel = $3
        AND LEAST(
              $4::numeric,
              b.tokens + GREATEST(EXTRACT(EPOCH FROM ($6::timestamptz - b.updated_at)), 0)
                         * $5::numeric
            ) >= 1
      RETURNING b.tokens`,
    [config.tenantId, config.provider, config.channel, config.capacity, config.refillPerSecond, now],
  );

  if (acquired.rows.length > 0) return { allowed: true };

  // Denied. Note that `updated_at` was deliberately NOT advanced above: the refill
  // is integrated from the last successful spend, so leaving the timestamp alone
  // is what lets a denied bucket keep accruing. Advancing it on every rejected
  // attempt would reset the integral each time and starve the bucket forever under
  // a polling caller.
  const wait = await db.query<{ wait_seconds: string }>(
    `SELECT GREATEST(
              0,
              1 - LEAST(
                    capacity,
                    tokens + GREATEST(EXTRACT(EPOCH FROM ($4::timestamptz - updated_at)), 0)
                             * refill_per_second
                  )
            ) / refill_per_second AS wait_seconds
       FROM provider_rate_buckets
      WHERE tenant_id = $1 AND provider = $2 AND channel = $3`,
    [config.tenantId, config.provider, config.channel, now],
  );

  const waitSeconds = Number(wait.rows[0]?.wait_seconds ?? 0);
  // A floor of one millisecond keeps a caller that treats this as a sleep duration
  // out of a busy loop when the wait rounds to zero.
  const retryAfterMs = Math.max(1, Math.ceil(waitSeconds * 1000));
  return { allowed: false, retryAfterMs };
}

/**
 * Current balance, for the operations screen.
 *
 * Read-only and refill-aware, so the number shown is what a send would find rather
 * than what the last send left behind.
 */
export async function bucketTokens(
  db: Db,
  config: Pick<RateLimitConfig, 'tenantId' | 'provider' | 'channel'>,
  clock: Clock,
): Promise<number | undefined> {
  const result = await db.query<{ available: string }>(
    `SELECT LEAST(
              capacity,
              tokens + GREATEST(EXTRACT(EPOCH FROM ($4::timestamptz - updated_at)), 0)
                       * refill_per_second
            ) AS available
       FROM provider_rate_buckets
      WHERE tenant_id = $1 AND provider = $2 AND channel = $3`,
    [config.tenantId, config.provider, config.channel, clock.now()],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : Number(row.available);
}
