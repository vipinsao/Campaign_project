# ADR-002 — Analytics are event-sourced

**Status:** accepted · 2026-08-25

## Decision

`message_events` is append-only, enforced by a database trigger, and is the only
source of truth for analytics. `campaign_daily_stats` is a derived rollup that can
be dropped and rebuilt. Counter columns incremented in-line by the sender are
banned.

## Why

Counters drift, and every way they drift is mundane:

- a crash between the send and the increment
- a retry that increments twice
- a backfill that increments none
- a deploy that changes which code path does the incrementing
- a bug fix that corrects future counts and leaves history wrong

The problem is not that any one of these is likely. It is that **once a counter has
drifted there is no way to recover the truth**, because the evidence was never
written down. The number is simply wrong now, permanently, and nobody can say by
how much.

With an append-only event log, the aggregate is disposable. If the rollup is wrong,
delete it and rebuild. If the *definition* of a metric changes, rebuild under the
new definition and get a corrected history rather than a discontinuity.

## Consequences

**No rate is ever stored.** Rates live in `core/metrics/denominators.ts`, defined
exactly once, and are computed at read time from stored counts. A rate persisted in
a rollup is a rate that can disagree with its own definition — which is how a
dashboard and an export end up showing different open rates with nobody able to say
which is right.

**"Unique" in the daily rollup means unique-per-contact-per-day**, because that is
what a daily grain can express. Summing it across a range is *not* a range-unique
count: a contact who opens on Monday and again on Tuesday contributes two. Range
queries therefore compute uniques directly from the events with
`COUNT(DISTINCT contact_id)`, and the tooltip in the UI says which is which. Getting
this wrong produces a plausible, confidently-wrong number that nobody questions
because it has a chart next to it.

**Storage costs more.** One row per event rather than one row per campaign-day. At
portfolio scale this is irrelevant; the threshold at which it stops being
irrelevant is monthly range partitioning on `occurred_at`, and that is the change
to make, not a switch back to counters.
