import type { Logger } from 'pino';
import { pino } from 'pino';
import type { Registry } from 'prom-client';
import type { Clock, Db, SendMode } from '@campaign/core';
import { SystemClock, getPool } from '@campaign/core';
import { buildRegistry } from './observability/metrics.ts';

/**
 * Everything the HTTP layer is handed rather than reaches for.
 *
 * `createApp(deps)` takes all of this explicitly so a test can boot the real app
 * against a fixed clock and a test pool without listening on a port and without
 * mutating process.env. The alternative — modules that call `getPool()` and
 * `new Date()` at import time — makes the app impossible to instantiate twice in
 * one process, which is exactly what the integration suite needs to do.
 */
export type ApiDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Registry;

  /** HMAC key for operator JWTs and for deriving ingest API keys. */
  readonly jwtSecret: Uint8Array;
  /** AES-256-GCM key (32 bytes) for provider_credentials secrets. */
  readonly encryptionKey: Buffer;

  /**
   * Absolute origin this API is reachable at, used to build tracking, click and
   * unsubscribe URLs.
   *
   * It is configuration rather than something derived from the inbound Host
   * header, and that is load-bearing for I7: an unsubscribe URL built from an
   * attacker-controlled Host arrives in the recipient's inbox pointing at the
   * attacker's domain, and a URL built from the host of whichever internal caller
   * happened to render the message points at a service name that resolves nowhere
   * outside the cluster. Either way the recipient cannot unsubscribe.
   */
  readonly publicBaseUrl: string;

  readonly rateLimit: RateLimitConfig;
  /** Token lifetime for operator sessions. */
  readonly tokenTtlSeconds: number;

  /**
   * Whether this deployment sends for real.
   *
   * The API does not send anything itself - that is the worker's job, and there is
   * exactly one send path - but it does need to know, because the mock outbox is
   * only meaningful when the mock provider is in use. Exposing message bodies
   * through an operator route in a live deployment would be a data-disclosure
   * surface for no benefit, so that route refuses when SEND_MODE is live.
   *
   * Defaults to 'off', like everywhere else (I2).
   */
  readonly sendMode: SendMode;

  /**
   * The environment this app was built from.
   *
   * Carried rather than read, for the same reason the clock and the pool are. Two
   * apps in one test process must be able to disagree about configuration —
   * `SEND_MODE`, the storefront's tenant, an SMTP host — and a route that reaches
   * for `process.env` at request time makes that impossible without mutating
   * global state, which then leaks into whichever test happens to run next.
   *
   * Routes that need provider credentials or deployment-level settings read this.
   * Nothing here is secret in a way `process.env` was not already.
   */
  readonly env: NodeJS.ProcessEnv;
};

export type RateLimitConfig = {
  /** Sustained requests per window, per client, per bucket. */
  readonly limit: number;
  readonly windowMs: number;
  /** Public tracking and preference-centre routes get their own, looser budget. */
  readonly publicLimit: number;
  /** Login is bucketed separately and tightly; it is the only credential oracle. */
  readonly loginLimit: number;
  /**
   * The public storefront, which is the only unauthenticated route that can cause
   * a real message to be sent. Generous for a human clicking around and useless
   * for anything else.
   *
   * Optional so that the dozen existing call sites that build a RateLimitConfig
   * inline — every integration and QA suite — keep compiling. Making it required
   * would have meant editing twelve test files to restate a number none of them
   * cares about, and a diff that large hides the one line that matters.
   */
  readonly storefrontLimit?: number;
};

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  limit: 600,
  windowMs: 60_000,
  publicLimit: 3_000,
  loginLimit: 10,
  storefrontLimit: 20,
};

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    // Failing at boot rather than defaulting. A JWT secret with a development
    // default is a JWT secret that ships, and every token in production is then
    // forgeable by anyone who has read the repository.
    throw new Error(`${name} is not set. The API refuses to boot without it.`);
  }
  return value;
}

/**
 * The 32-byte AES key, decoded from base64 or hex.
 *
 * The length is checked here rather than at first use. A short key produces a
 * `crypto` error on the first webhook of the day, which is a bad time to discover
 * that a secret was truncated when it was pasted into a deployment variable.
 */
export function decodeEncryptionKey(raw: string): Buffer {
  const decoded = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (decoded.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes for AES-256-GCM; got ${decoded.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  return decoded;
}

export type DepsOverrides = Partial<ApiDeps> & { readonly env?: NodeJS.ProcessEnv };

/** Anything not in {off, mock, live} is treated as `off`, not as an error at this
 *  layer: a typo in SEND_MODE must fail CLOSED, and check-env.ts is where a
 *  malformed value is reported loudly at boot. */
function parseSendMode(raw: string | undefined): SendMode {
  return raw === 'live' || raw === 'mock' ? raw : 'off';
}

/** Assemble deps from the environment, with every piece overridable for tests. */
export function buildDeps(overrides: DepsOverrides = {}): ApiDeps {
  const env = overrides.env ?? process.env;
  const logger =
    overrides.logger ??
    pino({
      level: env['LOG_LEVEL'] ?? 'info',
      base: { service: 'campaign-api' },
    });

  return {
    db: overrides.db ?? getPool(env['DATABASE_URL']),
    clock: overrides.clock ?? new SystemClock(),
    logger,
    metrics: overrides.metrics ?? buildRegistry(),
    jwtSecret: overrides.jwtSecret ?? new TextEncoder().encode(requiredEnv(env, 'JWT_SECRET')),
    encryptionKey:
      overrides.encryptionKey ?? decodeEncryptionKey(requiredEnv(env, 'ENCRYPTION_KEY')),
    publicBaseUrl: (overrides.publicBaseUrl ?? requiredEnv(env, 'PUBLIC_BASE_URL')).replace(
      /\/+$/,
      '',
    ),
    rateLimit: overrides.rateLimit ?? DEFAULT_RATE_LIMIT,
    tokenTtlSeconds: overrides.tokenTtlSeconds ?? 12 * 3_600,
    sendMode: overrides.sendMode ?? parseSendMode(env['SEND_MODE']),
    env,
  };
}
