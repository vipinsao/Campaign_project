import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../lib/api.ts';
import type {
  ContactResponse,
  DecisionRow,
  DecisionsResponse,
  EstimateResponse,
  OrderLookupResponse,
  OrderSummary,
  QueueResponse,
  QueueRow,
} from '../lib/types.ts';
import { PageHeader, Scroll } from '../components/Layout.tsx';
import { ChannelBadge, DecisionChip, Pill, QueueStatusPill, ReasonChip } from '../components/Pill.tsx';
import { EmptyState, ErrorState, LoadingState } from '../components/States.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import { DASH, initials, money, relative, timestamp } from '../lib/format.ts';

/**
 * “Why didn’t this customer get the email?”
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * This page is the reason the rest of the system logs what it logs. Three
 * questions, answered in one screen and in this order, because that is the order
 * a support conversation actually goes in:
 *
 *   what WAS sent          every message, with the times it moved
 *   what is STILL COMING   everything queued, with when it is due
 *   what did NOT fire      every decision that said no, with the exact
 *                          `reason_detail` the engine wrote at the time
 *
 * The third is the one no other tool has, and it is not reconstructed here: it is
 * read straight out of `send_decisions`, which is written by the send path itself
 * on every enqueue AND every skip (I14). The reason code comes from a closed
 * vocabulary and the canned sentence for it is sent by the server in `glossary`,
 * so this client never keeps its own copy of a vocabulary that would drift.
 *
 * AMBIGUITY IS NEVER RESOLVED FOR YOU. Order numbers are unique per store, not
 * per tenant, so `/orders/lookup` answers 300 Multiple Choices with every
 * candidate and no choice made (I13). Picking the most recent match would put one
 * customer's order details in front of a support agent handling a different
 * customer — a data breach that looks exactly like a working feature. So this page
 * shows a chooser and refuses to guess. The same rule is applied to an email
 * address that matches more than one contact.
 * ═════════════════════════════════════════════════════════════════════════════
 */

type Target =
  | { readonly kind: 'contact'; readonly contactId: string; readonly via: string }
  | { readonly kind: 'order'; readonly order: OrderSummary; readonly via: string };

type Lookup =
  | { readonly state: 'idle' }
  | { readonly state: 'searching' }
  | { readonly state: 'none'; readonly query: string; readonly mode: 'order' | 'email' }
  | { readonly state: 'ambiguous-orders'; readonly query: string; readonly candidates: readonly OrderSummary[]; readonly message: string; readonly disambiguateBy: string }
  | { readonly state: 'ambiguous-contacts'; readonly query: string; readonly candidates: EstimateResponse['sample']; readonly total: number }
  | { readonly state: 'resolved'; readonly target: Target }
  | { readonly state: 'failed'; readonly error: unknown };

function looksLikeEmail(value: string): boolean {
  return value.includes('@');
}

export function InspectPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState('');
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, []);

  async function resolve(raw: string) {
    const query = raw.trim();
    if (query.length === 0) return;
    setLookup({ state: 'searching' });
    try {
      if (looksLikeEmail(query)) {
        /**
         * There is no `GET /contacts?email=`, so the resolution goes through the
         * audience compiler — the same compiled predicate the campaign estimate
         * uses, with the address bound as a parameter and never spliced into SQL.
         * A second lookup path would be a second answer to "who is this", and the
         * two would disagree the first time one of them was changed.
         */
        const found = await api.post<EstimateResponse>('/audience/estimate', {
          audience: { all: [{ field: 'email', op: 'eq', value: query }] },
          sampleSize: 25,
        });
        const first = found.sample[0];
        if (found.count === 0 || first === undefined) {
          setLookup({ state: 'none', query, mode: 'email' });
        } else if (found.count === 1) {
          setLookup({
            state: 'resolved',
            target: { kind: 'contact', contactId: first.id, via: `email ${query}` },
          });
        } else {
          setLookup({ state: 'ambiguous-contacts', query, candidates: found.sample, total: found.count });
        }
        return;
      }

      const result = await api.get<OrderLookupResponse>('/orders/lookup', { number: query }, [300]);
      if (result.kind === 'none') {
        setLookup({ state: 'none', query, mode: 'order' });
      } else if (result.kind === 'single') {
        setLookup({ state: 'resolved', target: { kind: 'order', order: result.match, via: `order ${query}` } });
      } else {
        setLookup({
          state: 'ambiguous-orders',
          query,
          candidates: result.candidates,
          message: result.message,
          disambiguateBy: result.disambiguateBy,
        });
      }
    } catch (error) {
      setLookup({ state: 'failed', error });
    }
  }

  return (
    <>
      <PageHeader
        title="Inspect"
        subtitle={
          <>
            An order number or an email address, and the whole story: what was sent, what is still
            coming, and — the part no log will tell you — what did not fire and why.
          </>
        }
        actions={
          lookup.state === 'resolved' || lookup.state === 'ambiguous-orders' || lookup.state === 'ambiguous-contacts' ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setLookup({ state: 'idle' });
                setTerm('');
                inputRef.current?.focus();
              }}
            >
              New search
            </button>
          ) : undefined
        }
      />

      <Scroll>
        <div className="p-3">
          <form
            className="mx-auto max-w-3xl"
            onSubmit={(event) => {
              event.preventDefault();
              void resolve(term);
            }}
          >
            <div className="relative">
              <input
                ref={inputRef}
                className="input h-11 pl-9 text-[15px]"
                placeholder="10423   or   jane@example.com"
                value={term}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => { setTerm(event.target.value); }}
              />
              <span className="pointer-events-none absolute top-3 left-3 text-[14px] text-ink-faint">⌖</span>
              <span className="absolute top-2.5 right-2.5 flex items-center gap-2">
                {term.trim().length > 0 && (
                  <span className="rounded border border-line-strong bg-raised px-1.5 py-px font-mono text-[10px] text-ink-faint">
                    {looksLikeEmail(term) ? 'email' : 'order number'}
                  </span>
                )}
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={term.trim().length === 0 || lookup.state === 'searching'}
                >
                  {lookup.state === 'searching' ? 'Resolving…' : 'Resolve'}
                </button>
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
              An order number is looked up across every store in the tenant. If it exists in more
              than one, you will be asked which — nothing is chosen for you, because order numbers
              are unique per store and the wrong guess shows one customer another customer&rsquo;s
              order.
            </p>
          </form>
        </div>

        {lookup.state === 'idle' && (
          <EmptyState
            glyph="⌖"
            title="Nothing looked up yet"
            detail="Paste the order number from a customer’s email, or their address. This page reads the decision log, so it can answer for a message that was never sent."
          />
        )}
        {lookup.state === 'searching' && <LoadingState rows={4} label="Resolving recipient" />}
        {lookup.state === 'failed' && (
          <ErrorState error={lookup.error} title="The lookup failed" onRetry={() => void resolve(term)} />
        )}
        {lookup.state === 'none' && (
          <EmptyState
            glyph="∅"
            title={
              lookup.mode === 'order'
                ? `No order in this tenant has the number ${lookup.query}`
                : `No contact in this tenant has the address ${lookup.query}`
            }
            detail="The lookup succeeded and matched nothing. That is a different answer from the lookup failing, and it is shown differently on purpose."
          />
        )}
        {lookup.state === 'ambiguous-orders' && (
          <OrderChooser
            lookup={lookup}
            onPick={(order) => {
              setLookup({ state: 'resolved', target: { kind: 'order', order, via: `order ${lookup.query}` } });
            }}
          />
        )}
        {lookup.state === 'ambiguous-contacts' && (
          <ContactChooser
            query={lookup.query}
            total={lookup.total}
            candidates={lookup.candidates}
            onPick={(contactId) => {
              setLookup({
                state: 'resolved',
                target: { kind: 'contact', contactId, via: `email ${lookup.query}` },
              });
            }}
          />
        )}
        {lookup.state === 'resolved' && <Story target={lookup.target} />}
      </Scroll>
    </>
  );
}

// ── the chooser (I13) ────────────────────────────────────────────────────────

function AmbiguityBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-3 mt-3 overflow-hidden rounded-md border border-held/40 bg-held-wash">
      <div className="flex items-start gap-3 border-l-2 border-held px-4 py-3">
        <span className="mt-px font-mono text-[14px] text-held select-none">⑂</span>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

function OrderChooser({
  lookup,
  onPick,
}: {
  lookup: Extract<Lookup, { state: 'ambiguous-orders' }>;
  onPick: (order: OrderSummary) => void;
}) {
  return (
    <div className="pb-6">
      <AmbiguityBanner>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-held">
            {lookup.candidates.length} orders carry the number {lookup.query}
          </span>
          <span className="rounded border border-held/40 bg-ground/40 px-1.5 py-px font-mono text-[10px] text-held">
            300 · multiple choices
          </span>
        </div>
        <p className="text-[12px] leading-relaxed text-ink-dim">{lookup.message}</p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint">
          Order numbers are unique per store, not per tenant. The API returned every match and chose
          none, and this screen does the same — the addresses below are masked because these
          candidates belong to <b className="text-ink-dim">different customers</b>, and picking one
          is a decision a person makes, not a <code className="font-mono">LIMIT 1</code>.
        </p>
      </AmbiguityBanner>

      <ul className="mx-3 mt-3 grid gap-2 md:grid-cols-2">
        {lookup.candidates.map((candidate) => (
          <li key={candidate.id}>
            <button
              type="button"
              onClick={() => { onPick(candidate); }}
              className="w-full rounded-md border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-accent-dim hover:bg-raised focus-visible:border-accent"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">{candidate.storeName}</div>
                  <div className="font-mono text-[11px] text-ink-faint">
                    {lookup.disambiguateBy}={candidate.storeId.slice(0, 8)}… · {candidate.storeCode}
                  </div>
                </div>
                <Pill tone="quiet">{candidate.status}</Pill>
              </div>
              <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
                <div>
                  <dt className="text-[10px] tracking-wide text-ink-faint uppercase">Placed</dt>
                  <dd className="text-ink-dim">{timestamp(candidate.placedAt)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] tracking-wide text-ink-faint uppercase">Total</dt>
                  <dd className="num text-ink-dim">{money(candidate.total, candidate.currency)}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-[10px] tracking-wide text-ink-faint uppercase">Customer</dt>
                  <dd className="font-mono text-[11px] text-ink-dim">
                    {candidate.contactEmailHint ?? DASH}
                  </dd>
                </div>
              </dl>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ContactChooser({
  query,
  total,
  candidates,
  onPick,
}: {
  query: string;
  total: number;
  candidates: EstimateResponse['sample'];
  onPick: (contactId: string) => void;
}) {
  return (
    <div className="pb-6">
      <AmbiguityBanner>
        <div className="mb-1 text-[13px] font-semibold text-held">
          {total} contacts match {query}
        </div>
        <p className="text-[12px] leading-relaxed text-ink-dim">
          The same rule applies as for an ambiguous order number: nothing is chosen for you. Pick the
          contact whose story you want.
        </p>
        {candidates.length < total && (
          <p className="mt-1.5 text-[12px] text-ink-faint">
            Showing the first {candidates.length} of {total}.
          </p>
        )}
      </AmbiguityBanner>
      <ul className="mx-3 mt-3 grid gap-2 md:grid-cols-3">
        {candidates.map((candidate) => (
          <li key={candidate.id}>
            <button
              type="button"
              onClick={() => { onPick(candidate.id); }}
              className="w-full rounded-md border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-accent-dim hover:bg-raised"
            >
              <div className="truncate text-[13px] text-ink">
                {[candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || '(no name)'}
              </div>
              <div className="truncate font-mono text-[11px] text-ink-faint">
                {candidate.email ?? candidate.phone ?? DASH}
              </div>
              <div className="mt-1 font-mono text-[10px] text-ink-faint">{candidate.id.slice(0, 8)}…</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── the story ────────────────────────────────────────────────────────────────

const PENDING_STATUSES = new Set(['pending', 'processing']);

function Story({ target }: { target: Target }) {
  const contactId = target.kind === 'contact' ? target.contactId : target.order.contactId;
  const orderId = target.kind === 'order' ? target.order.id : null;

  const contact = useQuery({
    queryKey: ['contact', contactId],
    queryFn: () => api.get<ContactResponse>(`/contacts/${contactId}`),
  });
  const queue = useQuery({
    queryKey: ['queue', 'contact', contactId],
    queryFn: () => api.get<QueueResponse>('/queue', { contactId, limit: 200 }),
  });
  const byContact = useQuery({
    queryKey: ['decisions', 'contact', contactId],
    queryFn: () => api.get<DecisionsResponse>('/decisions', { contactId, limit: 200 }),
  });
  const byOrder = useQuery({
    queryKey: ['decisions', 'order', orderId],
    queryFn: () => api.get<DecisionsResponse>('/decisions', { orderId, limit: 200 }),
    enabled: orderId !== null,
  });

  const messages = queue.data?.messages ?? [];
  const sent = messages.filter((row) => row.sent_at !== null);
  const pending = messages.filter((row) => PENDING_STATUSES.has(row.status));
  const stopped = messages.filter(
    (row) => row.sent_at === null && !PENDING_STATUSES.has(row.status),
  );

  // Merged, de-duplicated by id: a decision taken about an order may carry no
  // contact, and one taken about a contact may carry no order. Both belong here.
  const decisionsById = new Map<string, DecisionRow>();
  for (const row of [...(byContact.data?.decisions ?? []), ...(byOrder.data?.decisions ?? [])]) {
    decisionsById.set(row.id, row);
  }
  const decisions = [...decisionsById.values()].sort((a, b) =>
    b.decided_at.localeCompare(a.decided_at),
  );
  const glossary = { ...(byContact.data?.glossary ?? {}), ...(byOrder.data?.glossary ?? {}) };
  const refusals = decisions.filter((row) => row.decision !== 'proceed');

  const decisionsPending = byContact.isPending || (orderId !== null && byOrder.isPending);
  const decisionsError = byContact.isError ? byContact.error : byOrder.isError ? byOrder.error : null;

  return (
    <div className="space-y-3 p-3">
      {/* ── who ──────────────────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Resolved</span>
          <span className="font-mono text-[11px] text-ink-faint">via {target.via}</span>
        </div>

        {contact.isPending ? (
          <LoadingState rows={2} label="Loading contact" />
        ) : contact.isError ? (
          <ErrorState error={contact.error} onRetry={() => void contact.refetch()} />
        ) : (
          <div className="flex flex-wrap items-start gap-5 p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-full border border-line-strong bg-raised text-[14px] font-semibold text-ink-dim">
                {initials(
                  contact.data.contact.firstName,
                  contact.data.contact.lastName,
                  contact.data.contact.email ?? '?',
                )}
              </span>
              <div className="min-w-0">
                <Link
                  to={`/contacts/${contactId}`}
                  className="block truncate text-[14px] font-semibold text-ink hover:text-accent"
                >
                  {[contact.data.contact.firstName, contact.data.contact.lastName]
                    .filter(Boolean)
                    .join(' ') || '(no name on record)'}
                </Link>
                <div className="truncate font-mono text-[11px] text-ink-faint">
                  {contact.data.contact.email ?? DASH} · {contact.data.contact.phone ?? DASH}
                </div>
              </div>
            </div>

            <dl className="flex flex-wrap gap-x-6 gap-y-2">
              <Fact label="Timezone">
                {contact.data.contact.timezone ?? (
                  <Tooltip
                    content={
                      <div className="text-ink-dim">
                        No timezone on this contact, so quiet hours fall back to the tenant default —
                        never to the server&rsquo;s zone.
                      </div>
                    }
                  >
                    <span className="text-ink-faint underline decoration-dotted underline-offset-4">
                      {DASH} tenant default
                    </span>
                  </Tooltip>
                )}
              </Fact>
              <Fact label="Orders">{contact.data.contact.orderCount}</Fact>
              <Fact label="Lifetime value">
                {money(contact.data.contact.lifetimeValue, 'USD')}
              </Fact>
              <Fact label="Queued">{contact.data.messages.queued}</Fact>
              <Fact label="Sent">{contact.data.messages.sent}</Fact>
              <Fact label="Cancelled">{contact.data.messages.cancelled}</Fact>
            </dl>
          </div>
        )}

        {target.kind === 'order' && (
          <div className="border-t border-line px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <div>
                <div className="text-[10px] tracking-wide text-ink-faint uppercase">Order</div>
                <div className="font-mono text-[13px] text-ink">#{target.order.orderNumber}</div>
              </div>
              <Fact label="Store">
                {target.order.storeName}{' '}
                <span className="font-mono text-[11px] text-ink-faint">{target.order.storeCode}</span>
              </Fact>
              <Fact label="Status">
                <Pill tone="quiet">{target.order.status}</Pill>
              </Fact>
              <Fact label="Placed">{timestamp(target.order.placedAt)}</Fact>
              <Fact label="Total">{money(target.order.total, target.order.currency)}</Fact>
            </div>
          </div>
        )}
      </section>

      {/* ── sent ─────────────────────────────────────────────────────────── */}
      <Section
        title="What was sent"
        count={sent.length}
        hint="handed to a provider — every timestamp is a row in the queue, not an inference"
      >
        {queue.isPending ? (
          <LoadingState rows={4} label="Loading messages" />
        ) : queue.isError ? (
          <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
        ) : sent.length === 0 ? (
          <EmptyState
            compact
            glyph="∅"
            title="Nothing has been sent to this contact"
            detail="No queue row has a send timestamp. If you expected one, the refusals below will say which gate stopped it."
          />
        ) : (
          <ol className="divide-y divide-line">
            {sent.map((row) => (
              <SentRow key={row.id} row={row} />
            ))}
          </ol>
        )}
      </Section>

      {/* ── pending ──────────────────────────────────────────────────────── */}
      <Section
        title="What is still coming"
        count={pending.length}
        hint="scheduled, not yet handed to a provider"
      >
        {queue.isPending ? (
          <LoadingState rows={3} label="Loading queue" />
        ) : queue.isError ? (
          <ErrorState error={queue.error} />
        ) : pending.length === 0 ? (
          <EmptyState
            compact
            glyph="◷"
            title="Nothing is queued for this contact"
            detail="A genuine empty result: no row in message_queue is pending or processing."
          />
        ) : (
          <ol className="divide-y divide-line">
            {pending.map((row) => (
              <PendingRow key={row.id} row={row} />
            ))}
          </ol>
        )}
      </Section>

      {/* ── did not fire ─────────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">
            <span className="mr-1.5 text-bad">✕</span>
            What did not fire
          </span>
          <span className="text-[11px] text-ink-faint">
            straight from <code className="font-mono">send_decisions</code> — every skip and every
            deferral, with the reason recorded at the time
          </span>
        </div>

        {decisionsPending ? (
          <LoadingState rows={5} label="Loading the decision log" />
        ) : decisionsError !== null ? (
          <ErrorState error={decisionsError} title="The decision log did not load" />
        ) : refusals.length === 0 ? (
          <EmptyState
            glyph="✓"
            title="Nothing was refused for this recipient"
            detail={
              decisions.length === 0
                ? 'No decision rows exist at all — this recipient has never been evaluated by a campaign.'
                : `${String(decisions.length)} decisions are recorded and every one of them proceeded.`
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {refusals.map((row) => (
              <RefusalRow key={row.id} row={row} glossary={glossary} />
            ))}
          </ul>
        )}

        {stopped.length > 0 && (
          <div className="border-t border-line px-4 py-3">
            <div className="mb-2 text-[11px] tracking-wide text-ink-faint uppercase">
              Queued, then stopped before sending
            </div>
            <ul className="space-y-1.5">
              {stopped.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                  <QueueStatusPill status={row.status} />
                  <ChannelBadge channel={row.channel} />
                  <span className="text-ink-dim">{row.campaign_name}</span>
                  {row.provider_error_code !== null && (
                    <Pill tone={row.error_class === 'terminal' ? 'bad' : 'held'} mono>
                      {row.provider_error_code}
                    </Pill>
                  )}
                  <span className="text-[11px] text-ink-faint">
                    scheduled {timestamp(row.scheduled_at)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <p className="px-1 pb-2 text-[11px] leading-relaxed text-ink-faint">
        Both lists above are capped at the endpoint&rsquo;s maximum page of 200 rows. Nothing on this
        page is computed from a counter: the messages come from{' '}
        <code className="font-mono">message_queue</code> and the refusals from{' '}
        <code className="font-mono">send_decisions</code>, which the send path writes as it decides.
      </p>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-ink-faint uppercase">{label}</dt>
      <dd className="text-[12px] text-ink-dim">{children}</dd>
    </div>
  );
}

function Section({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count: number;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">
          {title}
          <span className="ml-2 rounded bg-raised px-1.5 py-px font-mono text-[10px] text-ink-faint">
            {count}
          </span>
        </span>
        <span className="max-w-md text-right text-[11px] leading-snug text-ink-faint">{hint}</span>
      </div>
      {children}
    </section>
  );
}

function SentRow({ row }: { row: QueueRow }) {
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ChannelBadge channel={row.channel} />
        <QueueStatusPill status={row.status} />
        <Link
          to={`/campaigns/${row.campaign_id}/overview`}
          className="text-[12px] text-ink hover:text-accent"
        >
          {row.campaign_name}
        </Link>
        <span className="truncate text-[12px] text-ink-dim">{row.rendered_subject ?? ''}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px]">
        <span className="text-ink-faint">
          to <span className="text-ink-dim">{row.recipient_address}</span>
        </span>
        <span className="text-ink-faint">
          sent <span className="text-ink-dim">{timestamp(row.sent_at)}</span>
        </span>
        <span className="text-ink-faint">
          delivered{' '}
          {row.delivered_at === null ? (
            <Tooltip
              content={
                <div className="text-ink-dim">
                  <span className="font-mono">delivered</span> is written only by a provider receipt
                  and is never inferred from <span className="font-mono">sent</span>. No receipt has
                  arrived, so this is unknown — not &ldquo;not delivered&rdquo;.
                </div>
              }
            >
              <span className="text-ink-faint underline decoration-dotted underline-offset-4">
                {DASH}
              </span>
            </Tooltip>
          ) : (
            <span className="text-ok">{timestamp(row.delivered_at)}</span>
          )}
        </span>
        {row.attempts > 1 && <span className="text-ink-faint">attempts {row.attempts}</span>}
        {row.deferrals > 0 && <span className="text-held">deferrals {row.deferrals}</span>}
      </div>
    </li>
  );
}

function PendingRow({ row }: { row: QueueRow }) {
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ChannelBadge channel={row.channel} />
        <QueueStatusPill status={row.status} />
        <Link
          to={`/campaigns/${row.campaign_id}/overview`}
          className="text-[12px] text-ink hover:text-accent"
        >
          {row.campaign_name}
        </Link>
        <span className="truncate text-[12px] text-ink-dim">{row.rendered_subject ?? ''}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
        <span className="font-mono text-ink-faint">
          due <span className="text-ink">{timestamp(row.scheduled_at)}</span>{' '}
          <span className="text-ink-dim">({relative(row.scheduled_at)})</span>
        </span>
        {row.next_attempt_at !== null && (
          <span className="font-mono text-ink-faint">
            next attempt <span className="text-ink-dim">{timestamp(row.next_attempt_at)}</span>
          </span>
        )}
        {row.deferrals > 0 && (
          <Tooltip
            content={
              <div className="text-ink-dim">
                Held back {row.deferrals} time{row.deferrals === 1 ? '' : 's'} — quiet hours, a pause
                or a frequency cap. A deferral is the system working and does not consume a delivery
                attempt.
              </div>
            }
          >
            <span className="text-held underline decoration-dotted underline-offset-4">
              deferred {row.deferrals}×
            </span>
          </Tooltip>
        )}
      </div>
    </li>
  );
}

/**
 * One refusal.
 *
 * `reason_detail` is rendered VERBATIM and is the headline. The glossary sentence
 * underneath is the canned description of the code, labelled as such, so the two
 * are never confused: the detail is what happened to this recipient, the glossary
 * is what the code means in general.
 */
function RefusalRow({ row, glossary }: { row: DecisionRow; glossary: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const canned = glossary[row.reason_code];
  const inputs = row.inputs;

  return (
    <li className={clsx('px-4 py-3', row.decision === 'skip' ? 'border-l-2 border-bad' : 'border-l-2 border-held')}>
      <div className="flex flex-wrap items-center gap-2">
        <DecisionChip decision={row.decision} />
        <ReasonChip code={row.reason_code} />
        <span className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          {row.stage}
        </span>
        <span className="ml-auto text-[11px] text-ink-faint" title={timestamp(row.decided_at)}>
          {relative(row.decided_at)}
        </span>
      </div>

      <p className="mt-1.5 text-[13px] leading-relaxed text-ink">
        {row.reason_detail ?? (
          <span className="text-ink-faint italic">
            {DASH} no detail was recorded for this decision
          </span>
        )}
      </p>

      {canned !== undefined && (
        <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
          <span className="mr-1 rounded bg-raised px-1 font-mono text-[10px]">code</span>
          {canned}
        </p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">
        {row.campaign_id !== null && (
          <Link to={`/campaigns/${row.campaign_id}/overview`} className="text-ink-faint hover:text-accent">
            campaign {row.campaign_id.slice(0, 8)}…
          </Link>
        )}
        {row.message_queue_id !== null && (
          <span className="font-mono text-ink-faint">queue {row.message_queue_id.slice(0, 8)}…</span>
        )}
        {inputs !== null && Object.keys(inputs).length > 0 && (
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => { setOpen(!open); }}
            aria-expanded={open}
          >
            {open ? 'hide' : 'show'} the inputs it was evaluated from
          </button>
        )}
      </div>

      {open && inputs !== null && (
        <pre className="mt-2 overflow-x-auto rounded border border-line bg-ground p-2.5 font-mono text-[11px] leading-relaxed text-ink-dim">
          {JSON.stringify(inputs, null, 2)}
        </pre>
      )}
    </li>
  );
}
