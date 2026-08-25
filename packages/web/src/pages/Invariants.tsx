import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { PageHeader, Scroll } from '../components/Layout.tsx';
import { Pill } from '../components/Pill.tsx';
import { EmptyState } from '../components/States.tsx';
import type { Tone } from '../components/Pill.tsx';

/**
 * The invariants, as a page rather than as a paragraph in a README.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Every entry below carries three things and refuses to ship without them:
 *
 *   the RULE      what the system guarantees it will refuse to do
 *   the FAILURE   the specific production incident that rule exists to prevent
 *   the TEST      a file, by name, that fails if the rule stops holding
 *
 * The third is what makes the first two more than a claim. A guarantee with no
 * executable proof is a comment, and comments do not fail the build.
 *
 * The text is transcribed from README.md and docs/DECISIONS.md rather than
 * rewritten, so the page and the repository say the same thing. Status comes from
 * TRACKER.md, which the README itself names as the accurate one — including where
 * it says something is only partly done.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const REPO = 'https://github.com/vipinsao/campaign-engine';
const BLOB = `${REPO}/blob/main/`;

type Family =
  | 'delivery integrity'
  | 'consent'
  | 'time'
  | 'measurement'
  | 'forensics'
  | 'model boundary'
  | 'model accounting'
  | 'model refusal';

type Status = 'proven' | 'partial';

type Invariant = {
  readonly id: string;
  readonly family: Family;
  readonly rule: string;
  readonly prevents: string;
  readonly test: string;
  readonly status: Status;
};

const FAMILY_TONE: Record<Family, Tone> = {
  'delivery integrity': 'accent',
  consent: 'ok',
  time: 'held',
  measurement: 'info',
  forensics: 'info',
  'model boundary': 'accent',
  'model accounting': 'info',
  'model refusal': 'ok',
};

/** I1–I14, from the table in README.md. */
const MESSAGING: readonly Invariant[] = [
  {
    id: 'I1',
    family: 'delivery integrity',
    rule: 'Every gate — consent, suppression, quiet hours, frequency cap, stop conditions — is evaluated at send time, not only at enqueue.',
    prevents:
      'A guard implemented in the enqueue path while the bulk, retry and event-triggered paths bypass it. A guard that exists in one of four code paths is not a guard.',
    test: 'tests/unit/architecture.test.ts',
    status: 'proven',
  },
  {
    id: 'I2',
    family: 'delivery integrity',
    rule: 'The environment guard runs before the queue row is claimed.',
    prevents:
      'A non-production worker pointed at a production database claims a row, burns a retry, declines to send, and permanently fails a message production would have sent. Invisible in production, because production never refuses.',
    test: 'tests/invariants/i2-env-guard-precedes-claim.test.ts',
    status: 'proven',
  },
  {
    id: 'I3',
    family: 'delivery integrity',
    rule: 'Claiming is atomic and crash-safe: SELECT … FOR UPDATE SKIP LOCKED with a claimed_by stamp, and stale claims are reclaimed.',
    prevents:
      'Double sends under concurrency; messages stuck forever because the worker that claimed them died.',
    test: 'tests/invariants/i3-concurrent-claim-exactly-once.test.ts',
    status: 'proven',
  },
  {
    id: 'I4',
    family: 'delivery integrity',
    rule: 'Deduplication is a UNIQUE index on a generated column, and a conflicting insert is an idempotent no-op.',
    prevents:
      'Duplicate sends from concurrent triggers, webhook redeliveries and retried API calls. Application-level check-then-insert is banned, because it passes on every concurrent caller.',
    test: 'tests/invariants/i4-dedup-is-a-database-constraint.test.ts',
    status: 'proven',
  },
  {
    id: 'I5',
    family: 'time',
    rule: "Quiet hours are computed in the recipient's timezone, falling back to the tenant default and never to the server's. Campaign config can narrow the window, never widen it.",
    prevents:
      'Messages delivered at 02:03 local time — which almost never happens because nobody thought about timezones, but because the timezone used was the server’s, and on a server running UTC that looks correct for about one sixth of the world.',
    test: 'tests/invariants/i5-quiet-hours-recipient-local.test.ts',
    status: 'proven',
  },
  {
    id: 'I6',
    family: 'consent',
    rule: 'Consent is an append-only ledger; suppression is an address-level list. Opting out cancels messages already queued.',
    prevents:
      'Opt-outs honoured only for contacts carrying a flag; queued mail going out after the customer said stop; consent history destroyed by an UPDATE.',
    test: 'tests/invariants/i6-optout-cancels-queued.test.ts',
    status: 'proven',
  },
  {
    id: 'I7',
    family: 'consent',
    rule: 'A marketing message cannot be scheduled unless its rendered body contains a resolvable opt-out — asserted by booting the app and fetching the generated URL.',
    prevents:
      'An unsubscribe link pointing at a route that does not exist. Every recipient reaches a blank page, for the entire life of the system, because nobody ever clicked one.',
    test: 'tests/invariants/i7-unsubscribe-link-resolves.test.ts',
    status: 'proven',
  },
  {
    id: 'I8',
    family: 'delivery integrity',
    rule: "Provider errors are classified terminal or transient from an explicit table. Terminal errors are never retried, and the provider's own error code is persisted.",
    prevents:
      'Carrier-rejected messages resent three times each; forensics impossible because the stored error is the framework’s, not the provider’s.',
    test: 'tests/invariants/i8-terminal-errors-never-retried.test.ts',
    status: 'proven',
  },
  {
    id: 'I9',
    family: 'measurement',
    rule: 'delivered is written only by a provider receipt. It is never inferred from sent.',
    prevents:
      'A delivery-rate metric that reads 100% because the code marks delivered on the line after sent.',
    test: 'tests/invariants/i9-delivered-requires-receipt.test.ts',
    status: 'proven',
  },
  {
    id: 'I10',
    family: 'delivery integrity',
    rule: 'A frequency cap is enforced at send time, and a test asserts that changing the config changes the behaviour.',
    prevents:
      'Five cadence columns in the schema with zero backend readers. 48 messages to one recipient in seven days.',
    test: 'tests/invariants/i10-frequency-cap-enforced.test.ts',
    status: 'proven',
  },
  {
    id: 'I11',
    family: 'delivery integrity',
    rule: 'Webhook signature validation iterates all active credentials for a tenant and fails closed, retaining the raw payload for replay.',
    prevents:
      'A single-row credential lookup that breaks when a tenant has three senders — every provider callback rejected with 403, for months, silently.',
    test: 'tests/invariants/i11-webhook-multi-credential.test.ts',
    status: 'proven',
  },
  {
    id: 'I12',
    family: 'measurement',
    rule: 'Every rate has an explicit denominator, defined once and shown in the UI. Open rate is unique opens ÷ delivered. SMS has no open rate and the UI must not render one.',
    prevents:
      'Rates computed over sent, or over a population including messages with no clickable link, grading campaigns on list hygiene or on whether they happened to contain a link.',
    test: 'tests/invariants/i12-metric-denominators.test.ts',
    status: 'partial',
  },
  {
    id: 'I13',
    family: 'forensics',
    rule: 'Resolving a recipient from an order number returns none | single | ambiguous. It never silently picks the most recent match.',
    prevents:
      'Order numbers are unique per store, not globally. Picking the newest match sends one customer’s order details to a different customer — a data breach that looks like a working feature.',
    test: 'tests/invariants/i13-ambiguous-recipient.test.ts',
    status: 'proven',
  },
  {
    id: 'I14',
    family: 'forensics',
    rule: 'Every enqueue and every skip writes a decision row with a machine-readable reason code and the inputs it was evaluated from.',
    prevents:
      'An operator with no way to answer "why didn’t this fire?" other than reading source code and waiting for it to happen again with a log line added.',
    test: 'tests/invariants/i14-every-decision-is-logged.test.ts',
    status: 'proven',
  },
];

/** V1–V10, from the AI-invariant suite and the headers of its test files. */
const AI: readonly Invariant[] = [
  {
    id: 'V1',
    family: 'model boundary',
    rule: 'Deterministic paths never call the model. The whole pipeline is driven under a ThrowingModelClient that rejects on any call, and every fixture must still pass.',
    prevents:
      'Opt-out detection, recipient identity and idempotence sitting behind a vendor outage, a rate limit, an exhausted budget or a malformed response. Each of those is a customer who typed STOP and kept receiving messages. The correct architecture is not "the model is accurate at detecting STOP" — it is "the model is not in the path", and that is only true if something checks.',
    test: 'tests/invariants/v1-deterministic-paths-never-call-the-model.test.ts',
    status: 'proven',
  },
  {
    id: 'V2',
    family: 'model accounting',
    rule: 'Every model call is recorded — successes, schema violations, repaired retries, escalations and cache hits alike.',
    prevents:
      'An unattributable invoice and an invisible error rate. A model_calls table containing only successes cannot answer either of the two questions it exists for, because both answers live entirely in the rows the natural implementation drops.',
    test: 'tests/invariants/v2-every-call-is-recorded.test.ts',
    status: 'proven',
  },
  {
    id: 'V3',
    family: 'model accounting',
    rule: 'A prompt version is immutable — enforced twice: an append-only database trigger, and a sync that refuses to proceed if a file changed under an existing version number.',
    prevents:
      '"It worked last week" with nothing to point at. Somebody softens a line, complaint recall falls four points, and three weeks later the regression cannot be bisected, reproduced or even confirmed.',
    test: 'tests/invariants/v3-prompt-version-is-immutable.test.ts',
    status: 'proven',
  },
  {
    id: 'V4',
    family: 'model accounting',
    rule: 'The eval harness is a gate, not a dashboard: the golden set runs on every commit and a regression fails the build.',
    prevents:
      'A prompt that is worse in the two ways real regressions are usually worse — the label definitions quietly gone, and an instruction to be over-confident. Nothing throws, the summaries still read fluently, and the only thing between that and production is an exit code.',
    test: 'tests/integration/eval-blocks-a-prompt-regression.test.ts',
    status: 'proven',
  },
  {
    id: 'V5',
    family: 'model refusal',
    rule: 'Malformed output escalates. It is never coerced — no `label ?? "other"`, no regex-extracted JSON, and strictObject rather than object so an unexpected key is a failure rather than a silent drop.',
    prevents:
      'A made-up label indistinguishable in the database from a real one. The third coercion is the dangerous one: z.object strips unknown keys, so a model asking for something it is not allowed to ask for would parse cleanly and vanish without a record.',
    test: 'tests/invariants/v5-malformed-output-escalates.test.ts',
    status: 'proven',
  },
  {
    id: 'V6',
    family: 'model refusal',
    rule: "Below the tenant's confidence threshold is a human's problem, and the label is kept rather than discarded. The threshold is per tenant, not a constant.",
    prevents:
      'A 0.42-confidence guess rendered identically to a 0.99 one. The uncertainty has to travel with the answer to the place where something is done about it — after that, an unsure "complaint" and a confident "complaint" are the same row.',
    test: 'tests/invariants/v6-low-confidence-escalates.test.ts',
    status: 'proven',
  },
  {
    id: 'V7',
    family: 'model accounting',
    rule: 'The budget refuses at the ceiling, before the call, and the reservation is one atomic statement.',
    prevents:
      'A cost problem silently converted into a quality problem. Checked after the call it is not a budget, it is a report; and SELECT-compare-UPDATE passes on every concurrent caller, so a budget that holds under one worker leaks under eight — invisibly, because development runs one worker.',
    test: 'tests/invariants/v7-budget-refuses-at-ceiling.test.ts',
    status: 'proven',
  },
  {
    id: 'V8',
    family: 'model accounting',
    rule: 'Identical input is cached on a content hash of (prompt_id, input_hash) — never on wall-clock time.',
    prevents:
      'Paying twice for the same answer on a schedule. A TTL says "this goes stale on Thursday", which is only true if the inputs changed — and if they changed, the hash changed and the entry was never going to be hit again.',
    test: 'tests/invariants/v8-identical-input-is-cached.test.ts',
    status: 'proven',
  },
  {
    id: 'V9',
    family: 'model refusal',
    rule: 'The model can only ADD protection, never remove it. The classifier cannot import the consent module, is handed a capability with exactly one add-only method, and is asserted through a Proxy never to touch anything else.',
    prevents:
      'A hallucinated un-suppression. The error is asymmetric in a way no quality metric captures: a wrong suppression costs a marketing email; a wrong un-suppression mails somebody who said STOP. At 99.9% accuracy the second is still unacceptable, because it is not a quality problem — it is a category of action the system must be structurally incapable of taking.',
    test: 'tests/invariants/v9-model-cannot-reduce-protection.test.ts',
    status: 'proven',
  },
  {
    id: 'V10',
    family: 'model refusal',
    rule: 'Auto-send defaults to off, in the schema — tenants.auto_send BOOLEAN NOT NULL DEFAULT false — and it is only the first of four vetoes.',
    prevents:
      'An autonomous system that starts emailing customers because nobody remembered to turn it off. A default in code is one careless `?? true` away from being reversed for everybody at once; a default in the schema means a fresh clone, a CI run and a new tenant are all silent.',
    test: 'tests/invariants/v10-autosend-defaults-off.test.ts',
    status: 'proven',
  },
];

const ALL = [...MESSAGING, ...AI];
const FAMILIES = [...new Set(ALL.map((entry) => entry.family))];

export function InvariantsPage() {
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [family, setFamily] = useState<Family | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const needle = search.trim().toLowerCase();
  const matches = (entry: Invariant) =>
    (family === null || entry.family === family) &&
    (needle.length === 0 ||
      entry.id.toLowerCase().includes(needle) ||
      entry.rule.toLowerCase().includes(needle) ||
      entry.prevents.toLowerCase().includes(needle) ||
      entry.family.includes(needle));

  const messaging = MESSAGING.filter(matches);
  const ai = AI.filter(matches);
  const shown = messaging.length + ai.length;

  return (
    <>
      <PageHeader
        title="Invariants"
        subtitle={
          <>
            Twenty-four guarantees about what this system will <b className="text-ink">refuse</b> to
            do. Each one names the production failure it exists to prevent, and each one links to a
            test that fails if it stops holding.
          </>
        }
        actions={
          <>
            <div className="relative">
              <input
                ref={searchRef}
                className="input w-72 pl-7"
                placeholder="Search rules and failures"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
              <span className="pointer-events-none absolute top-1.5 left-2 text-[12px] text-ink-faint">
                ⌕
              </span>
              {search.length === 0 && (
                <span className="kbd pointer-events-none absolute top-1.5 right-2">/</span>
              )}
            </div>
            <a href={REPO} target="_blank" rel="noreferrer" className="btn">
              Repository ↗
            </a>
          </>
        }
        tabs={
          <div className="flex flex-wrap items-center gap-1.5 pb-3">
            <span className="text-[10px] tracking-wide text-ink-faint uppercase">family</span>
            {FAMILIES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setFamily(family === option ? null : option);
                }}
                className={clsx(
                  'rounded border px-1.5 py-px text-[11px] transition-colors',
                  family === option
                    ? 'border-accent-dim bg-accent-wash text-accent'
                    : 'border-line text-ink-dim hover:border-line-strong hover:text-ink',
                )}
              >
                {option}
                <span className="ml-1.5 font-mono text-[10px] text-ink-faint">
                  {ALL.filter((entry) => entry.family === option).length}
                </span>
              </button>
            ))}
          </div>
        }
      />

      <Scroll>
        <div className="mx-auto max-w-6xl px-4 py-5">
          {/* ── the thesis ─────────────────────────────────────────────────── */}
          <section className="mb-6 overflow-hidden rounded-lg border border-line bg-surface">
            <div className="grid gap-0 md:grid-cols-[1.3fr_1fr]">
              <div className="p-6">
                <h2 className="mb-2 text-[17px] leading-snug font-semibold text-ink">
                  Anyone can wire a provider SDK to a cron job.
                </h2>
                <p className="text-[13px] leading-relaxed text-ink-dim">
                  What separates a messaging system that works in a demo from one that works in
                  production is a set of guarantees about what it will refuse to do — and whether
                  those guarantees survive contact with concurrency, retries, timezones and a
                  customer who changes their mind.
                </p>
                <p className="mt-3 text-[13px] leading-relaxed text-ink-dim">
                  Each entry below is written as a rule and a <b className="text-ink">failure</b>,
                  because a rule with no failure attached is a preference. The failures are
                  specific, and most of them have happened to somebody.
                </p>
              </div>
              <div className="grid grid-cols-3 divide-x divide-line border-t border-line md:border-t-0 md:border-l">
                <Metric value={MESSAGING.length} label="messaging" sub="I1–I14" />
                <Metric value={AI.length} label="AI" sub="V1–V10" />
                <Metric
                  value={ALL.filter((entry) => entry.status === 'proven').length}
                  label="fully proven"
                  sub={`${String(ALL.filter((entry) => entry.status === 'partial').length)} partial`}
                />
              </div>
            </div>
          </section>

          {shown === 0 ? (
            <EmptyState
              glyph="⌕"
              title="No invariant matches this filter"
              detail={`${String(ALL.length)} are defined; none of them match.`}
              action={
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setSearch('');
                    setFamily(null);
                  }}
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <>
              {messaging.length > 0 && (
                <Group
                  eyebrow="Part one"
                  title="Messaging"
                  blurb="Fourteen named tests that run as their own CI job. They are about delivery, consent, time, measurement and the ability to explain a decision after the fact."
                  entries={messaging}
                />
              )}
              {ai.length > 0 && (
                <Group
                  eyebrow="Part two"
                  title="The AI layer"
                  blurb="Ten more, for the reply-triage layer. The thesis of all of them is the first: the model is an addition to a system that is already correct without it, and it can only ever add protection."
                  entries={ai}
                />
              )}
            </>
          )}

          <p className="mt-8 border-t border-line pt-4 text-[11px] leading-relaxed text-ink-faint">
            Rules and failure stories are transcribed from{' '}
            <a
              href={`${BLOB}README.md`}
              target="_blank"
              rel="noreferrer"
              className="text-ink-dim hover:text-accent"
            >
              README.md
            </a>{' '}
            and{' '}
            <a
              href={`${BLOB}docs/DECISIONS.md`}
              target="_blank"
              rel="noreferrer"
              className="text-ink-dim hover:text-accent"
            >
              docs/DECISIONS.md
            </a>
            ; status comes from{' '}
            <a
              href={`${BLOB}TRACKER.md`}
              target="_blank"
              rel="noreferrer"
              className="text-ink-dim hover:text-accent"
            >
              TRACKER.md
            </a>
            , which the README names as the accurate record — including where it says something is
            only partly done. This page is static text: it is the repository&rsquo;s claim,
            rendered, and it does not query the API to check whether the tests passed.
          </p>
        </div>
      </Scroll>
    </>
  );
}

function Metric({ value, label, sub }: { value: number; label: string; sub: string }) {
  return (
    <div className="px-4 py-6 text-center">
      <div className="text-3xl leading-none font-semibold tabular-nums text-ink">{value}</div>
      <div className="mt-1.5 text-[12px] text-ink-dim">{label}</div>
      <div className="mt-0.5 font-mono text-[10px] text-ink-faint">{sub}</div>
    </div>
  );
}

function Group({
  eyebrow,
  title,
  blurb,
  entries,
}: {
  eyebrow: string;
  title: string;
  blurb: string;
  entries: readonly Invariant[];
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 border-b border-line pb-3">
        <div className="font-mono text-[10px] tracking-widest text-accent uppercase">{eyebrow}</div>
        <h2 className="mt-1 text-[16px] font-semibold text-ink">{title}</h2>
        <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-ink-dim">{blurb}</p>
      </div>
      <ul className="grid gap-2.5 lg:grid-cols-2">
        {entries.map((entry) => (
          <Card key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function Card({ entry }: { entry: Invariant }) {
  const file = entry.test.slice(entry.test.lastIndexOf('/') + 1);
  return (
    <li className="group flex flex-col rounded-md border border-line bg-surface transition-colors hover:border-line-strong">
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="grid size-8 shrink-0 place-items-center rounded border border-line-strong bg-ground font-mono text-[12px] font-semibold text-accent">
          {entry.id}
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Pill tone={FAMILY_TONE[entry.family]}>{entry.family}</Pill>
            {entry.status === 'partial' && (
              <Pill tone="held" title="TRACKER.md marks part of this invariant as still unwritten.">
                partly proven
              </Pill>
            )}
          </div>
          <p className="text-[13px] leading-relaxed text-ink">{entry.rule}</p>
        </div>
      </div>

      <div className="mt-3 border-l-2 border-bad/50 bg-bad-wash/40 px-4 py-2.5 mx-4 rounded-r">
        <div className="mb-1 text-[10px] tracking-widest text-bad/90 uppercase">
          the failure it prevents
        </div>
        <p className="text-[12px] leading-relaxed text-ink-dim">{entry.prevents}</p>
      </div>

      <a
        href={`${BLOB}${entry.test}`}
        target="_blank"
        rel="noreferrer"
        className="mt-3 flex items-center gap-2 border-t border-line px-4 py-2.5 text-[11px] text-ink-faint transition-colors hover:bg-raised hover:text-accent"
      >
        <span className="font-mono">⛨</span>
        <span className="truncate font-mono">{file}</span>
        <span className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
          view on GitHub ↗
        </span>
      </a>
    </li>
  );
}
