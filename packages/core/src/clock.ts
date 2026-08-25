/**
 * The injectable clock.
 *
 * `core` never calls `new Date()` or `Date.now()`. An ESLint rule enforces it and
 * tests/unit/architecture.test.ts asserts the rule is actually wired up.
 *
 * This is the single change that makes the whole system demonstrable. "Three days
 * after the order is delivered" is either a three-day test or a three-millisecond
 * one, and the difference is entirely whether the domain reads the wall clock or is
 * handed the time. It is also what lets `npm run demo:simulate` fast-forward thirty
 * days of campaign behaviour in about a minute, which is the thing that makes this
 * repository reviewable in the sixty seconds a reviewer will actually give it.
 */
export type Clock = {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    // eslint-disable-next-line no-restricted-syntax -- the one permitted wall-clock read
    return new Date();
  }
}

/** Test and simulation clock. Time only moves when something moves it. */
export class FakeClock implements Clock {
  #current: Date;

  constructor(start: Date | string) {
    this.#current = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.#current.getTime());
  }

  set(to: Date | string): void {
    this.#current = typeof to === 'string' ? new Date(to) : new Date(to.getTime());
  }

  advance(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }

  advanceHours(hours: number): void {
    this.advance(hours * 3_600_000);
  }

  advanceDays(days: number): void {
    this.advance(days * 86_400_000);
  }
}
