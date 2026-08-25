import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CampaignCategory, Channel } from '@campaign/shared';
import type { CampaignCategory as Category, Channel as Chan } from '@campaign/shared';
import { api } from '../lib/api.ts';
import type {
  ConsentLedgerRow,
  ConsentResponse,
  ContactResponse,
  QueueResponse,
  SuppressionRow,
} from '../lib/types.ts';
import { PageHeader, Scroll } from '../components/Layout.tsx';
import { ChannelBadge, Pill, QueueStatusPill } from '../components/Pill.tsx';
import { EmptyState, ErrorState, LoadingState } from '../components/States.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import { DASH, initials, money, relative, timestamp, titleCase } from '../lib/format.ts';

/**
 * One contact, and the four things that decide whether they get mail.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A screen that shows only "opted in: yes" cannot explain itself, and the ticket
 * it produces is always the same one: opted in, mail still not going out. The
 * answer is usually three rows further down — an address-level suppression, or a
 * pause. So all four are on this page, side by side:
 *
 *   the LEDGER        every consent event ever recorded, append-only
 *   the RESOLVED state derived from that ledger by the same SQL the send gate calls
 *   SUPPRESSIONS      address-level, and they outlive the contact record
 *   PAUSES            a temporary hold with an end date
 *
 * The ledger is rendered in full rather than summarised, and the timeline says
 * append-only where an operator can see it, because that is the property that
 * makes it evidence: `contact_consents` carries a trigger that refuses UPDATE and
 * DELETE outright. A correction is a new row, and the previous state survives —
 * which is the difference between answering "are they opted in?" and answering
 * "were they opted in on 4 March, and where did that consent come from?".
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function ContactPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();

  const contact = useQuery({
    queryKey: ['contact', id],
    queryFn: () => api.get<ContactResponse>(`/contacts/${id}`),
  });
  const consent = useQuery({
    queryKey: ['contact-consent', id],
    queryFn: () => api.get<ConsentResponse>(`/contacts/${id}/consent`),
  });
  const queue = useQuery({
    queryKey: ['queue', 'contact', id],
    queryFn: () => api.get<QueueResponse>('/queue', { contactId: id, limit: 200 }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['contact-consent', id] });
    void queryClient.invalidateQueries({ queryKey: ['queue', 'contact', id] });
  };

  if (contact.isPending) {
    return (
      <>
        <PageHeader title="Contact" />
        <LoadingState rows={10} label="Loading contact" />
      </>
    );
  }
  if (contact.isError) {
    return (
      <>
        <PageHeader title="Contact" />
        <ErrorState error={contact.error} onRetry={() => void contact.refetch()} />
      </>
    );
  }

  const person = contact.data.contact;
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ');
  const messages = queue.data?.messages ?? [];

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="grid size-6 place-items-center rounded-full border border-line-strong bg-raised text-[11px] font-semibold text-ink-dim">
              {initials(person.firstName, person.lastName, person.email ?? '?')}
            </span>
            {name || '(no name on record)'}
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px]">
            <span className="text-ink-dim">{person.email ?? DASH}</span>
            <span className="text-ink-dim">{person.phone ?? DASH}</span>
            <span className="text-ink-faint">{person.id}</span>
          </span>
        }
        actions={
          <Link to="/inspect" className="btn">
            Inspect a message
          </Link>
        }
      />

      <Scroll>
        <div className="grid gap-3 p-3 xl:grid-cols-[340px_1fr]">
          <div className="space-y-3">
            {/* ── profile ─────────────────────────────────────────────────── */}
            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">Profile</span>
              </div>
              <dl className="divide-y divide-line text-[12px]">
                <Field label="Timezone">
                  {person.timezone ?? (
                    <Tooltip
                      align="left"
                      content={
                        <div className="text-ink-dim">
                          No timezone on this contact. Quiet hours fall back to the tenant default —
                          never to the server&rsquo;s zone, which on a UTC server looks correct for
                          about one sixth of the world.
                        </div>
                      }
                    >
                      <span className="text-ink-faint underline decoration-dotted underline-offset-4">
                        {DASH} tenant default
                      </span>
                    </Tooltip>
                  )}
                </Field>
                <Field label="Locale">{person.locale}</Field>
                <Field label="External id">
                  {person.externalId ?? <span className="text-ink-faint">{DASH}</span>}
                </Field>
                <Field label="Orders">{person.orderCount}</Field>
                <Field label="Lifetime value">{money(person.lifetimeValue, 'USD')}</Field>
                <Field label="First order">
                  {person.firstOrderAt === null ? (
                    <span className="text-ink-faint">{DASH} — never ordered</span>
                  ) : (
                    timestamp(person.firstOrderAt)
                  )}
                </Field>
                <Field label="Last order">
                  {person.lastOrderAt === null ? (
                    <span className="text-ink-faint">{DASH}</span>
                  ) : (
                    timestamp(person.lastOrderAt)
                  )}
                </Field>
                <Field label="Created">{timestamp(person.createdAt)}</Field>
                <Field label="Tags">
                  {person.tags.length === 0 ? (
                    <span className="text-ink-faint">{DASH}</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {person.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-raised px-1 font-mono text-[10px] text-ink-faint"
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </Field>
              </dl>
              {Object.keys(person.attributes).length > 0 && (
                <div className="border-t border-line p-4">
                  <div className="label">Attributes</div>
                  <pre className="overflow-x-auto rounded border border-line bg-ground p-2 font-mono text-[11px] leading-relaxed text-ink-dim">
                    {JSON.stringify(person.attributes, null, 2)}
                  </pre>
                </div>
              )}
            </section>

            {/* ── suppressions ────────────────────────────────────────────── */}
            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">Suppression</span>
                <Tooltip
                  align="right"
                  content={
                    <div className="text-ink-dim">
                      Suppression is <b className="text-ink">address-level</b>, not contact-level.
                      It survives the contact record being recreated by an import, which is exactly
                      the case where a contact-level flag lets mail start flowing again to somebody
                      who said stop.
                    </div>
                  }
                >
                  <span className="text-[11px] text-ink-faint underline decoration-dotted underline-offset-4">
                    why by address
                  </span>
                </Tooltip>
              </div>
              {consent.isPending ? (
                <LoadingState rows={2} label="Loading suppressions" />
              ) : consent.isError ? (
                <ErrorState error={consent.error} onRetry={() => void consent.refetch()} />
              ) : consent.data.suppressions.length === 0 ? (
                <EmptyState
                  compact
                  glyph="✓"
                  title="No address of this contact is suppressed"
                  detail="Nothing blocks delivery at the address level. Consent and quiet hours are still evaluated separately."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {consent.data.suppressions.map((row, index) => (
                    <SuppressionItem key={`${row.address}-${index}`} row={row} />
                  ))}
                </ul>
              )}

              {consent.data !== undefined &&
                consent.data.pauses.some((pause) => pause.until !== null) && (
                  <div className="border-t border-line px-4 py-3">
                    <div className="mb-1.5 text-[10px] tracking-wide text-ink-faint uppercase">
                      Active pauses
                    </div>
                    <ul className="space-y-1">
                      {consent.data.pauses
                        .filter((pause) => pause.until !== null)
                        .map((pause) => (
                          <li key={pause.channel} className="flex items-center gap-2 text-[12px]">
                            <ChannelBadge channel={pause.channel} />
                            <span className="text-ink-dim">
                              held until {timestamp(pause.until)}{' '}
                              <span className="text-ink-faint">({relative(pause.until)})</span>
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
            </section>
          </div>

          <div className="space-y-3">
            {/* ── resolved consent ────────────────────────────────────────── */}
            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">Resolved consent</span>
                <span className="text-[11px] text-ink-faint">
                  derived from the ledger by the same function the send gate calls
                </span>
              </div>
              {consent.isPending ? (
                <LoadingState rows={3} label="Resolving consent" />
              ) : consent.isError ? (
                <ErrorState error={consent.error} />
              ) : (
                <ResolvedGrid resolved={consent.data.resolved} />
              )}
            </section>

            {/* ── ledger ──────────────────────────────────────────────────── */}
            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">
                  Consent ledger
                  <span className="ml-2 rounded bg-raised px-1.5 py-px font-mono text-[10px] text-ink-faint">
                    {consent.data?.ledger.length ?? '·'}
                  </span>
                </span>
                <Pill tone="info">append-only</Pill>
              </div>
              <p className="border-b border-line px-4 py-2 text-[11px] leading-relaxed text-ink-faint">
                Every row, newest first, including the ones that were superseded. The table refuses{' '}
                <code className="font-mono">UPDATE</code> and{' '}
                <code className="font-mono">DELETE</code> at the database level — a correction is a
                new row, so nothing here can be quietly rewritten later.
              </p>
              {consent.isPending ? (
                <LoadingState rows={6} label="Loading the ledger" />
              ) : consent.isError ? (
                <ErrorState error={consent.error} onRetry={() => void consent.refetch()} />
              ) : consent.data.ledger.length === 0 ? (
                <EmptyState
                  glyph="∅"
                  title="No consent has ever been recorded for this contact"
                  detail="An empty ledger is not the same as an opt-out: marketing has no opt-in to rely on, and the send gate refuses with consent_never_given rather than consent_opted_out."
                />
              ) : (
                <ol className="p-4">
                  {consent.data.ledger.map((row, index) => (
                    <LedgerItem
                      key={row.id}
                      row={row}
                      first={index === 0}
                      last={index === consent.data.ledger.length - 1}
                    />
                  ))}
                </ol>
              )}
              <RecordConsent contactId={id} onRecorded={invalidate} />
            </section>

            {/* ── messages ────────────────────────────────────────────────── */}
            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">
                  Message history
                  <span className="ml-2 rounded bg-raised px-1.5 py-px font-mono text-[10px] text-ink-faint">
                    {messages.length}
                  </span>
                </span>
                <span className="text-[11px] text-ink-faint">
                  {contact.data.messages.queued} queued · {contact.data.messages.sent} sent ·{' '}
                  {contact.data.messages.cancelled} cancelled
                </span>
              </div>
              {queue.isPending ? (
                <LoadingState rows={6} label="Loading messages" />
              ) : queue.isError ? (
                <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
              ) : messages.length === 0 ? (
                <EmptyState
                  glyph="✉"
                  title="This contact has never been queued a message"
                  detail="The request succeeded and returned no rows."
                />
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="th">Campaign</th>
                      <th className="th">Status</th>
                      <th className="th">Scheduled</th>
                      <th className="th">Sent</th>
                      <th className="th">Delivered</th>
                      <th className="th">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messages.map((row) => (
                      <tr key={row.id} className="border-b border-line/60">
                        <td className="cell max-w-[16rem]">
                          <div className="flex items-center gap-1.5">
                            <ChannelBadge channel={row.channel} />
                            <Link
                              to={`/campaigns/${row.campaign_id}/overview`}
                              className="truncate text-[12px] text-ink hover:text-accent"
                            >
                              {row.campaign_name}
                            </Link>
                          </div>
                          {row.rendered_subject !== null && (
                            <div className="truncate text-[11px] text-ink-faint">
                              {row.rendered_subject}
                            </div>
                          )}
                        </td>
                        <td className="cell">
                          <QueueStatusPill status={row.status} />
                        </td>
                        <td className="cell text-[11px] whitespace-nowrap text-ink-dim">
                          {timestamp(row.scheduled_at)}
                        </td>
                        <td className="cell text-[11px] whitespace-nowrap text-ink-dim">
                          {row.sent_at === null ? (
                            <span className="text-ink-faint">{DASH}</span>
                          ) : (
                            timestamp(row.sent_at)
                          )}
                        </td>
                        <td className="cell text-[11px] whitespace-nowrap">
                          {row.delivered_at === null ? (
                            <span className="text-ink-faint">{DASH}</span>
                          ) : (
                            <span className="text-ok">{timestamp(row.delivered_at)}</span>
                          )}
                        </td>
                        <td className="cell">
                          {row.provider_error_code === null ? (
                            <span className="text-[11px] text-ink-faint">
                              {row.provider ?? DASH}
                            </span>
                          ) : (
                            <Pill tone={row.error_class === 'terminal' ? 'bad' : 'held'} mono>
                              {row.provider_error_code}
                            </Pill>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </div>
      </Scroll>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2">
      <dt className="w-28 shrink-0 text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink-dim">{children}</dd>
    </div>
  );
}

// ── resolved state ───────────────────────────────────────────────────────────

function ResolvedGrid({ resolved }: { resolved: ConsentResponse['resolved'] }) {
  const categories = CampaignCategory.options;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th className="th">Channel</th>
            {categories.map((category) => (
              <th key={category} className="th">
                {titleCase(category)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Channel.options.map((channel) => (
            <tr key={channel} className="border-b border-line/60">
              <td className="cell">
                <ChannelBadge channel={channel} />
              </td>
              {categories.map((category) => {
                const state = resolved[channel]?.[category] ?? null;
                return (
                  <td key={category} className="cell">
                    {state === null ? (
                      <Tooltip
                        content={
                          <div className="text-ink-dim">
                            No opt-in and no opt-out on record. For a marketing category the send
                            gate refuses with <span className="font-mono">consent_never_given</span>
                            , which is a different refusal from{' '}
                            <span className="font-mono">consent_opted_out</span> and is logged as
                            such.
                          </div>
                        }
                      >
                        <span className="num text-ink-faint">{DASH}</span>
                      </Tooltip>
                    ) : state === 'opted_in' ? (
                      <Pill tone="ok">opted in</Pill>
                    ) : (
                      <Pill tone="bad">opted out</Pill>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-4 py-2.5 text-[11px] leading-relaxed text-ink-faint">
        Most recent intent wins, and a category-specific record beats a wildcard one. This grid is
        computed by the API with the same function the send-time gate calls, so the screen and the
        gate cannot disagree.
      </p>
    </div>
  );
}

// ── the ledger timeline ──────────────────────────────────────────────────────

function LedgerItem({
  row,
  first,
  last,
}: {
  row: ConsentLedgerRow;
  first: boolean;
  last: boolean;
}) {
  const [open, setOpen] = useState(false);
  const optedIn = row.state === 'opted_in';
  const evidence = row.evidence;

  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <div className="relative flex w-4 shrink-0 justify-center">
        {!last && <span className="absolute top-4 bottom-0 w-px bg-line" />}
        <span
          className={clsx(
            'relative z-10 mt-1 size-2.5 rounded-full border-2',
            optedIn ? 'border-ok bg-ok-wash' : 'border-bad bg-bad-wash',
          )}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={optedIn ? 'ok' : 'bad'}>{optedIn ? 'opted in' : 'opted out'}</Pill>
          <ChannelBadge channel={row.channel} />
          <span className="text-[12px] text-ink-dim">
            {row.category === null ? (
              <Tooltip
                content={
                  <div className="text-ink-dim">
                    A wildcard record: it applies to every category, and any later category-specific
                    record overrides it for that category.
                  </div>
                }
              >
                <span className="text-ink-faint underline decoration-dotted underline-offset-4">
                  all categories
                </span>
              </Tooltip>
            ) : (
              titleCase(row.category)
            )}
          </span>
          <span className="rounded border border-line bg-ground px-1.5 py-px font-mono text-[10px] text-ink-faint">
            {row.source}
          </span>
          {first && <Pill tone="accent">current</Pill>}
          <span
            className="ml-auto text-[11px] whitespace-nowrap text-ink-faint"
            title={timestamp(row.occurred_at)}
          >
            {relative(row.occurred_at)}
          </span>
        </div>

        <div className="mt-0.5 font-mono text-[11px] text-ink-faint">
          {timestamp(row.occurred_at)}
        </div>

        {evidence !== null && Object.keys(evidence).length > 0 ? (
          <>
            <button
              type="button"
              className="mt-1 text-[11px] text-accent hover:underline"
              onClick={() => {
                setOpen(!open);
              }}
              aria-expanded={open}
            >
              {open ? 'hide evidence' : 'show evidence'}
            </button>
            {open && (
              <pre className="mt-1.5 overflow-x-auto rounded border border-line bg-ground p-2.5 font-mono text-[11px] leading-relaxed text-ink-dim">
                {JSON.stringify(evidence, null, 2)}
              </pre>
            )}
          </>
        ) : (
          <div className="mt-1 text-[11px] text-ink-faint">
            {DASH} no evidence was attached to this record
          </div>
        )}
      </div>
    </li>
  );
}

// ── suppression row ──────────────────────────────────────────────────────────

function SuppressionItem({ row }: { row: SuppressionRow }) {
  const expired = row.expires_at !== null && new Date(row.expires_at).getTime() < Date.now();
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ChannelBadge channel={row.channel} />
        <Pill tone={expired ? 'quiet' : 'bad'} mono>
          {row.reason}
        </Pill>
        {expired && <Pill tone="quiet">expired</Pill>}
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-ink-dim">{row.address}</div>
      <div className="mt-0.5 text-[11px] text-ink-faint">
        added {timestamp(row.created_at)} ·{' '}
        {row.expires_at === null ? (
          <Tooltip
            align="left"
            content={
              <div className="text-ink-dim">
                A permanent suppression. Hard bounces and complaints never expire — re-mailing an
                address that complained is how a sending domain gets blocked.
              </div>
            }
          >
            <span className="underline decoration-dotted underline-offset-4">never expires</span>
          </Tooltip>
        ) : (
          <>expires {timestamp(row.expires_at)}</>
        )}
      </div>
      {row.evidence !== null && Object.keys(row.evidence).length > 0 && (
        <pre className="mt-1.5 overflow-x-auto rounded border border-line bg-ground p-2 font-mono text-[10px] leading-relaxed text-ink-faint">
          {JSON.stringify(row.evidence, null, 2)}
        </pre>
      )}
    </li>
  );
}

// ── recording consent ────────────────────────────────────────────────────────

/**
 * An operator recording somebody else's intent has to say so.
 *
 * The API defaults `source` to `operator` for this endpoint and stamps the
 * recording user into `evidence`, because a row that claims `signup` for
 * something a support agent typed is a lie in an audit trail — and the audit
 * trail is the only reason the ledger exists.
 */
function RecordConsent({ contactId, onRecorded }: { contactId: string; onRecorded: () => void }) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<Chan>('email');
  const [category, setCategory] = useState<Category | ''>('');
  const [state, setState] = useState<'opted_in' | 'opted_out'>('opted_out');
  const [note, setNote] = useState('');

  const record = useMutation({
    mutationFn: () =>
      api.post(`/contacts/${contactId}/consent`, {
        channel,
        category: category === '' ? null : category,
        state,
        source: 'operator',
        ...(note.trim().length === 0 ? {} : { evidence: { note: note.trim() } }),
      }),
    onSuccess: () => {
      setNote('');
      setOpen(false);
      onRecorded();
    },
  });

  return (
    <div className="border-t border-line">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
        onClick={() => {
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <span className="text-[12px] text-ink-dim">
          <span className="mr-1.5 inline-block font-mono text-ink-faint">{open ? '▾' : '▸'}</span>
          Record a consent event
        </span>
        <span className="text-[11px] text-ink-faint">appends a row; nothing is overwritten</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-line p-4">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="label" htmlFor="consent-channel">
                Channel
              </label>
              <select
                id="consent-channel"
                className="input"
                value={channel}
                onChange={(event) => {
                  setChannel(event.target.value as Chan);
                }}
              >
                {Channel.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="consent-category">
                Category
              </label>
              <select
                id="consent-category"
                className="input"
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value as Category | '');
                }}
              >
                <option value="">all (wildcard)</option>
                {CampaignCategory.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="consent-state">
                State
              </label>
              <select
                id="consent-state"
                className="input"
                value={state}
                onChange={(event) => {
                  setState(event.target.value as 'opted_in' | 'opted_out');
                }}
              >
                <option value="opted_out">opted_out</option>
                <option value="opted_in">opted_in</option>
              </select>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="consent-note">
              Evidence
            </label>
            <input
              id="consent-note"
              className="input"
              placeholder="e.g. asked to be removed on call #4821"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
              Recorded with <code className="font-mono">source: operator</code> and your user id,
              not as though the customer did it themselves.
            </p>
          </div>

          {record.isError && (
            <ErrorState error={record.error} title="The consent event was not recorded" />
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={record.isPending}
            onClick={() => {
              record.mutate();
            }}
          >
            {record.isPending ? 'Appending…' : 'Append to ledger'}
          </button>
        </div>
      )}
    </div>
  );
}
