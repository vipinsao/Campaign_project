import type { MiddlewareHandler } from 'hono';
import type { Clock } from '@campaign/core';
import type { HttpMetrics } from '../observability/metrics.ts';
import { tooManyRequests } from '../errors.ts';
import type { AppEnv } from './context.ts';

/**
 * A fixed-window counter, in process memory.
 *
 * KNOWN AND DELIBERATE LIMITATION, stated here rather than discovered later: this
 * limiter is per replica. Three API replicas therefore permit three times the
 * configured rate, and a client pinned to one replica by a sticky load balancer
 * gets exactly the configured rate. That is acceptable for what this limiter is
 * for — blunting credential stuffing on `/auth/login` and stopping one broken
 * client from monopolising a replica — and it is NOT acceptable as a quota or a
 * billing control. The cross-process version belongs in Postgres alongside
 * `provider_rate_buckets`, which already exists for exactly this reason on the
 * send side; the reason it is not used here is that a database round trip on the
 * tracking-pixel path would cost more than the abuse it prevents.
 *
 * Entries are swept lazily on read rather than by a background timer, because the
 * API process is structurally forbidden from owning repeating timers — see
 * no-scheduler.ts. A limiter that needs a cron job to avoid leaking memory would
 * be a limiter that cannot live in this process at all.
 */
type Window = { count: number; resetAt: number };

export type RateLimiter = {
  readonly check: (key: string, windowMs: number, now: number) => Window;
  readonly size: () => number;
};

const SWEEP_EVERY = 500;

export function createRateLimiter(): RateLimiter {
  const windows = new Map<string, Window>();
  let sinceSweep = 0;

  return {
    check(key, windowMs, now) {
      sinceSweep += 1;
      if (sinceSweep >= SWEEP_EVERY) {
        sinceSweep = 0;
        for (const [k, w] of windows) {
          if (w.resetAt <= now) windows.delete(k);
        }
      }

      const existing = windows.get(key);
      if (existing === undefined || existing.resetAt <= now) {
        const fresh: Window = { count: 1, resetAt: now + windowMs };
        windows.set(key, fresh);
        return fresh;
      }
      existing.count += 1;
      return existing;
    },
    size: () => windows.size,
  };
}

export type RateLimitOptions = {
  readonly limiter: RateLimiter;
  readonly clock: Clock;
  readonly metrics: HttpMetrics;
  readonly bucket: string;
  readonly limit: number;
  readonly windowMs: number;
};

/**
 * Client identity for limiting purposes.
 *
 * An authenticated principal is keyed by tenant, so one tenant's runaway script
 * cannot exhaust another tenant's budget. Unauthenticated traffic falls back to
 * the forwarded address — and only the FIRST hop of `x-forwarded-for`, because the
 * later entries are attacker-appendable and keying on them lets a client mint a
 * fresh budget per request by adding a header.
 */
function clientKey(forwardedFor: string | undefined, realIp: string | undefined): string {
  const first = forwardedFor?.split(',')[0]?.trim();
  if (first !== undefined && first.length > 0) return first;
  if (realIp !== undefined && realIp.length > 0) return realIp;
  return 'unknown';
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal') as { tenantId: string } | undefined;
    const identity =
      principal?.tenantId ?? clientKey(c.req.header('x-forwarded-for'), c.req.header('x-real-ip'));
    const key = `${options.bucket}:${identity}`;

    const now = options.clock.now().getTime();
    const window = options.limiter.check(key, options.windowMs, now);

    const remaining = Math.max(0, options.limit - window.count);
    c.header('x-ratelimit-limit', String(options.limit));
    c.header('x-ratelimit-remaining', String(remaining));
    c.header('x-ratelimit-reset', String(Math.ceil(window.resetAt / 1000)));

    if (window.count > options.limit) {
      options.metrics.rateLimited.inc({ bucket: options.bucket });
      const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
      c.header('retry-after', String(retryAfter));
      // The details carry the numbers a client needs to back off correctly. A bare
      // "too many requests" leaves a well-behaved integrator guessing, and guessing
      // clients retry immediately.
      throw tooManyRequests(`Rate limit exceeded for ${options.bucket}.`, {
        bucket: options.bucket,
        limit: options.limit,
        windowMs: options.windowMs,
        retryAfterSeconds: retryAfter,
      });
    }

    await next();
  };
}
