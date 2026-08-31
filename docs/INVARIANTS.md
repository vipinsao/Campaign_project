# The invariants

Twenty-three properties this system enforces, each with a named test and each
tracing to a specific way a messaging system fails in production.

They run as their own CI job, `compliance`, which is a required check. That job is
what the badge in the README refers to — not "some tests pass", but "these
particular guarantees still hold".

**I1 is not in the numbered list below** because it is not a runtime check: it is
the structural claim that there is only one send path, and it is asserted by
[`tests/unit/architecture.test.ts`](../tests/unit/architecture.test.ts), which
scans the source tree and fails if `provider.send` is called from more than one
file.

---

## Messaging invariants

### I2 — the environment guard runs before the claim
[`i2-env-guard-precedes-claim.test.ts`](../tests/invariants/i2-env-guard-precedes-claim.test.ts) · 4 tests

**The failure.** A non-production worker is pointed at a production database. The
environment guard sits *inside* the send function rather than before the claim. The
worker claims a row, increments `attempts`, declines to send, releases it. Three
passes later the message is permanently failed — a message production itself would
have sent perfectly well.

It is invisible in production, because production never refuses. The guard looks
correct in the only environment anyone is watching.

**The test.** Run a worker with `SEND_MODE=off` ten times against a queued message,
then assert `attempts` is still **0**.

**The general lesson.** The *position* of a guard relative to a state transition is
part of its correctness.

---

### I3 — claiming is atomic and crash-safe
[`i3-concurrent-claim-exactly-once.test.ts`](../tests/invariants/i3-concurrent-claim-exactly-once.test.ts) · 5 tests

**The claim, stated precisely.** CLAIMING is exactly-once. DELIVERY is
at-least-once. An earlier version of this document said exactly-once delivery, and
an adversarial review proved it wrong: a worker inside `provider.send` when its row
is reclaimed has already put the request on the network.

**The failure this does prevent.** Messages stuck forever in `processing` because
the worker that claimed them was killed; two workers writing contradictory results
for the same row; and a slow batch reclaiming its own tail — `claimBatch` stamped
one `claimed_at` for the whole batch, so with the shipped defaults any batch slower
than about nine messages a minute re-sent its own tail on a single replica,
deterministically. The stamp is now refreshed per message, immediately before the
send.

**The test.** Eight *genuinely separate connection pools* against 100 queued rows —
separate so the workers contend in the server's lock manager rather than being
serialised by one client-side pool. Assert the claimed sets are disjoint and their
union is complete. Then kill a worker mid-flight and assert the rows are reclaimed
rather than abandoned.

**The ownership fence.** Every terminal writer carries
`AND claimed_by = $worker AND status = 'processing'`, and the ones that must never
resurrect a delivered message also carry `AND sent_at IS NULL`. Without it, a
worker that had lost its claim still wrote its result — producing `status='failed'`
on a row with `sent_at` set, and putting delivered messages back in the claimable
queue.

**Why `SKIP LOCKED` and not compare-and-swap.** Read-then-swap has a window between
the read and the swap in which two workers both believe they own the row.
`SKIP LOCKED` closes that window inside the lock manager, where it belongs.

---

### I4 — deduplication is a database constraint
[`i4-dedup-is-a-database-constraint.test.ts`](../tests/invariants/i4-dedup-is-a-database-constraint.test.ts) · 4 tests

**The failure.** Duplicate sends from concurrent triggers, webhook redeliveries and
retried API calls.

**The mechanism.** `dedup_key` is a **generated column**, and the uniqueness is a
`UNIQUE` index on it. Application code cannot compute the key inconsistently across
the enqueue, retry and bulk paths because application code does not compute it at
all. A conflicting insert is an idempotent no-op, not an error.

**Why check-then-insert is banned.** Between the check and the insert, every
concurrent caller passes the check. It does not reduce duplicates; it makes them
rare enough to be unreproducible.

**The anchor is part of the key** — otherwise a customer who orders twice has the
second journey silently swallowed by the first order's key.

---

### I5 — quiet hours are recipient-local
[`i5-quiet-hours-recipient-local.test.ts`](../tests/invariants/i5-quiet-hours-recipient-local.test.ts) · 10 tests

**The failure.** Messages delivered at 02:03 local time. It happens because the
timezone used was the *server's*, and on a server running UTC that looks correct
for about a sixth of the world.

**The test.** A **72-cell matrix**: nine timezones — including both hemispheres' DST
transitions, two half-hour offsets (Asia/Kolkata, Australia/Adelaide), UTC+14
(Pacific/Kiritimati) and UTC−11 (Pacific/Niue) — crossed with eight instants
including both DST transition days and the repeated hour of a fall-back. No
scheduled instant may fall outside the local window.

A server-clock implementation passes a single-timezone test on a UTC CI runner and
fails most of that grid.

**The floor is a floor.** Campaign configuration may only *narrow* the tenant
window. A campaign asking for 06:00–23:00 gets the tenant's 08:00–21:00 unchanged,
and a window that does not intersect the floor at all is rejected rather than
producing an unsatisfiable search.

---

### I6 — consent is a ledger, and opt-out cancels what is queued
[`i6-optout-cancels-queued.test.ts`](../tests/invariants/i6-optout-cancels-queued.test.ts) · 4 tests

**The failure.** A customer says stop, and then receives the three messages already
sitting in the queue. "The opt-out worked, those were sent before it" is not a
defence anyone outside engineering accepts.

**The test.** Queue five messages, opt out, assert **all five become `cancelled`**
and that running the worker immediately afterwards sends nothing. Separately: after
an out → in → out sequence, assert the ledger can still answer *"were they opted in
on 15 March?"* — a question a boolean column cannot answer at all.

**A category opt-out does not suppress the address.** "Drop one category" must not
silently become "never contact this person again".

---

### I7 — the unsubscribe link resolves
[`i7-unsubscribe-link-resolves.test.ts`](../tests/invariants/i7-unsubscribe-link-resolves.test.ts) · 5 tests

**The failure.** An unsubscribe link that points at a route which does not exist.
Everything looks right — the template has a link, the token exists, the table
exists — but the URL matches no route, so every recipient reaches a blank page and
the opt-out table stays empty. Nothing detects this except actually fetching the
link, and nobody internally ever clicks one.

**The test.** Boot the real app on a real socket. Render a real marketing email.
Parse the href out of the **rendered HTML**, not the template. `fetch` it. Assert
**200 with a non-empty body containing a real form**. Then post the opt-out and
assert the queued messages are cancelled.

---

### I8 — terminal errors are never retried
[`i8-terminal-errors-never-retried.test.ts`](../tests/invariants/i8-terminal-errors-never-retried.test.ts) · 4 tests

**The failure.** Carrier-rejected messages resent three times each, and forensics
made impossible because the stored error string is the framework's rather than the
provider's.

**The test.** Return a terminal error, run the worker **ten times**, assert the
provider was called exactly **once**. Assert the persisted `provider_error_code` is
the provider's own.

**Classification is data, not an if-chain.** A table can be reviewed, diffed,
extended from real traffic and asserted over. Unknown codes default to *transient
but capped at two attempts*: retrying an unknown error twice is cheap, treating it
as terminal silently drops deliverable mail, and treating it as unlimited-transient
is how a retry loop burns a month of budget in a weekend.

---

### I9 — `delivered` requires a receipt
[`i9-delivered-requires-receipt.test.ts`](../tests/invariants/i9-delivered-requires-receipt.test.ts) · 5 tests

**The failure.** A delivery-rate metric that reads 100% forever, because the code
marks the row delivered on the line after it marks it sent.

**The test.** A successful send leaves the row at `sent` with `delivered_at` null.
A `CHECK` constraint makes an unsent-but-delivered row **unrepresentable**, and a
delivery timestamp preceding the send is rejected by the database. A static check
asserts `markSent` never touches `delivered_at`.

Absent a receipt the state stays `sent` and the UI renders "awaiting receipt" — the
honest answer, and more useful than a confident wrong one.

---

### I10 — the frequency cap is enforced at send time
[`i10-frequency-cap-enforced.test.ts`](../tests/invariants/i10-frequency-cap-enforced.test.ts) · 4 tests

**The failure.** Five cadence and priority columns in the schema with zero backend
readers, looking like a working control on the settings screen, while one recipient
gets 48 messages in seven days.

**The test that matters** is the second one, and it is the one usually missing: run
the same scenario under **two different configured caps** and require the outcome to
differ. A cap that is read but compared against a constant passes every other
assertion in the file.

The cap is per contact, per **channel**, per rolling window — an email and an SMS
are not interchangeable interruptions.

---

### I11 — webhook validation iterates every credential
[`i11-webhook-multi-credential.test.ts`](../tests/invariants/i11-webhook-multi-credential.test.ts) · 12 tests

**The failure.** A single-row credential lookup that breaks the day a tenant adds a
second sender. Every provider callback rejected with 403, for months, silently —
because a rejected webhook looks like an attack rather than a defect.

**The test.** Three active credentials for one tenant; a payload signed by each in
turn must validate. An unsigned or tampered payload is rejected **401**, and the
raw row is still persisted so a batch rejected by a credential mistake can be
replayed after the fix.

**Fail closed.** No match means reject, never accept.

---

### I12 — every rate has a documented denominator
[`i12-metric-denominators.test.ts`](../tests/invariants/i12-metric-denominators.test.ts) · 9 tests

**The failure.** Not a crash — a number that is wrong, looks plausible, has a chart
next to it, and is used to decide things. Three specific ways:

1. The denominator is `sent` rather than `delivered`, so every bounce counts as
   somebody who chose not to open, and a campaign to a stale list is graded on list
   hygiene rather than on its content.
2. The denominator includes messages that contained no link, so a click rate grades
   campaigns on whether they happened to have a link at all.
3. Numerator and denominator count different things — a set of recipients over a
   count of messages is not a rate.

**The test.** Every rate checked against a hand-computed value. `rate()` returns
**`null`, never `0`**, when the denominator is zero: "we cannot know this yet" and
"this is zero" are different answers, and almost every 0%-open-rate panic is that
conflation. **SMS exposes no open rate at all** — there is no such thing as an SMS
open, and the type system will not let the UI ask for one.

---

### I13 — an ambiguous recipient is never silently resolved
[`i13-ambiguous-recipient.test.ts`](../tests/invariants/i13-ambiguous-recipient.test.ts) · 12 tests

**The failure.** Order numbers are unique per store, not globally. Picking the most
recent match sends one customer's order details to a different customer.

**The mechanism.** The unique constraint is `(tenant_id, store_id, order_number)` —
honest about the real key — so a lookup by number alone genuinely can match more
than one row, and the return type is a union with an explicit `ambiguous` arm. The
type system forces every caller to handle it at compile time.

The API returns **HTTP 300** with the candidate list, so reaching for
`candidates[0]` requires a deliberate act, and candidate emails are masked because
the disambiguation screen is showing two *different* customers.

---

### I14 — every decision is logged
[`i14-every-decision-is-logged.test.ts`](../tests/invariants/i14-every-decision-is-logged.test.ts) · 6 tests

**The failure.** An operator with no way to answer "why didn't this fire?" other
than reading source code, and an engineer whose only available response is to add a
log line and wait for it to happen again.

**The test.** Every enqueue and every skip writes a row carrying a machine-readable
reason code, a human sentence the UI renders directly, and the **inputs it was
decided from** so the call is reproducible. A deferral records *when* it will be
reconsidered, not merely that it was deferred. And a cross-check asserts every gate
in the chain skips with a code that exists in the closed `REASON_CODES` vocabulary,
so a new gate cannot start emitting an undeclared string nothing can group by.

**"Nothing happened" is never an acceptable system state.**

---

## AI invariants

The thesis: **a language model is good at reading prose, judging tone, summarising
and drafting. It must never be responsible for arithmetic, identity matching,
permission checks, or anything that must give the same answer twice.**

### V1 — deterministic paths never call the model
[`v1-deterministic-paths-never-call-the-model.test.ts`](../tests/invariants/v1-deterministic-paths-never-call-the-model.test.ts) · 4 tests

**The test to point at in an interview.** The full pipeline is run with a
`ThrowingModelClient` — a client that raises on *any* call — and fed 35 opt-out
fixtures across varied casing, whitespace and punctuation, plus order-number
extraction and duplicate detection. All must succeed.

An opt-out that depends on a model call is an opt-out that can fail. A boundary is
only real if something breaks when it is crossed.

### V2 — every model call is recorded
[`v2-every-call-is-recorded.test.ts`](../tests/invariants/v2-every-call-is-recorded.test.ts) · 6 tests
Prompt version, model id, input hash, raw output, tokens, cost, latency. An
unexplainable production decision with no way to reproduce it is the failure.

### V3 — prompt versions are immutable
[`v3-prompt-version-is-immutable.test.ts`](../tests/invariants/v3-prompt-version-is-immutable.test.ts) · 7 tests
Content-hashed, never edited in place. Otherwise "it worked last week" has no answer.

### V4 — a regression blocks the merge
[`eval-blocks-a-prompt-regression.test.ts`](../tests/integration/eval-blocks-a-prompt-regression.test.ts) · 4 tests
The golden set is **derived from error analysis on real traces**, not invented up
front — writing evaluators before implementation grades imagination rather than the
system. v1 scores macro-F1 0.88 and passes; a deliberately worse v2 scores 0.53 and
fails, naming accuracy, macro-F1 and complaint recall separately.

### V5 — malformed output escalates, never coerces
[`v5-malformed-output-escalates.test.ts`](../tests/invariants/v5-malformed-output-escalates.test.ts) · 5 tests
Parsed against a strict zod schema. A violation retries once with the validation
error appended, then goes to human review. It never becomes a coerced guess.

### V6 — low confidence escalates
[`v6-low-confidence-escalates.test.ts`](../tests/invariants/v6-low-confidence-escalates.test.ts) · 5 tests
Below the threshold the item is marked uncertain and routed to a human, never
assigned a best-guess label presented as certain.

### V7 — the budget refuses before the call
[`v7-budget-refuses-at-ceiling.test.ts`](../tests/invariants/v7-budget-refuses-at-ceiling.test.ts) · 8 tests
Per-tenant, enforced *before* the request is made. At the ceiling, requests are
refused with a clear error — never silently truncated or degraded.

### V8 — identical input is cached
[`v8-identical-input-is-cached.test.ts`](../tests/invariants/v8-identical-input-is-cached.test.ts) · 7 tests
Keyed on content hash and prompt version, never on wall-clock time. The same input
must not yield two different labels in one session.

### V9 — the model can only ADD protection
[`v9-model-cannot-reduce-protection.test.ts`](../tests/invariants/v9-model-cannot-reduce-protection.test.ts) · 8 tests

**The headline invariant of the whole system.** The classifier is handed a narrowed
capability object exposing a single add-only method, closing over the connection so
no database handle crosses the boundary at all. There is no code path by which a
model output removes a suppression or opts somebody back in — including a model
that explicitly returns `{action: 'resubscribe'}`.

A hallucination that un-suppresses an opted-out contact is a legal problem, not a
quality problem. It is made unrepresentable rather than merely tested for.

### V10 — auto-send defaults off
[`v10-autosend-defaults-off.test.ts`](../tests/invariants/v10-autosend-defaults-off.test.ts) · 6 tests
An autonomous system does not email customers until somebody decides it should. The
default lives in the schema, not in a config file, and four independent vetoes must
all pass.
