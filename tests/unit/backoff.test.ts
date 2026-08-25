import { describe, it, expect } from 'vitest';
import {
  BACKOFF_CAP_MINUTES,
  BACKOFF_JITTER_FRACTION,
  baseAttemptDelayMs,
  nextAttemptAt,
  nextAttemptDelayMs,
} from '@campaign/providers';

const MINUTE = 60_000;

/** rng() = 0.5 sits exactly at the centre of the jitter band, so no jitter is applied. */
const centre = () => 0.5;

describe('retry backoff', () => {
  it('doubles the base delay until it reaches the cap', () => {
    expect(baseAttemptDelayMs(0)).toBe(1 * MINUTE);
    expect(baseAttemptDelayMs(1)).toBe(2 * MINUTE);
    expect(baseAttemptDelayMs(2)).toBe(4 * MINUTE);
    expect(baseAttemptDelayMs(3)).toBe(8 * MINUTE);
    expect(baseAttemptDelayMs(4)).toBe(16 * MINUTE);
    expect(baseAttemptDelayMs(5)).toBe(32 * MINUTE);
  });

  it('never exceeds sixty minutes, however many attempts have been made', () => {
    for (const attempts of [6, 7, 12, 40, 1000]) {
      expect(baseAttemptDelayMs(attempts)).toBe(BACKOFF_CAP_MINUTES * MINUTE);
    }
  });

  it('grows monotonically', () => {
    let previous = 0;
    for (let attempts = 0; attempts <= 12; attempts++) {
      const delay = nextAttemptDelayMs(attempts, centre);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });

  it('holds the jitter inside plus or minus twenty per cent', () => {
    // The extremes are asserted directly rather than sampled, which is the reason
    // the rng is injectable in the first place: a sampled test cannot distinguish
    // a band that is slightly too wide from a run that was slightly unlucky.
    for (let attempts = 0; attempts <= 8; attempts++) {
      const base = baseAttemptDelayMs(attempts);
      const low = nextAttemptDelayMs(attempts, () => 0);
      const high = nextAttemptDelayMs(attempts, () => 1 - Number.EPSILON);

      expect(low).toBe(Math.round(base * (1 - BACKOFF_JITTER_FRACTION)));
      expect(high).toBeCloseTo(base * (1 + BACKOFF_JITTER_FRACTION), -1);
      expect(low).toBeGreaterThanOrEqual(base * (1 - BACKOFF_JITTER_FRACTION));
      expect(high).toBeLessThanOrEqual(base * (1 + BACKOFF_JITTER_FRACTION));
    }
  });

  it('keeps every draw within the band across the whole range of the rng', () => {
    for (let attempts = 0; attempts <= 8; attempts++) {
      const base = baseAttemptDelayMs(attempts);
      for (let step = 0; step <= 100; step++) {
        const delay = nextAttemptDelayMs(attempts, () => step / 100);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(base * (1 - BACKOFF_JITTER_FRACTION)));
        expect(delay).toBeLessThanOrEqual(Math.ceil(base * (1 + BACKOFF_JITTER_FRACTION)));
      }
    }
  });

  it('spreads a batch that failed together across a window', () => {
    // The property the jitter exists for: a thousand messages that failed at the
    // same instant on the same attempt count must not all come back at once.
    let seed = 1;
    const rng = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const delays = new Set<number>();
    for (let i = 0; i < 200; i++) delays.add(nextAttemptDelayMs(3, rng));
    expect(delays.size).toBeGreaterThan(100);
  });

  it('clamps a nonsensical attempt count rather than producing NaN', () => {
    // A NaN reaching next_attempt_at becomes a message that is never retried and
    // never explained, which is far worse than an over-eager retry.
    expect(baseAttemptDelayMs(-3)).toBe(1 * MINUTE);
    expect(baseAttemptDelayMs(Number.NaN)).toBe(1 * MINUTE);
    expect(Number.isFinite(nextAttemptDelayMs(Number.POSITIVE_INFINITY, centre))).toBe(true);
  });

  it('projects the next attempt from a supplied instant, not the wall clock', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    expect(nextAttemptAt(now, 2, centre).toISOString()).toBe('2026-03-01T12:04:00.000Z');
    // Purity is the point: called twice with the same inputs it must agree.
    expect(nextAttemptAt(now, 2, centre).getTime()).toBe(nextAttemptAt(now, 2, centre).getTime());
  });
});
