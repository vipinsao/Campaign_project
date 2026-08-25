# ADR-004 — The domain never reads the wall clock

**Status:** accepted · 2026-08-25

## Decision

`packages/core` never calls `new Date()` or `Date.now()`. Every time-dependent
decision takes an injected `Clock`. An ESLint rule bans the calls, and
`tests/unit/architecture.test.ts` scans the source to prove the rule is wired up —
with exactly one named exemption, `SystemClock`, verified to be exactly one line of
code so it cannot quietly grow.

## Why

**Testability at speed.** "Three days after the order is delivered" is either a
three-day test or a three-millisecond one, and the difference is entirely whether
the domain reads the clock or is handed the time. Nothing else in the design has as
large an effect on what is practical to test.

**Demonstrability.** `npm run demo:simulate` advances a `FakeClock` in one-hour
steps across thirty simulated days, driving the worker at each tick, so a reviewer
watches a month of campaign behaviour in about a minute. That is only possible
because no code path anywhere in the domain can notice that time is not real.

**Determinism.** A quiet-hours matrix across nine timezones and both DST
transitions is only meaningful if the instant under test is fixed.

## The subtle part

The rule leaks wherever a **database `DEFAULT now()`** participates in a decision,
and that is easy to miss because it does not look like reading a clock.

`enrollments.enrolled_at` was originally taking its column default. Stop conditions
ask "did an event occur since this contact was enrolled?" — so that timestamp is an
input to a decision, and it was silently coming from the server's wall clock while
everything around it came from the injected one. Under a `FakeClock` the comparison
could never be true, and the demo would have produced a timeline where no stop
condition ever fired.

**A `DEFAULT` is a fallback, not an authority.** Any timestamp that participates in
a decision is passed explicitly from the clock. `recordDecision` takes an optional
`decidedAt` for the same reason.

## What it costs

Every function that touches time takes one more parameter, and the wiring is
visible at every call site rather than hidden. That verbosity is the price of the
property, and it is worth it.
