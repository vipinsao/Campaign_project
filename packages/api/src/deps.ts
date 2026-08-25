import type { Logger } from 'pino';
import { pino } from 'pino';
import type { Registry } from 'prom-client';
import type { Clock, Db } from '@campaign/core';
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
};

export type RateLimitConfig = {
  /** Sustained requests per window, per client, per bucket. */
  readonly limit: number;
  readonly windowMs: number;
  /** Public tracking and preference-centre routes get their own, looser budget. */
  readonly publicLimit: number;
  /** Login is bucketed separately and tightly; it is the only credential oracle. */
  readonly loginLimit: number;
};

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  limit: 600,
  windowMs: 60_000,
  publicLimit: 3_000,
  loginLimit: 10,
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
    jwtSecret:
      overrides.jwtSecret ?? new TextEncoder().encode(requiredEnv(env, 'JWT_SECRET')),
    encryptionKey:
      overrides.encryptionKey ?? decodeEncryptionKey(requiredEnv(env, 'ENCRYPTION_KEY')),
    publicBaseUrl: (overrides.publicBaseUrl ?? requiredEnv(env, 'PUBLIC_BASE_URL')).replace(
      /\/+$/,
      '',
    ),
    rateLimit: overrides.rateLimit ?? DEFAULT_RATE_LIMIT,
    tokenTtlSeconds: overrides.tokenTtlSeconds ?? 12 * 3_600,
  };
}
