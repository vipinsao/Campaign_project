import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type { Channel } from '@campaign/shared';
import { ApiError, api } from '../lib/api.ts';
import type { Page } from '../lib/types.ts';
import { PageHeader, Scroll } from '../components/Layout.tsx';
import { ChannelBadge, Pill } from '../components/Pill.tsx';
import { EmptyState, ErrorState, LoadingState, UnavailableState } from '../components/States.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import { DASH, relative, shortTimestamp, timestamp } from '../lib/format.ts';
import type { Tone } from '../components/Pill.tsx';

/**
 * The mock outbox.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The mock provider is not a stub. It writes to a real table — `mock_outbox` —
 * assigns a simulated outcome from configured rates, and fires delayed delivery
 * and bounce webhooks back into the real webhook endpoint. That is what lets the
 * whole lifecycle, including a bounce and a complaint, be watched with zero
 * credentials and zero accounts, which is the difference between a reviewer
 * trying this system and not.
 *
 * So this page renders what the provider ACTUALLY wrote, and shows every row's
 * `simulated_outcome` next to it. A wall of uniform successes would hide the one
 * behaviour worth demonstrating: that a bounce takes a different path from a
 * delivery, and that the difference is visible.
 *
 * SMS is rendered in a phone, and that is not decoration either. A 480-character
 * body reads fine in a table cell and is four billed segments in a message
 * bubble; seeing the copy in the shape it will actually arrive in is the fastest
 * way to notice.
 * ─────────────────────────────────────────────────────────────────────────────
 */

type OutboxRow = {
  readonly id: string;
  readonly message_queue_id: string | null;
  readonly channel: Channel;
  readonly to_address: string;
  readonly from_address: string;
  readonly subject: string | null;
  readonly body: string;
  readonly html: string | null;
  readonly provider_message_id: string;
  readonly simulated_outcome: 'delivered' | 'bounced' | 'complained' | 'failed';
  readonly sent_at: string;
};

type OutboxResponse = { readonly messages: OutboxRow[]; readonly page: Page };

const OUTCOME_TONE: Record<OutboxRow['simulated_outcome'], Tone> = {
  delivered: 'ok',
  bounced: 'bad',
  complained: 'bad',
  failed: 'bad',
};

const OUTCOME_NOTE: Record<OutboxRow['simulated_outcome'], string> = {
  delivered:
    'A delivery receipt was fired back into the real webhook endpoint after a delay. The queue row is marked delivered by that receipt and never by the sender.',
  bounced:
    'A bounce webhook was fired back. The address is suppressed by the webhook handler, not by this row, which is why a bounce still looks like a bounce after a restart.',
  complained:
    'A complaint webhook was fired back. Complaints suppress permanently — re-mailing an address that complained is how a sending domain gets blocked.',
  failed:
    'The provider refused this send outright. Whether it is retried depends on the terminal/transient classification, which is read from a table rather than from the message text.',
};

export function MockOutboxPage() {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const outbox = useQuery({
    queryKey: ['mock-outbox', channel],
    queryFn: () =>
      api.get<OutboxResponse>('/mock-outbox', {
        limit: 200,
        ...(channel === null ? {} : { channel }),
      }),
    retry: false,
  });

  /**
   * A 404 here is not a failure to render as one.
   *
   * `mock_outbox` exists in the schema and the mock provider writes to it on every
   * send, but no route reads it back — see `createApp`, where the operator-guarded
   * prefixes are listed. Showing the operator a red "the request failed" panel
   * would suggest an outage; showing a fabricated inbox would be worse. This is
   * the fourth state: a thing the API cannot tell us, named precisely.
   */
  const missingEndpoint =
    outbox.error instanceof ApiError &&
    (outbox.error.status === 404 || outbox.error.code === 'not_found');

  const rows = outbox.data?.messages ?? [];
  const emails = rows.filter((row) => row.channel === 'email');
  const texts = rows.filter((row) => row.channel === 'sms');
  const open = rows.find((row) => row.id === selected) ?? emails[0];

  const counts = rows.reduce<Record<string, number>>((accumulator, row) => {
    accumulator[row.simulated_outcome] = (accumulator[row.simulated_outcome] ?? 0) + 1;
    return accumulator;
  }, {});

  return (
    <>
      <PageHeader
        title="Mock outbox"
        subtitle={
          <>
            What the mock provider actually wrote, with the outcome it assigned each send. No
            credentials, and a bounce that behaves like a bounce.
          </>
        }
        actions={
          <>
            {(['email', 'sms'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={clsx('btn', channel === option && 'border-accent-dim text-accent')}
                onClick={() => {
                  setChannel(channel === option ? null : option);
                }}
              >
                {option.toUpperCase()}
              </button>
            ))}
            <button type="button" className="btn" onClick={() => void outbox.refetch()}>
              Refresh
            </button>
          </>
        }
        tabs={
          rows.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 pb-3">
              <span className="text-[10px] tracking-wide text-ink-faint uppercase">outcomes</span>
              {(Object.keys(OUTCOME_TONE) as OutboxRow['simulated_outcome'][]).map((outcome) => (
                <Tooltip
                  key={outcome}
                  content={<div className="text-ink-dim">{OUTCOME_NOTE[outcome]}</div>}
                >
                  <Pill tone={counts[outcome] === undefined ? 'quiet' : OUTCOME_TONE[outcome]} mono>
                    {outcome} {counts[outcome] ?? 0}
                  </Pill>
                </Tooltip>
              ))}
            </div>
          ) : undefined
        }
      />

      <Scroll>
        {outbox.isPending ? (
          <LoadingState rows={8} label="Loading the mock outbox" />
        ) : missingEndpoint ? (
          <div className="p-3">
            <UnavailableState
              what="Nothing reads the mock outbox back yet"
              because={
                <>
                  The mock provider writes every send to{' '}
                  <code className="font-mono text-ink-dim">mock_outbox</code> — address, subject,
                  body, <code className="font-mono text-ink-dim">provider_message_id</code> and the{' '}
                  <code className="font-mono text-ink-dim">simulated_outcome</code> it assigned —
                  but this API exposes no route that returns those rows. The one this page asks for
                  is <code className="font-mono text-ink-dim">GET /mock-outbox</code>; it answered
                  404. The page is wired for it and will render the moment the route exists. Nothing
                  is shown in the meantime, because the alternative would be an inbox made up in the
                  browser.
                </>
              }
            />
            <section className="panel mt-3">
              <div className="panel-head">
                <span className="panel-title">What this page will show</span>
              </div>
              <ul className="space-y-1.5 px-4 py-3 text-[12px] leading-relaxed text-ink-dim">
                <li>
                  Every email the mock provider sent, newest first, with its rendered subject and
                  body — the same bytes a recipient would have received.
                </li>
                <li>
                  Every SMS in a phone, so segment-splitting copy is obvious before it is billed.
                </li>
                <li>
                  Each row&rsquo;s <code className="font-mono">simulated_outcome</code>, so a bounce
                  and a complaint are visible rather than implied.
                </li>
              </ul>
            </section>
          </div>
        ) : outbox.isError ? (
          <ErrorState error={outbox.error} onRetry={() => void outbox.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            glyph="✉"
            title="The mock provider has not sent anything yet"
            detail={
              <>
                The endpoint answered and returned no rows. Run{' '}
                <code className="font-mono text-ink-dim">npm run seed:demo</code> and let the worker
                drain the queue, or queue a test send from a campaign&rsquo;s Overview tab.
              </>
            }
          />
        ) : (
          <div className="grid gap-3 p-3 xl:grid-cols-[1fr_360px]">
            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">
                  Email
                  <span className="ml-2 rounded bg-raised px-1.5 py-px font-mono text-[10px] text-ink-faint">
                    {emails.length}
                  </span>
                </span>
                <span className="text-[11px] text-ink-faint">newest first</span>
              </div>

              {emails.length === 0 ? (
                <EmptyState
                  compact
                  glyph="∅"
                  title="No email in the outbox"
                  detail="Nothing has been sent on this channel."
                />
              ) : (
                <div className="grid lg:grid-cols-[280px_1fr]">
                  <ul className="divide-y divide-line border-r border-line">
                    {emails.map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelected(row.id);
                          }}
                          className={clsx(
                            'w-full px-3 py-2 text-left transition-colors',
                            open?.id === row.id ? 'bg-accent-wash' : 'hover:bg-raised',
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[12px] text-ink-dim">
                              {row.to_address}
                            </span>
                            <Pill tone={OUTCOME_TONE[row.simulated_outcome]} mono>
                              {row.simulated_outcome.slice(0, 4)}
                            </Pill>
                          </div>
                          <div className="truncate text-[12px] text-ink">
                            {row.subject ?? '(no subject)'}
                          </div>
                          <div className="text-[10px] text-ink-faint">
                            {shortTimestamp(row.sent_at)}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>

                  <div className="min-w-0">
                    {open === undefined ? (
                      <EmptyState compact glyph="✉" title="Nothing selected" />
                    ) : (
                      <EmailView row={open} />
                    )}
                  </div>
                </div>
              )}
            </section>

            <section className="panel h-fit">
              <div className="panel-head">
                <span className="panel-title">
                  SMS
                  <span className="ml-2 rounded bg-raised px-1.5 py-px font-mono text-[10px] text-ink-faint">
                    {texts.length}
                  </span>
                </span>
              </div>
              {texts.length === 0 ? (
                <EmptyState
                  compact
                  glyph="∅"
                  title="No SMS in the outbox"
                  detail="Nothing has been sent on this channel."
                />
              ) : (
                <Phone rows={texts} />
              )}
            </section>
          </div>
        )}
      </Scroll>
    </>
  );
}

function EmailView({ row }: { row: OutboxRow }) {
  const [showHtml, setShowHtml] = useState(false);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="border-b border-line px-4 py-3">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <ChannelBadge channel="email" />
          <Tooltip
            content={<div className="text-ink-dim">{OUTCOME_NOTE[row.simulated_outcome]}</div>}
          >
            <Pill tone={OUTCOME_TONE[row.simulated_outcome]} mono>
              {row.simulated_outcome}
            </Pill>
          </Tooltip>
          <span className="ml-auto text-[11px] text-ink-faint" title={timestamp(row.sent_at)}>
            {relative(row.sent_at)}
          </span>
        </div>
        <div className="text-[14px] leading-tight font-semibold text-ink">
          {row.subject ?? <span className="text-ink-faint">(no subject)</span>}
        </div>
        <dl className="mt-2 space-y-0.5 font-mono text-[11px]">
          <div className="flex gap-2">
            <dt className="w-12 shrink-0 text-ink-faint">from</dt>
            <dd className="truncate text-ink-dim">{row.from_address}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-12 shrink-0 text-ink-faint">to</dt>
            <dd className="truncate text-ink-dim">{row.to_address}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-12 shrink-0 text-ink-faint">id</dt>
            <dd className="truncate text-ink-dim">{row.provider_message_id}</dd>
          </div>
        </dl>
      </div>

      {row.html !== null && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <button
            type="button"
            className={clsx('btn btn-ghost', !showHtml && 'text-accent')}
            onClick={() => {
              setShowHtml(false);
            }}
          >
            Plain text
          </button>
          <button
            type="button"
            className={clsx('btn btn-ghost', showHtml && 'text-accent')}
            onClick={() => {
              setShowHtml(true);
            }}
          >
            HTML source
          </button>
          <span className="ml-auto text-[11px] text-ink-faint">
            shown as source, never rendered into this page
          </span>
        </div>
      )}

      <pre className="max-h-[28rem] overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-dim">
        {showHtml && row.html !== null ? row.html : row.body}
      </pre>

      <p className="border-t border-line px-4 py-2 text-[11px] leading-relaxed text-ink-faint">
        The HTML is displayed as source rather than injected into this document. An operator console
        that renders arbitrary stored markup is one merge field away from executing it.
      </p>
    </div>
  );
}

/**
 * SMS in the shape it arrives in.
 *
 * The segment count on each bubble is computed here from the body length, and it
 * is labelled as an estimate: the authoritative count comes from the server, on
 * the RENDERED text with GSM-7/UCS-2 detection, because one curly apostrophe
 * halves the segment size. `/templates/validate` is where that number comes from
 * in the message editor; this is a reading aid on an already-sent message, not a
 * second implementation of the billing arithmetic.
 */
function Phone({ rows }: { rows: readonly OutboxRow[] }) {
  const ordered = [...rows].sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  return (
    <div className="p-4">
      <div className="mx-auto w-full max-w-[300px] rounded-[26px] border-2 border-line-strong bg-ground p-2 shadow-xl shadow-black/50">
        <div className="mb-2 flex items-center justify-center">
          <span className="h-1 w-16 rounded-full bg-line-strong" />
        </div>
        <div className="max-h-[26rem] space-y-3 overflow-y-auto px-1 pb-2">
          {ordered.map((row) => {
            const estimatedSegments = Math.max(1, Math.ceil(row.body.length / 160));
            return (
              <div key={row.id}>
                <div className="mb-1 text-center text-[10px] text-ink-faint">
                  {shortTimestamp(row.sent_at)}
                </div>
                <div className="flex justify-end">
                  <div
                    className={clsx(
                      'max-w-[85%] rounded-2xl rounded-br-sm px-3 py-2 text-[12px] leading-relaxed break-words',
                      row.simulated_outcome === 'delivered'
                        ? 'bg-accent-dim text-white'
                        : 'border border-bad/40 bg-bad-wash text-ink-dim',
                    )}
                  >
                    {row.body}
                  </div>
                </div>
                <div className="mt-1 flex items-center justify-end gap-2 text-[10px]">
                  <span className="text-ink-faint">{row.to_address}</span>
                  <Tooltip
                    align="right"
                    content={
                      <div className="text-ink-dim">
                        An estimate at 160 characters per segment. The authoritative count is
                        computed on the server against the rendered text with GSM-7/UCS-2 detection
                        — one curly apostrophe halves the segment size, and a merge field becomes
                        whatever the longest real first name happens to be.
                      </div>
                    }
                  >
                    <span className="text-ink-faint underline decoration-dotted underline-offset-4">
                      ≈{estimatedSegments} seg
                    </span>
                  </Tooltip>
                  <Tooltip
                    align="right"
                    content={
                      <div className="text-ink-dim">{OUTCOME_NOTE[row.simulated_outcome]}</div>
                    }
                  >
                    <span
                      className={clsx(
                        'font-mono',
                        row.simulated_outcome === 'delivered' ? 'text-ok' : 'text-bad',
                      )}
                    >
                      {row.simulated_outcome}
                    </span>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        Sender: <span className="font-mono text-ink-dim">{ordered[0]?.from_address ?? DASH}</span>.
        SMS has no open tracking of any kind, which is why no open rate appears for this channel
        anywhere in the product.
      </p>
    </div>
  );
}
