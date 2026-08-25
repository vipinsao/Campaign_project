# ADR-005 — The decision log has no retention policy yet

**Status:** accepted, with a stated threshold · 2026-08-25

## Decision

`send_decisions` is a plain table. There is no partitioning and no retention job.

## Why this is a decision rather than an omission

Invariant I14 requires a row for every enqueue **and every skip**, which means the
table grows with (campaigns × contacts × evaluations), not with messages sent. That
is deliberate — it is what makes "why didn't this fire?" answerable — but it is also
the fastest-growing table in the schema by a wide margin.

The arithmetic: an hourly time-trigger job over 500,000 contacts and five campaigns
writes **2.5 million rows per hour**. At that point a single unpartitioned table
with four indexes is a problem.

At the scale this system is built and tested for — 500 contacts, 1,200 orders — it
is entirely irrelevant, and building partitioning now would be complexity that has
not been earned.

## The threshold, and what to do at it

**Above roughly 10 million rows, or when `/decisions` queries stop being
index-only:** convert to monthly range partitioning on `decided_at`, plus a job
that detaches and drops partitions older than the retention window.

Retention should be **at least as long as the consent evidence is useful** — a
decision row explaining why somebody was or was not contacted is exactly what gets
asked for after a complaint, and ninety days is the shortest defensible window.

## What is already in place

- `send_decisions_lookup` indexes `(tenant_id, contact_id, decided_at DESC)`, which
  is the `/inspect` access pattern.
- `send_decisions_reason` indexes `(tenant_id, reason_code, decided_at DESC)` for
  the "why are messages not sending?" aggregate.
- The `/decisions` API route requires at least one filter, specifically to keep it
  off a sequential scan. That is the API papering over the absence of partitioning,
  and it is noted here rather than left to be discovered.
