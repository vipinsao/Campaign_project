import type { Pool, PoolClient } from 'pg';

/**
 * The two things every adapter in this package is handed.
 *
 * `Clock` is declared here rather than imported from `packages/core`, and that is
 * deliberate: the boundaries rule in eslint.config.js allows `providers` to reach
 * only `shared` and itself. Duplicating a one-method interface is a smaller price
 * than either weakening that rule or promoting a clock into the shared vocabulary
 * package, which is documented as containing no behaviour. TypeScript is
 * structural, so `SystemClock` and `FakeClock` from core satisfy this without an
 * adapter and without a cast.
 *
 * Providers never call `new Date()` for the same reason `core` never does: the
 * simulation script fast-forwards thirty days of campaign behaviour, and an
 * adapter reading the wall clock would stamp webhook events and rate-limit
 * refills with real time in the middle of simulated time.
 */
export type Clock = {
  now(): Date;
}

/**
 * A pool or a checked-out client. Accepting both matters because the send path
 * runs inside a transaction that already holds the queue row's claim, and
 * borrowing a second connection from the pool there is how a worker deadlocks
 * against itself under load.
 */
export type Db = Pool | PoolClient;

/**
 * Injectable uniform source in [0, 1).
 *
 * Every random decision in this package — jitter, simulated outcomes, mock
 * message ids — goes through one of these so a test can pin it. `Math.random`
 * inside a provider is a test that passes on most runs.
 */
export type Rng = () => number;

/** The default, used when a caller does not care about reproducibility. */
export const defaultRng: Rng = Math.random;
