# Architecture

## Two processes, one image

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│ api                         │     │ worker                       │
│ HTTP only.                  │     │ The only process that        │
│ Never registers a scheduler.│     │ schedules anything.          │
└──────────────┬──────────────┘     └───────────────┬──────────────┘
               │                                    │
               └──────────────┬─────────────────────┘
                              ▼
                   ┌─────────────────────┐
                   │ core (the domain)   │
                   │ no HTTP, no SDKs,   │
                   │ no wall clock       │
                   └──────────┬──────────┘
                              ▼
                        PostgreSQL 18
```

The API process is **structurally forbidden** from registering a scheduler.
`packages/api/src/no-scheduler.ts` wraps `globalThis.setInterval` and throws at the
point of registration for any repeating timer created from an API frame or a cron
module, and the assertion runs again after the route graph is wired. A comment
saying "do not register schedulers here" is not a control.

Three reasons it matters:

1. A scheduler in the web process competes with request handling for the event
   loop.
2. It multiplies per replica. Three API replicas means every job firing three
   times — and the symptom is duplicate sends, which look like a queue bug.
3. A long job blocks the health check, so the platform restarts the container
   mid-run, leaving rows claimed by a worker that no longer exists.

## Package boundaries

| Package | May import | Enforced by |
|---|---|---|
| `shared` | nothing but itself | eslint `boundaries` |
| `core` | `shared` | eslint + `tests/unit/architecture.test.ts` |
| `providers` | `shared` | the only package permitted a vendor SDK |
| `triage` | `shared`, `core` | the only package permitted `@anthropic-ai/sdk` |
| `api`, `worker` | everything above | — |

Two rules are additionally asserted by a test that scans the source tree, because a
lint rule can be disabled with an inline comment or stop matching after a rename,
and when that happens nothing fails:

- **`core` never reads the wall clock.** Exactly one exemption, `SystemClock`,
  verified to be exactly one line of code so it cannot quietly grow.
- **`provider.send` is called from exactly one file.** A second send path is a send
  path with no gates in front of it.

## The pipeline

```
domain event ─▶ TriggerEvaluator ─▶ AudienceResolver ─▶ enrolment
                      │                                     │
                      │ (a decision row for every campaign   │
                      │  considered, including the ones      ▼
                      │  that did not fire)            render + schedule
                      │                                against recipient-local
                      ▼                                quiet hours
                send_decisions ◀───────────────────────────┐  │
                                                            │  ▼
   provider ◀── DeliveryOrchestrator ◀── claim (SKIP LOCKED) ── message_queue
      │              8 gates, re-evaluated at send time      │
      │                                                      │
      ▼                                                      │
   webhook ─▶ message_events (append-only) ─▶ campaign_daily_stats (derived)
```

### The send-time gate chain

Eight gates, in this order, every time, on the only send path:

1. `campaignStillActive` — paused defers, archived cancels
2. `enrollmentStillActive` — a stop condition may have fired since enqueue
3. `consentCurrent` — the ledger, resolved for this channel and category
4. `notSuppressed` — address level, with expiry evaluated here not by a nightly job
5. `withinQuietHours` — recipient-local, re-checked now
6. `underFrequencyCap` — per contact, per channel, per rolling window
7. `hasValidRecipientAddress`
8. `messageConditionSatisfied` — `opened_previous`, `not_replied`, …

Order is part of the contract and is asserted by a test. Consent and suppression
precede quiet hours deliberately: deferring a message for someone who has opted out
would mean repeatedly reconsidering a message that must never be sent.

Each gate returns `{pass, retryable, code, detail}`. **`retryable` is the
distinction that keeps the system honest** — "not now" (quiet hours, frequency cap,
paused campaign) defers without consuming a delivery attempt; "not ever" (opted
out, suppressed, invalid address) cancels. Collapsing the two is how a message
correctly held back for the night becomes a message permanently destroyed.

## Why PostgreSQL is the queue

See [ADR-001](ADR-001-postgres-queue.md). Briefly: transactional enqueue with the
business write, which a broker cannot do without an outbox and a relay. The cost is
no fan-out, no cross-region replication, and a ceiling in the low thousands of
messages per minute on modest hardware. `SKIP LOCKED` gives real concurrency, and
the scale-out path is more worker replicas, which the design already supports
correctly.

## Why analytics are event-sourced

See [ADR-002](ADR-002-event-sourced-analytics.md). `message_events` is append-only
and is the only source of truth. `campaign_daily_stats` is derived and can be
dropped and rebuilt. Counters incremented in-line by the sender are banned: they
drift, the ways they drift are mundane, and once drifted the truth is unrecoverable
because the evidence was never written down.

**No rate is ever stored.** Rates are defined once in
`core/metrics/denominators.ts` and computed at read time. A rate stored in a rollup
is a rate that can disagree with its own definition.

## Where the AI sits

`packages/triage` classifies inbound replies. The boundary is explicit and tested:

| Deterministic — never reaches the model | Model — behind a confidence gate |
|---|---|
| Opt-out keyword detection | Intent classification |
| Order-number extraction (regex + DB check) | Sentiment, urgency |
| Identity matching | Summarisation, drafting |
| Duplicate detection (content hash) | Entity extraction from prose |

The model may **classify** and **suggest**. It may never decide whether to send, who
to send to, or what a metric means. And it can only ever *add* protection: the
classifier is handed a narrowed capability object exposing one add-only method, so
there is no code path by which a model output removes a suppression or opts someone
back in. A hallucination that un-suppresses an opted-out contact is a legal problem,
not a quality problem.
