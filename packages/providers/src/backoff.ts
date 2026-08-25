import type { Rng } from './deps.ts';

/**
 * Retry backoff.
 *
 * Two properties matter, and the second is the one that gets forgotten.
 *
 * The exponential part is uncontroversial: a provider that just rejected a
 * thousand messages is not ready for a thousand more one second later, so the gap
 * between attempts doubles, up to an hour.
 *
 * The jitter is what stops the retry schedule becoming a synchronised retry storm.
 * A provider outage fails a large batch of messages at very nearly the same
 * instant. Without jitter every one of those messages computes the same delay from
 * the same attempt count, so the entire batch returns as a single spike -- and
 * hits a provider that has probably only just come back up, which fails them all
 * again, which schedules the next identical spike. The system reproduces the
 * outage on its own after the provider has recovered. Spreading each delay over
 * plus or minus twenty per cent flattens the spike into a window, and the width of
 * that window grows with the delay, which is exactly where it is needed.
 *
 * `rng` is injected rather than read from `Math.random` so the jitter bounds can be
 * asserted at their extremes instead of sampled and hoped over.
 */

/** The ceiling on the un-jittered delay. Beyond an hour, waiting longer buys nothing. */
export const BACKOFF_CAP_MINUTES = 60;

/** Jitter is plus or minus this fraction of the base delay. */
export const BACKOFF_JITTER_FRACTION = 0.2;

const MS_PER_MINUTE = 60_000;

/**
 * The un-jittered delay for a message that has already been attempted `attempts`
 * times: 1, 2, 4, 8, 16, 32, 60, 60, ... minutes.
 *
 * Exported separately because the operator-facing "next attempt at" display should
 * show the schedule, not one sampled draw from it.
 */
export function baseAttemptDelayMs(attempts: number): number {
  // A negative or non-finite attempt count means the caller's bookkeeping is
  // broken. Clamping is preferable to propagating NaN into a timestamp column,
  // where it becomes a message that is never retried and never explained.
  const safeAttempts = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0;
  const minutes = Math.min(2 ** safeAttempts, BACKOFF_CAP_MINUTES);
  return minutes * MS_PER_MINUTE;
}

/**
 * The delay to wait before the next attempt, in milliseconds, with jitter applied.
 *
 * `rng` must return a uniform value in [0, 1); 0 gives the low edge of the jitter
 * band and values approaching 1 give the high edge.
 */
export function nextAttemptDelayMs(attempts: number, rng: Rng): number {
  const base = baseAttemptDelayMs(attempts);
  const jitter = (rng() * 2 - 1) * BACKOFF_JITTER_FRACTION;
  return Math.round(base * (1 + jitter));
}

/**
 * The instant to store in `message_queue.next_attempt_at`.
 *
 * Taking the base instant as an argument rather than reading a clock keeps this
 * function pure, which is what lets the simulation fast-forward a retry schedule
 * without waiting an hour for the sixth attempt.
 */
export function nextAttemptAt(now: Date, attempts: number, rng: Rng): Date {
  return new Date(now.getTime() + nextAttemptDelayMs(attempts, rng));
}
