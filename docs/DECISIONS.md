# Decisions

A running log of judgment calls made while building this, with the reasoning at the
time. Entries are append-only and dated; where a decision reversed an earlier one,
both stay.

Two kinds of entry appear here:

- **Judgment calls** — places where more than one option was defensible.
- **Corrections to the design** — places where the plan this was built from was
  wrong, and following it literally would have shipped a defect. These are the
  more interesting half.

---

## D1 — The build specification had defects, and they are fixed here rather than reproduced

**2026-08-25.** This system was built from a detailed specification written up
front. Before writing code, the spec was audited line by line; that audit found 28
issues, of which roughly a dozen would have produced real defects if implemented
literally. The ones that materially changed the build are D2–D9 below.

Recording this is deliberate. The specification is not the authority — the running
system is. A spec followed exactly into a known bug is not fidelity, it is
negligence with a paper trail.

---

## D2 — `enrollments` uses `UNIQUE NULLS NOT DISTINCT`

**The defect avoided.** The spec required "one enrolment per contact per campaign
per anchor", enforced by `UNIQUE (campaign_id, contact_id, anchor_id)`, and
commented that the database was enforcing a rule application code would forget
under concurrency.

It would not have been. PostgreSQL treats NULLs as **distinct** in a unique index
by default. Every `contact_created` and `manual` campaign has `anchor_id IS NULL`,
so that constraint permits unlimited duplicate enrolments for exactly the campaign
types where it is the only protection.

The failure mode is the worst kind: the constraint exists, is visible in the
schema, reads correctly, and does nothing. `NULLS NOT DISTINCT` (PostgreSQL 15+)
makes it do what it claims.

---

## D3 — `dedup_key` is a generated column, not application-computed

**Decision.** `message_queue.dedup_key` is `GENERATED ALWAYS AS (...) STORED`.

**Why.** The spec specified the dedup key's format and required a UNIQUE index on
it, which is correct as far as it goes. But it left the key's *computation* in
application code, in a system that deliberately has an enqueue path, a retry path,
a bulk path and an event-triggered path. Four call sites computing a key by string
concatenation is four chances to compute it differently — and a dedup key that
differs by one character does not collide, so the duplicate simply inserts.

Making it a generated column moves the guarantee one level below the bug.
Application code cannot compute the key inconsistently because application code
does not compute it at all. A test asserts the column is `GENERATED ALWAYS` and
that a hand-written value is rejected outright.

This also required denormalising `anchor_id` onto `message_queue`: a key the
database computes must be computable from the row itself, and a key that depends on
a join is a key the database cannot enforce.

---

## D4 — A quiet-hours deferral does not consume a delivery attempt

**The defect avoided.** This is the subtlest one, and it is the one most likely to
have shipped.

`claimBatch` increments `attempts` when it claims a row, because at claim time it
cannot know whether the row is about to be sent or held back. The spec's gate chain
then handled a retryable gate failure — quiet hours, frequency cap — by calling
`reschedule(msg, nextEligibleAt)`, and said nothing about the counter.

So: a message correctly held back by recipient-local quiet hours on three
consecutive nights burns three of its five attempts, and is then reclaimed as
`stale_claim_exhausted` and marked permanently failed. The guard working exactly as
designed is what destroys the message.

Counting "we correctly chose not to send yet" as "we tried and it broke" turns a
working guard into an outage, and the resulting metric blames the provider. Fixed
with a separate `deferrals` column and a `deferClaimed` path that reverses the
optimistic claim increment.

---

## D5 — Transactional and operational categories are exempt from quiet hours

**The contradiction.** The spec declared the tenant quiet-hours window a hard floor
that campaign configuration "cannot widen", and separately required a seeded
shipping-notification campaign with "no quiet hours because transactional is
exempt". The gate chain applied `withinQuietHours` unconditionally. All three
cannot hold.

**Decision.** The exemption is real and is keyed on the campaign **category**,
which is a closed set enforced by a database CHECK constraint. It is expressed as a
named predicate, `isQuietHoursExempt(category)`, not a boolean column.

**Why this shape.** A "your order is out for delivery" SMS at 21:30 is expected and
wanted; a promotional message at the same time is not. That is a real distinction
and it is the one CAN-SPAM and TCPA also draw. Keying it on category rather than a
per-campaign flag means a campaign cannot quietly grant itself the exemption — an
operator would have to change the category, which also changes how consent is
evaluated. The I5 test encodes the carve-out explicitly so it cannot drift.

---

## D6 — Consent precedence: most recent intent wins, across wildcard and category

**The gap.** Consent rows may be scoped to a category or to all categories
(`category IS NULL`). A contact can therefore hold `('*', opted_out, Tuesday)` and
`('promotional', opted_in, Wednesday)` simultaneously. The spec never said which
wins, and the answer is load-bearing for both the send gate and the preference
centre.

**Decision.** Most recent intent wins, treating wildcard and category-specific rows
as a single timeline, resolved in a SQL function (`consent_state`) so the send gate
and analytics cannot drift apart.

**Why.** The product promises a preference centre where someone can "drop one
category instead of all mail". That promise is only honest if the later, narrower
choice actually takes effect. Resolving wildcard-always-wins would make the
per-category toggles decorative — worse than not offering them.

---

## D7 — A paused campaign defers its queued messages; it does not cancel them

**Decision.** The `campaignStillActive` gate returns `retryable: true` for
`paused`, and non-retryable only for `archived`/`draft`.

**Why.** An operator who pauses a campaign to fix a typo and resumes an hour later
should not discover that pausing destroyed every message in flight. "Paused" means
not now; it does not mean not ever. Because cancelled rows keep their dedup key
permanently, cancelling on pause would make those messages unrecoverable.

---

## D8 — `suppressions` expiry is evaluated at send time, not only by the nightly job

**The defect avoided.** The schema carries `expires_at`, and a daily job expires
soft-bounce suppressions. If the send gate trusts the job, a suppression is honoured
for up to twenty-four hours past its expiry — and if the job fails, indefinitely,
with nothing surfacing it.

The gate evaluates `expires_at IS NULL OR expires_at > now()` itself. The job is an
optimisation for keeping the table tidy, not the authority.

Related: there is deliberately **no** partial index of "currently active"
suppressions. `now()` is `STABLE`, not `IMMUTABLE`, so PostgreSQL rejects it in an
index predicate — an index cannot encode a time-varying definition of "currently",
which is precisely why the gate has to evaluate it.

---

## D9 — "Previous message" crosses channels

**The gap.** Send conditions like `not_opened_previous` reference a previous
message, but the spec's `campaign_messages` had `UNIQUE (campaign_id, channel,
sequence_order)` — a per-channel sequence. The flagship seeded journey is
email → SMS, so "previous" crosses channels and a per-channel sequence resolves to
the wrong message, or to none.

**Decision.** `sequence_order` is unique per campaign, across channels, and
"previous" is the highest-`sequence_order` **sent** message in the same enrolment
prior to this one, regardless of channel.

**Also decided:** where the condition is positive (`opened_previous`) and no
previous message was sent, the gate fails **closed**. A condition that says "only
if they opened the last one" must not fire when there was no last one.

---

## D10 — A typo in a segment key was a full-tenant blast

**2026-08-25.** `AudienceDefinition` was a zod union whose second member was not
`.strict()`. A definition of `{ alll: [...] }` — one keystroke from `all` —
validated cleanly, carried no recognised combinator, compiled to the predicate
`TRUE`, and would have sent the campaign to **every contact in the tenant**.

Found by a test, not by review. The gap between "matched nobody" and "matched
everybody" is the entire safety margin of an audience DSL, and a segmentation typo
has to be a validation error.

---

## D11 — `matches` and `estimate` share one compiled predicate

**Decision.** `AudienceResolver.estimate` is the compiled predicate as a `WHERE`
clause; `matches` is the same predicate plus `AND c.id = $n`. There is deliberately
no in-memory evaluator for the single-contact case.

**Why.** Two implementations of the same predicate always drift. When they do, the
operator sees a live audience count that disagrees with who actually received the
message — which is worse than showing no count at all, because the wrong number is
trusted. A test runs 13 definitions against 500 contacts through both paths and
requires zero disagreements.

**Known limitation, stated rather than hidden.** `estimate` counts contacts
matching the *segment*. It does not subtract opt-outs, suppressions, frequency caps
or quiet-hours deferrals, so it is an upper bound on who will actually receive the
message. The UI labels it "matching the segment" for that reason. Making it a true
"reachable" count is the obvious next change.

---

## D12 — TypeScript 6.0.3, not 7.0.2

**Decision.** TypeScript is pinned to 6.0.3 even though 7.0.2 is current.

**Why.** TypeScript 7 is the native Go port and is meaningfully faster, but it
ships no programmatic API until 7.1, so `typescript-eslint` has no support for it
and caps at `typescript <6.1.0`. Adopting TS 7 today means typed linting silently
stops working.

A type gate that checks nothing is the failure class this repository exists to
refuse. Trading a working lint gate for a faster compiler would be a strange place
to start. Revisit when `typescript-eslint` supports tsgo.

---

## D13 — Embedded PostgreSQL for tests, not Testcontainers

**Decision.** Tests boot a real PostgreSQL 18 through `embedded-postgres`, which
downloads a genuine server binary and runs it as an unprivileged child process.
`docker-compose.yml` still ships for reviewers who prefer it.

**Why.** The spec called for Testcontainers, which requires a Docker daemon. This
version needs no daemon and no root, so `npm install && npm test` works on a
machine with neither — which lowers the bar for the reviewer who is deciding
whether to bother.

What was **not** traded away: it is still a real server. Everything the invariants
depend on — `FOR UPDATE SKIP LOCKED`, partial indexes, generated columns, `EXCLUDE`
constraints, `NULLS NOT DISTINCT`, append-only triggers — exists only in a real
PostgreSQL. Mocking the database would mock away the entire subject of the project.

---

## D14 — Hono rather than Express

**Decision.** The HTTP layer is Hono 4.

**Why.** Express 5 would have been fine on the merits — it is current-major and
patched. It was replaced because in a repository whose whole argument is that the
choices were made deliberately, Express was the one component that read as a
default rather than a decision. Hono also removes the `body-parser` /
`cookie-parser` / hand-rolled-async-error-wrapper cluster that actually signals an
un-maintained codebase.

This is a presentation decision as much as a technical one, and is recorded as such
rather than dressed up as a performance argument.

---

## D15 — `uuidv7()` for primary keys, `gen_random_uuid()` for `tracking_id`

**Decision.** Every primary key defaults to PostgreSQL 18's `uuidv7()`. One column
deliberately does not: `message_queue.tracking_id` stays `gen_random_uuid()` (v4).

**Why the split.** UUIDv7 is time-ordered, which gives far better index locality
than v4 on an append-heavy queue, and `uuid_extract_timestamp()` gives creation
time for free.

But `tracking_id` is embedded in an **unauthenticated URL** — the open pixel and
the click redirect. A UUIDv7 carries an extractable millisecond timestamp, so
anyone holding one of those URLs could read exactly when the message was generated.
A primary key wants index locality; a public identifier wants no structure at all.

---

## D16 — The lint gate was broken, and fixing it meant tightening the compiler

**2026-08-25.** `npm run lint` reported 125 errors and had never passed. Two thirds
were not style disagreements but a genuine conflict between
`@typescript-eslint/dot-notation` and this project's own strictness settings.

Resolved by enabling `noPropertyAccessFromIndexSignature`, which makes the
distinction between a declared property and an arbitrary key explicit —
`process.env.FOO` is a guess, `process.env['FOO']` admits it is a lookup that can
miss. Tightening the compiler made the lint rule agree on its own, rather than
suppressing it.

`no-non-null-assertion` is disabled in `tests/` only, where `rows[0]!.id` is the
correct assertion: a missing row should throw loudly at that line. It stays on in
`packages/`, where there are zero violations.

---

## D17 — Architectural rules are asserted by tests, not only by lint

**Decision.** `tests/unit/architecture.test.ts` scans the source tree and asserts
the same rules ESLint enforces: no wall-clock reads in `core`, no vendor SDK
outside `providers`, no hardcoded tenant UUID, `provider.send` called from exactly
one file, and the gate chain in its documented order.

**Why duplicate them.** A lint rule can be disabled with an inline comment,
reconfigured, or silently stop matching after a directory rename — and when that
happens, nothing fails. The duplication is the point.

---

## D18 — The golden eval set is derived from error analysis, not invented

**Decision.** The AI layer's golden evaluation set is built from captured
production-shaped traces, hand-labelled through open coding into a failure
taxonomy, and only then frozen as the set that gates CI.

**Why.** Writing evaluators before implementation — deciding up front what the
model should be graded on — is a well-documented anti-pattern, because a language
model has effectively unbounded surface area for failure and the failures that
matter are the ones you have actually observed. An invented golden set measures
imagination; a derived one measures the system.

This ordering is slower and is the part almost nobody does, which is precisely why
it is worth doing here.
