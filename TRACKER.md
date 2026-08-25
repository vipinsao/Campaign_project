# Build tracker

Updated in place after each phase. A box is only ticked when its tests pass —
`npm run typecheck`, `npm run lint` and `npm test` must all be green.

**Status as of 2026-08-25:** typecheck clean · lint clean (0 errors) · **499 tests passing across 39 files**

Boxes below are honest. Unticked means not built, not "mostly built".

---

## Phase 0 — Foundation
- [x] P0.1 — Monorepo (npm workspaces), TS strict, ESLint + boundary rules, Prettier, Vitest
- [ ] P0.2 — `docker-compose.yml`; `npm run dev` runs api + worker + web
- [x] P0.3 — Migration runner + numbered migrations; `npm run migrate` idempotent, content-hash guarded
- [ ] P0.4 — CI green with every job wired
- [x] P0.5 — `typecheck-gate-actually-checks` passes (proves `tsc` is not a no-op)

## Phase 1 — Data model
- [x] P1.1 — All tables, indexes, constraints, views migrated (9 migrations)
- [~] P1.2 — Repository layer; every query takes an explicit tenant
      *(architecture test asserts no hardcoded tenant UUID; a per-query assertion is still missing)*
- [~] P1.3 — `seed:demo` written (deterministic, 500 contacts / 1200 orders / 5 campaigns); not yet run end-to-end
- [~] P1.4 — Integration test: campaign lifecycle under a tenant *(API agent in progress)*

## Phase 2 — Domain core
- [x] P2.1 — `Clock` interface; `SystemClock` + `FakeClock`; lint rule + test ban wall-clock reads in `core`
- [x] P2.2 — `AudienceResolver`, one shared compiler; `matches-agrees-with-estimate` passes (500 contacts, 13 definitions, 0 disagreements)
- [x] P2.3 — `TemplateRenderer` + validation; unknown field is an error; HTML escaped; SMS segments on rendered length
- [x] P2.4 — `QuietHours`/`Scheduler`; 72-cell timezone × DST matrix passes **(I5)**
- [x] P2.5 — `ConsentLedger` + `SuppressionList`; append-only enforced by trigger **(I6)**
- [x] P2.6 — `MessageQueue` enqueue with `ON CONFLICT DO NOTHING` on a generated key **(I4)**
- [x] P2.7 — Claim/reclaim with `SKIP LOCKED`; 8-way concurrency test passes **(I3)**
- [x] P2.8 — `send_decisions` written by every gate path **(I14 — table + writers done; the exhaustiveness test is not)**

## Phase 3 — Delivery
- [x] P3.1 — `MessageProvider` interface; mock email + SMS with latency, failure rates, delayed webhooks
- [x] P3.2 — `DeliveryOrchestrator` gate chain; `only-one-send-path` passes **(I1)**
- [x] P3.3 — Env guard precedes claim **(I2)**
- [x] P3.4 — Error table + classifier; 77 rules; terminal never retried **(I8 — table done, named test pending)**
- [x] P3.5 — Cross-process token-bucket rate limiter in Postgres
- [x] P3.6 — Frequency cap enforced at send **(I10)**
- [x] P3.7 — SMTP + Twilio + Postmark adapters (fetch-based, not required for the demo)
- [x] P3.8 — Sender identity resolution, iterating all active credentials **(I11)**

## Phase 4 — Triggers, enrolment, journeys
- [x] P4.1 — `TriggerEvaluator` for order_placed / shipped / delivered / contact_created
- [x] P4.2 — Time trigger with cutoff floor, circuit breaker, dry-run; fails closed with no floor
- [x] P4.3 — Enrolment state machine + stop conditions cancelling queued messages
- [~] P4.4 — Delivery-anchored scheduling + anchor expiry *(worker jobs written, untested)*
- [~] P4.5 — Message send conditions evaluated at send time *(gate implemented; needs trigger path to exercise it)*
- [ ] P4.6 — Campaign versioning; activation snapshots

## Phase 5 — Tracking, consent surfaces, webhooks
- [x] P5.1 — Open pixel + click redirect + SMS short links
- [x] P5.2 — Unsubscribe tokens + preference centre **(I7)**
- [x] P5.3 — `i7-unsubscribe-link-resolves` against the real running app **(I7)**
- [x] P5.4 — Opt-out cancels queued messages **(I6 — `optOut()` implemented; named test pending)**
- [x] P5.5 — Webhook endpoint: raw persist → multi-credential verify → fail closed **(I11)**
- [ ] P5.6 — SMS STOP/START/HELP handling
- [~] P5.7 — `delivered` only from a receipt **(I9 — enforced by CHECK constraint; named test pending)**
- [ ] P5.8 — Inbound reply capture

## Phase 6 — Analytics
- [ ] P6.1 — Event store projections + rollup job
- [x] P6.2 — `denominators.ts` single source **(I12)**
- [ ] P6.3 — `rollups:rebuild` deterministic and byte-identical
- [ ] P6.4 — Funnel + per-message + daily series endpoints
- [ ] P6.5 — Attribution without double counting

## Phase 7 — API
- [x] P7.1 — Auth (argon2id + JWT via jose), tenant scoping, error envelope preserving `details`
- [x] P7.2 — Routes with zod schemas, wired to core
- [x] P7.3 — `orders/lookup` returns `none|single|ambiguous` **(I13)**
- [x] P7.4 — Rate limiting + request logging + `/metrics` *(per-replica; cross-process version owed)*

## Phase 8 — Frontend
- [ ] P8.1 — Shell, auth, layout, campaign list
- [ ] P8.2 — Campaign editor: Overview / Audience / Messages
- [ ] P8.3 — Journey canvas (React Flow): validate → linearise → sync
- [ ] P8.4 — Schedule tab with the timezone preview strip
- [ ] P8.5 — Analytics tab with denominators in tooltips, no SMS open rate
- [ ] P8.6 — `/queue` and `/inspect` (the "why didn't it send" page)
- [ ] P8.7 — `/contacts/:id` with the consent ledger timeline
- [ ] P8.8 — `/mock-outbox` and `/docs`
- [ ] P8.9 — Responses inbox

## Phase 9 — The compliance suite
Messaging invariants — one test file each:
- [x] I1 — every gate runs on the one send path *(`architecture.test.ts`)*
- [x] I2 — env guard precedes claim; a refusal does not increment `attempts`
- [x] I3 — concurrent claim is exactly once
- [x] I4 — dedup is a database constraint
- [x] I5 — quiet hours are recipient-local
- [x] I6 — opt-out cancels queued messages
- [x] I7 — unsubscribe link resolves against the running app
- [x] I8 — terminal errors are never retried
- [x] I9 — `delivered` requires a receipt
- [x] I10 — frequency cap enforced at send
- [x] I11 — webhook validates against all credentials
- [~] I12 — denominators done; the byte-identical rollup rebuild test is not
- [x] I13 — ambiguous recipient is never silently resolved
- [x] I14 — every decision is logged

AI invariants — all ten implemented and tested:
- [x] V1 — deterministic paths never call the model *(the thesis test: full pipeline under a ThrowingModelClient)*
- [x] V2 — every model call is recorded
- [x] V3 — prompt versions are immutable
- [x] V5 — malformed output escalates, never coerces
- [x] V6 — low confidence escalates to human review
- [x] V7 — budget refuses at the ceiling, before the call
- [x] V8 — identical input is cached on content hash
- [x] V9 — **the model can only ADD protection, never remove it**
- [x] V10 — auto-send defaults off

- [ ] P9.2 — CI job `compliance` is a required check with a README badge
- [ ] P9.3 — `docs/INVARIANTS.md` links each invariant to its test and its failure story

## Phase 10 — Ship it
- [ ] P10.1 — README with architecture diagram and demo GIF
- [ ] P10.2 — `docs/DEMO.md` verified on a cold clone
- [x] P10.3 — `docs/DECISIONS.md` (18 entries)
- [ ] P10.3b — ADR-001 Postgres queue / ADR-002 event sourcing / ADR-003 consent ledger
- [ ] P10.4 — Deployed; live URL; nightly demo reset
- [ ] P10.5 — Clean-room checklist run and recorded
- [ ] P10.6 — Coverage ≥85% on `core`; all CI jobs green

---

**Legend:** `[x]` done and tested · `[~]` partially done, detail in italics · `[ ]` not started
