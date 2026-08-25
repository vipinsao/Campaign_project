# Campaign Engine

A multi-channel campaign and lifecycle messaging engine that can prove why it sent
a message — and, more usefully, why it didn't.

An operator defines a campaign: a trigger, an audience, and a sequence of email and
SMS messages. When a trigger fires, the engine decides who is enrolled, renders each
message, schedules it against the recipient's local quiet hours, and a worker
delivers it through a provider adapter. Every open, click, delivery receipt, bounce,
complaint and opt-out flows back as an immutable event, and all analytics are derived
from those events rather than from counters.

> **This is a personal project, not a system I shipped at work.** The architecture and
> the invariants below come from seven months debugging a production notification
> service; the code is written from scratch and shares nothing with it. Several
> decisions here are deliberately *different* from what that experience exposed me to,
> and those differences are the parts I most want to talk about.

**Status:** in progress. See [TRACKER.md](TRACKER.md) — it is accurate, including
about what is not built.

---

## The thing worth looking at

Anyone can wire a provider SDK to a cron job. The part that separates a messaging
system that works in a demo from one that works in production is a set of guarantees
about what it will *refuse* to do — and whether those guarantees survive contact with
concurrency, retries, timezones and a customer who changes their mind.

This repository encodes fourteen of those as named tests that run as their own CI job.

| # | Invariant | The failure it prevents | Test |
|---|---|---|---|
| **I1** | Every gate — consent, suppression, quiet hours, frequency cap, stop conditions — is evaluated **at send time**, not only at enqueue. | A guard implemented in the enqueue path while the bulk, retry and event-triggered paths bypass it. *A guard that exists in one of four code paths is not a guard.* | [`architecture`](tests/unit/architecture.test.ts) |
| **I2** | The environment guard runs **before** the queue row is claimed. | A non-production worker pointed at a production database claims a row, burns a retry, declines to send, and permanently fails a message production would have sent. Invisible in production, because production never refuses. | [`i2`](tests/invariants/i2-env-guard-precedes-claim.test.ts) |
| **I3** | Claiming is atomic and crash-safe: `SELECT … FOR UPDATE SKIP LOCKED` with a `claimed_by` stamp, and stale claims are reclaimed. | Double sends under concurrency; messages stuck forever because the worker that claimed them died. | [`i3`](tests/invariants/i3-concurrent-claim-exactly-once.test.ts) |
| **I4** | Deduplication is a **UNIQUE index on a generated column**, and a conflicting insert is an idempotent no-op. | Duplicate sends from concurrent triggers, webhook redeliveries and retried API calls. Application-level check-then-insert is banned. | [`i4`](tests/invariants/i4-dedup-is-a-database-constraint.test.ts) |
| **I5** | Quiet hours are computed in the **recipient's** timezone, falling back to the tenant default and never to the server's. Campaign config can narrow the window, never widen it. | Messages delivered at 02:03 local time. | [`i5`](tests/invariants/i5-quiet-hours-recipient-local.test.ts) |
| **I6** | Consent is an **append-only ledger**; suppression is an **address-level list**. Opting out cancels messages already queued. | Opt-outs honoured only for contacts carrying a flag; queued mail going out after the customer said stop; consent history destroyed by an UPDATE. | [`i6`](tests/invariants/i6-optout-cancels-queued.test.ts) |
| **I7** | A marketing message cannot be scheduled unless its rendered body contains a **resolvable** opt-out — asserted by booting the app and fetching the generated URL. | An unsubscribe link pointing at a route that does not exist. Every recipient reaches a blank page, for the entire life of the system, because nobody ever clicked one. | *in progress* |
| **I8** | Provider errors are classified terminal or transient from an explicit table. Terminal errors are **never** retried, and the provider's own error code is persisted. | Carrier-rejected messages resent three times each; forensics impossible because the stored error is the framework's, not the provider's. | [`i8`](tests/invariants/i8-terminal-errors-never-retried.test.ts) |
| **I9** | `delivered` is written **only** by a provider receipt. It is never inferred from `sent`. | A delivery-rate metric that reads 100% because the code marks delivered on the line after sent. | [`i9`](tests/invariants/i9-delivered-requires-receipt.test.ts) |
| **I10** | A frequency cap is enforced at send time, and **a test asserts that changing the config changes the behaviour**. | Five cadence columns in the schema with zero backend readers. 48 messages to one recipient in seven days. | [`i10`](tests/invariants/i10-frequency-cap-enforced.test.ts) |
| **I11** | Webhook signature validation iterates **all** active credentials for a tenant and fails **closed**, retaining the raw payload for replay. | A single-row credential lookup that breaks when a tenant has three senders — every provider callback rejected with 403, for months, silently. | *in progress* |
| **I12** | Every rate has an explicit denominator, defined once and shown in the UI. Open rate is unique opens ÷ **delivered**. SMS has no open rate and the UI must not render one. | Rates computed over `sent`, or over a population including messages with no clickable link, grading campaigns wrongly. | *not built* |
| **I13** | Resolving a recipient from an order number returns `none \| single \| ambiguous`. It never silently picks the most recent match. | Order numbers are unique per store, not globally. Picking the newest match sends one customer's details to a different customer. | *in progress* |
| **I14** | Every enqueue **and every skip** writes a decision row with a machine-readable reason code and the inputs it was evaluated from. | An operator with no way to answer "why didn't this fire?" other than reading source code. | [`i14`](tests/invariants/i14-every-decision-is-logged.test.ts) |

Three of these are not finished. They are marked as such here and in
[TRACKER.md](TRACKER.md) rather than quietly omitted.

---

## Architecture

```mermaid
flowchart TB
  subgraph api["api process — HTTP only, never schedules"]
    R[routes] --> CORE
    T["/t/o · /t/c · /r · /u<br/>tracking + preference centre"] --> EV
    W["/webhooks/:provider<br/>persist raw, then verify"] --> EV
  end

  subgraph worker["worker process — the only thing that schedules"]
    J1[process-queue] --> ORCH
    J2[reclaim-stale] --> Q
    J3[time-triggers] --> TRIG
    J4[rollups] --> ROLL
  end

  subgraph core["core — no express, no SDKs, no wall clock"]
    TRIG[TriggerEvaluator] --> AUD[AudienceResolver]
    AUD --> SCHED[QuietHours · Scheduler]
    SCHED --> Q[(message_queue)]
    ORCH[DeliveryOrchestrator<br/>8 gates, one send path] --> Q
    ORCH --> DEC[(send_decisions)]
    CORE[domain services]
  end

  ORCH -->|the only provider.send call| PROV[providers<br/>mock · smtp · postmark · twilio]
  PROV -.delivery receipt.-> W
  EV[(message_events<br/>append-only)] --> ROLL[(campaign_daily_stats<br/>derived · rebuildable)]
  ORCH --> EV

  classDef store fill:#1f2937,stroke:#4b5563,color:#e5e7eb
  class Q,DEC,EV,ROLL store
```

Two processes, one image. The API process is structurally forbidden from
registering a scheduler — three API replicas would mean every job firing three
times, and a long job would block the health check until the platform restarted the
container mid-run.

---

## Five decisions, and what each one costs

**PostgreSQL is the queue.** No Redis, no broker. The property that earns it is
transactional enqueue: a message can be queued in the same transaction as the
business write that caused it, which a separate broker cannot do without an outbox
and a relay. What it costs is fan-out, cross-region replication, and a ceiling
somewhere in the low thousands of messages per minute on modest hardware. The
threshold at which I would move is written down rather than left as a shrug.

**Analytics are event-sourced.** `message_events` is append-only and is the only
source of truth; the daily rollup is derived and can be dropped and rebuilt.
Counters incremented in-line by the sender are banned, because they drift — a crash
between the send and the increment, a retry that increments twice — and once a
counter has drifted there is no way to recover the truth, since the evidence was
never written down.

**Consent is a ledger, not a boolean.** A boolean answers "are they opted in?" and
nothing else. It cannot answer "were they opted in on 4 March, and where did that
consent come from?", which is the question that actually gets asked. The database
refuses `UPDATE` and `DELETE` on that table, so it is a guarantee rather than a
convention.

**The mock provider is a first-class citizen.** It writes to a real outbox table,
assigns simulated outcomes from configured rates, and fires delayed delivery and
bounce webhooks back into the real webhook endpoint. The whole system runs with zero
credentials, which is the difference between a reviewer trying it and not.

**The domain never reads the wall clock.** Every time-dependent decision takes an
injected `Clock`. This is what makes "three days after the order is delivered" a
three-millisecond test instead of a three-day one, and it is what lets the demo
fast-forward thirty days of behaviour in about a minute.

---

## Running it

Requires Node 24. **No Docker daemon and no root needed** — the test and dev
databases are real PostgreSQL 18 servers started as child processes.

```bash
git clone https://github.com/vipinsao/campaign-engine
cd campaign-engine
npm install
npm test          # boots a real Postgres, migrates it, runs everything
```

There is deliberately no `docker-compose.yml` yet — it is listed under "not built
yet" below rather than mentioned as though it exists.

```bash
npm run typecheck   # tsc, and a test proves this gate is not a no-op
npm run lint        # eslint, including the architecture boundary rules
npm test            # unit + integration + invariants
```

### See it actually run

```bash
npm run dev          # boots Postgres, migrates, starts api + worker + web
npm run seed:demo    # deterministic: 500 contacts, 1,200 orders, 5 campaigns
npm run demo:simulate # replays 30 days in about a minute
```

`demo:simulate` advances a `FakeClock` in one-hour steps and drives the trigger
evaluator and the worker at every tick, so a month of campaign behaviour is
watchable in about a minute. It ends by printing the decision log — the reasons
messages did *not* send. See [`docs/DEMO.md`](docs/DEMO.md).

---

## Deliberately not built

Knowing what was left out matters as much as the list above.

- **Not a full ESP.** No deliverability infrastructure, IP warming, DKIM/SPF
  management or MTA.
- **No WYSIWYG email designer.** HTML plus a live preview is enough; a visual
  designer is a large project with nothing to prove here.
- **No A/B testing.** The campaign version snapshot is where it would attach.
- **Single region, single database.** The scale-out path is documented with the
  threshold at which it becomes worth doing.
- **No GDPR data-subject-request tooling**, though the consent ledger is the
  substrate it would need.

## Not built *yet*

Distinct from the above, and tracked in [TRACKER.md](TRACKER.md):

- **The web UI is incomplete and does not currently build.** Seven pages exist
  (login, campaign list, overview, audience, messages); the journey canvas,
  schedule, analytics, queue, `/inspect` and contact timeline do not.
- **No `demo:simulate`.** `seed:demo` is written but has not been run end to end,
  so there is no click-through demo yet.
- **No CI workflow**, so the badges this README would like to show do not exist.
- **No deployment** — no Dockerfile, no `render.yaml`, no live URL.
- **I12's byte-identical rollup-rebuild test** is not written; the denominators and
  the rebuild itself are.

The backend is complete and tested end to end. The parts above are not, and saying
so is cheaper than having a reviewer discover it.

---

## Documentation

- [`docs/INVARIANTS.md`](docs/INVARIANTS.md) — all 23 invariants, each with the
  production failure it prevents and a link to its test.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — every judgment call, with the reasoning
  at the time. Includes the defects found in the original build specification and
  why following it literally would have shipped bugs.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the two-process split, the
  package boundaries and how they are enforced, and the send-time gate chain.
- [`docs/DEMO.md`](docs/DEMO.md) — a numbered sixty-second click-through.
- ADRs: [Postgres as the queue](docs/ADR-001-postgres-queue.md) ·
  [event-sourced analytics](docs/ADR-002-event-sourced-analytics.md) ·
  [the consent ledger](docs/ADR-003-consent-ledger-vs-boolean.md) ·
  [the injectable clock](docs/ADR-004-injectable-clock.md) ·
  [decision-log retention](docs/ADR-005-decision-log-retention.md)
- [`TRACKER.md`](TRACKER.md) — build state, per phase.

## Licence

MIT.
