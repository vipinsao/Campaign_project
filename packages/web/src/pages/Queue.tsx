import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Channel } from '@campaign/shared';
import type { Channel as Chan } from '@campaign/shared';
import { api } from '../lib/api.ts';
import type { QueueResponse, QueueRow } from '../lib/types.ts';
import { PageHeader, Scroll } from '../components/Layout.tsx';
import { ChannelBadge, Pill, QueueStatusPill } from '../components/Pill.tsx';
import { EmptyState, ErrorState, LoadingState } from '../components/States.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import { DASH, int, relative, shortTimestamp, timestamp } from '../lib/format.ts';

/**
 * The queue.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `attempts` and `deferrals` are two columns and they are shown as two columns.
 *
 * A message held back three nights by recipient-local quiet hours has three
 * DEFERRALS and zero ATTEMPTS; a message the provider rejected three times has
 * three attempts. Collapsing them into "retries" is how a guard that is working
 * correctly gets reported as an outage — and how an operator "fixes" it by
 * widening the quiet-hours window, which is the one thing that must not happen.
 *
 * A failed row shows the PROVIDER's own error code and the terminal/transient
 * classification, not a framework message. `provider_error_code` is the string an
 * operator pastes into a carrier's documentation; "Error: send failed" is the
 * string that makes forensics impossible. `error_class` is why the row was or was
 * not retried, and terminal errors are never retried at all.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const STATUSES = [
  'pending',
  'processing',
  'sent',
  'delivered',
  'failed',
  'cancelled',
  'suppressed',
  'bounced',
  'complained',
] as const;

/** The five the page is built around; the rest appear only when the tenant has them. */
const PRIMARY: readonly string[] = ['pending', 'processing', 'sent', 'failed', 'cancelled'];

export function QueuePage() {
  const queryClient = useQueryClient();
  const searchRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [channel, setChannel] = useState<Chan | null>(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, []);

  const queue = useQuery({
    queryKey: ['queue', status, channel],
    queryFn: () =>
      api.get<QueueResponse>('/queue', {
        limit: 200,
        ...(status === null ? {} : { status }),
        ...(channel === null ? {} : { channel }),
      }),
    refetchInterval: 15_000,
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.post<{ cancelled: boolean }>(`/queue/${id}/cancel`),
    onMutate: () => { setActionError(null); },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['queue'] }); },
    onError: setActionError,
  });

  const counts = queue.data?.countsByStatus ?? {};
  const all = queue.data?.messages ?? [];
  const needle = search.trim().toLowerCase();
  const rows = all.filter(
    (row) =>
      needle.length === 0 ||
      row.recipient_address.toLowerCase().includes(needle) ||
      row.campaign_name.toLowerCase().includes(needle) ||
      (row.rendered_subject ?? '').toLowerCase().includes(needle) ||
      (row.provider_error_code ?? '').toLowerCase().includes(needle) ||
      row.id.startsWith(needle),
  );

  const visibleStatuses = STATUSES.filter(
    (entry) => PRIMARY.includes(entry) || (counts[entry] ?? 0) > 0,
  );

  return (
    <>
      <PageHeader
        title="Queue"
        subtitle={
          <>
            <span className="font-mono text-ink">attempts</span> and{' '}
            <span className="font-mono text-ink">deferrals</span> are different numbers: a message
            held for quiet hours has not been attempted, and a deferral does not consume a delivery
            attempt.
          </>
        }
        actions={
          <>
            <div className="relative">
              <input
                ref={searchRef}
                className="input w-72 pl-7"
                placeholder="Address, campaign, subject, error code"
                value={search}
                onChange={(event) => { setSearch(event.target.value); }}
              />
              <span className="pointer-events-none absolute top-1.5 left-2 text-[12px] text-ink-faint">⌕</span>
              {search.length === 0 && (
                <span className="kbd pointer-events-none absolute top-1.5 right-2">/</span>
              )}
            </div>
            <button type="button" className="btn" onClick={() => void queue.refetch()}>
              Refresh
            </button>
          </>
        }
        tabs={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] tracking-wide text-ink-faint uppercase">status</span>
              <StatusChip
                label="all"
                count={Object.values(counts).reduce((sum, value) => sum + value, 0)}
                active={status === null}
                onClick={() => { setStatus(null); }}
                loading={queue.isPending}
              />
              {visibleStatuses.map((entry) => (
                <StatusChip
                  key={entry}
                  label={entry}
                  count={counts[entry]}
                  active={status === entry}
                  onClick={() => { setStatus(status === entry ? null : entry); }}
                  loading={queue.isPending}
                />
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] tracking-wide text-ink-faint uppercase">channel</span>
              {Channel.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => { setChannel(channel === option ? null : option); }}
                  className={clsx(
                    'rounded border px-1.5 py-px text-[11px] transition-colors',
                    channel === option
                      ? 'border-accent-dim bg-accent-wash text-accent'
                      : 'border-line text-ink-dim hover:border-line-strong hover:text-ink',
                  )}
                >
                  {option.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        }
      />

      <Scroll>
        {actionError !== null && <ErrorState error={actionError} title="The message was not cancelled" />}

        {queue.isPending ? (
          <LoadingState rows={12} label="Loading queue" />
        ) : queue.isError ? (
          <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            glyph={all.length === 0 ? '∅' : '⌕'}
            title={
              all.length === 0
                ? status === null
                  ? 'The queue is empty'
                  : `No message is '${status}'`
                : 'No row matches this search'
            }
            detail={
              all.length === 0
                ? 'The request succeeded and returned no rows. That is different from the request failing, which would be a red panel.'
                : `${String(all.length)} rows loaded; none of them match.`
            }
            action={
              all.length > 0 || status !== null || channel !== null ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setSearch('');
                    setStatus(null);
                    setChannel(null);
                  }}
                >
                  Clear filters
                </button>
              ) : undefined
            }
          />
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-ground/95 backdrop-blur">
              <tr className="border-b border-line">
                <th className="th">Recipient</th>
                <th className="th">Campaign</th>
                <th className="th">Status</th>
                <th className="th">Scheduled</th>
                <th className="th">Sent</th>
                <th className="th text-right">
                  <Tooltip
                    align="right"
                    content={
                      <div className="text-ink-dim">
                        Delivery attempts handed to a provider. A quiet-hours deferral is{' '}
                        <b className="text-ink">not</b> one of these and never consumes one.
                      </div>
                    }
                  >
                    <span className="underline decoration-dotted underline-offset-4">Att</span>
                  </Tooltip>
                </th>
                <th className="th text-right">
                  <Tooltip
                    align="right"
                    content={
                      <div className="text-ink-dim">
                        Times this message was held back — quiet hours, a pause, a frequency cap.
                        The system working, not failing.
                      </div>
                    }
                  >
                    <span className="underline decoration-dotted underline-offset-4">Def</span>
                  </Tooltip>
                </th>
                <th className="th">Provider result</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  expanded={expanded === row.id}
                  onToggle={() => { setExpanded(expanded === row.id ? null : row.id); }}
                  onCancel={() => { cancel.mutate(row.id); }}
                  cancelling={cancel.isPending && cancel.variables === row.id}
                />
              ))}
            </tbody>
          </table>
        )}

        {!queue.isPending && !queue.isError && (
          <div className="px-5 py-3 text-[11px] leading-relaxed text-ink-faint">
            {rows.length} of {all.length} loaded · page limit {queue.data.page.limit} · the status
            counts above are tenant-wide, the rows are this page only. Text search filters the loaded
            page in the browser and the server is not asked again.
          </div>
        )}
      </Scroll>
    </>
  );
}

function StatusChip({
  label,
  count,
  active,
  onClick,
  loading,
}: {
  label: string;
  count: number | undefined;
  active: boolean;
  onClick: () => void;
  loading: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 rounded border px-1.5 py-px text-[11px] transition-colors',
        active
          ? 'border-accent-dim bg-accent-wash text-accent'
          : 'border-line text-ink-dim hover:border-line-strong hover:text-ink',
      )}
    >
      {label}
      <span className="num text-[10px] text-ink-faint">
        {loading ? '·' : int(count)}
      </span>
    </button>
  );
}

function Row({
  row,
  expanded,
  onToggle,
  onCancel,
  cancelling,
}: {
  row: QueueRow;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const cancellable = row.status === 'pending' || row.status === 'processing';
  const failed = row.provider_error_code !== null;

  return (
    <>
      <tr
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        className={clsx(
          'cursor-pointer border-b border-line/60 outline-none hover:bg-raised focus-visible:bg-raised',
          expanded && 'bg-raised',
        )}
      >
        <td className="cell max-w-xs">
          <div className="flex items-center gap-1.5">
            <ChannelBadge channel={row.channel} />
            <Link
              to={`/contacts/${row.contact_id}`}
              onClick={(event) => { event.stopPropagation(); }}
              className="truncate text-[12px] text-ink hover:text-accent"
            >
              {row.recipient_address}
            </Link>
          </div>
          {row.rendered_subject !== null && (
            <div className="truncate text-[11px] text-ink-faint">{row.rendered_subject}</div>
          )}
        </td>
        <td className="cell max-w-[14rem]">
          <Link
            to={`/campaigns/${row.campaign_id}/overview`}
            onClick={(event) => { event.stopPropagation(); }}
            className="block truncate text-[12px] text-ink-dim hover:text-accent"
          >
            {row.campaign_name}
          </Link>
        </td>
        <td className="cell">
          <QueueStatusPill status={row.status} />
        </td>
        <td className="cell text-[11px] whitespace-nowrap text-ink-dim">
          {shortTimestamp(row.scheduled_at)}
        </td>
        <td className="cell text-[11px] whitespace-nowrap text-ink-dim">
          {row.sent_at === null ? <span className="text-ink-faint">{DASH}</span> : shortTimestamp(row.sent_at)}
        </td>
        <td className="cell num text-right">{int(row.attempts)}</td>
        <td className={clsx('cell num text-right', row.deferrals > 0 && 'text-held')}>
          {int(row.deferrals)}
        </td>
        <td className="cell max-w-xs">
          {failed ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill tone={row.error_class === 'terminal' ? 'bad' : 'held'} mono>
                {row.provider_error_code}
              </Pill>
              {row.error_class !== null && (
                <Tooltip
                  align="right"
                  content={
                    <div className="text-ink-dim">
                      {row.error_class === 'terminal'
                        ? 'Classified terminal from an explicit table, so it was never retried. Retrying a carrier rejection three times costs three times as much and fails three times.'
                        : 'Classified transient, so it is retried with backoff. The classification comes from a table, not from a string match on the message.'}
                    </div>
                  }
                >
                  <span
                    className={clsx(
                      'text-[10px] tracking-wide uppercase underline decoration-dotted underline-offset-4',
                      row.error_class === 'terminal' ? 'text-bad' : 'text-held',
                    )}
                  >
                    {row.error_class}
                  </span>
                </Tooltip>
              )}
            </div>
          ) : (
            <span className="text-[11px] text-ink-faint">
              {row.provider ?? DASH}
            </span>
          )}
        </td>
        <td className="cell text-right">
          {cancellable && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={cancelling}
              onClick={(event) => {
                event.stopPropagation();
                onCancel();
              }}
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-line/60 bg-ground/60">
          <td colSpan={9} className="px-3 py-3">
            <div className="grid gap-3 md:grid-cols-3">
              <Detail label="Queue row">
                <code className="font-mono text-[11px] break-all text-ink-dim">{row.id}</code>
              </Detail>
              <Detail label="Provider">
                {row.provider ?? <span className="text-ink-faint">{DASH} — not handed to a provider yet</span>}
              </Detail>
              <Detail label="Tracking id">
                {row.tracking_id === null ? (
                  <span className="text-ink-faint">{DASH}</span>
                ) : (
                  <code className="font-mono text-[11px] break-all text-ink-dim">{row.tracking_id}</code>
                )}
              </Detail>
              <Detail label="Created">{timestamp(row.created_at)}</Detail>
              <Detail label="Scheduled">
                {timestamp(row.scheduled_at)}{' '}
                <span className="text-ink-faint">({relative(row.scheduled_at)})</span>
              </Detail>
              <Detail label="Next attempt">
                {row.next_attempt_at === null ? (
                  <span className="text-ink-faint">{DASH} — none scheduled</span>
                ) : (
                  <>
                    {timestamp(row.next_attempt_at)}{' '}
                    <span className="text-ink-faint">({relative(row.next_attempt_at)})</span>
                  </>
                )}
              </Detail>
              <Detail label="Sent">{timestamp(row.sent_at)}</Detail>
              <Detail label="Delivered">
                {row.delivered_at === null ? (
                  <span className="text-ink-faint">
                    {DASH} — written only by a provider receipt, never inferred from sent
                  </span>
                ) : (
                  timestamp(row.delivered_at)
                )}
              </Detail>
              <Detail label="Enrollment">
                {row.enrollment_id === null ? (
                  <span className="text-ink-faint">{DASH}</span>
                ) : (
                  <code className="font-mono text-[11px] break-all text-ink-dim">{row.enrollment_id}</code>
                )}
              </Detail>
            </div>

            {row.provider_error_message !== null && (
              <div className="mt-3 rounded border border-bad/30 bg-bad-wash px-3 py-2">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[11px] tracking-wide text-bad uppercase">
                    the provider&rsquo;s own words
                  </span>
                  <Pill tone="bad" mono>{row.provider_error_code ?? 'no code'}</Pill>
                </div>
                <p className="font-mono text-[11px] leading-relaxed break-words text-ink-dim">
                  {row.provider_error_message}
                </p>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] tracking-wide text-ink-faint uppercase">{label}</div>
      <div className="text-[12px] text-ink-dim">{children}</div>
    </div>
  );
}
