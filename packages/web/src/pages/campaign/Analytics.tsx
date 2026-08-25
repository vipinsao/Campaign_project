import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import clsx from 'clsx';
import type { Channel } from '@campaign/shared';
import { api } from '../../lib/api.ts';
import type {
  FunnelResponse,
  MessageStatsResponse,
  QueueResponse,
  StatsResponse,
} from '../../lib/types.ts';
import { useCampaign } from '../CampaignEditor.tsx';
import { EmptyState, ErrorState, LoadingState, UnavailableState } from '../../components/States.tsx';
import { ApiRateValue, RateCard, RateValue, StatCard, Unknown } from '../../components/Rate.tsx';
import { ChannelBadge, Pill, ReasonChip } from '../../components/Pill.tsx';
import { Tooltip } from '../../components/Tooltip.tsx';
import { DASH, dayKey, int } from '../../lib/format.ts';
import { METRICS, metricInputs, metricsForChannel } from '../../lib/metrics.ts';
import type { MetricKey } from '../../lib/metrics.ts';

/**
 * Analytics  (I12).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Every rate on this screen carries its denominator, and not one of them is
 * computed by this file. Two sources, both of them the domain:
 *
 *   `/campaigns/:id/stats` returns each rate ALREADY paired with the
 *   `denominatorLabel` and `caveat` from core's METRICS table, so `ApiRateValue`
 *   renders the server's own sentence rather than a copy of it.
 *
 *   Per message, `RateValue` calls core's `rate()` directly on counts the API
 *   returned. Same module, same arithmetic, same null-on-zero-denominator rule.
 *
 * THE SMS PANEL HAS NO OPEN RATE, and it does not have one because the row is not
 * generated: the metric list comes from `metricsForChannel('sms')`, and
 * `open_rate.channels` is `['email']`. There is no `channel === 'sms' && …`
 * anywhere in this file. That is the difference between a rule and a habit — a
 * habit gets forgotten in the next panel somebody adds.
 *
 * Uniques are never summed across messages. `unique opens` is
 * COUNT(DISTINCT contact_id) per message, so adding two messages together counts
 * a contact who opened both of them twice. Where the API does not report a figure
 * per channel, this file renders an em dash and says why, rather than adding up
 * numbers that do not add.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SERIES = [
  { key: 'scheduled', label: 'Scheduled', color: '#6e8bff' },
  { key: 'sent', label: 'Sent', color: '#e8b44a' },
  { key: 'delivered', label: 'Delivered', color: '#3fd08a' },
] as const;

export function AnalyticsTab() {
  const { campaignId, campaign } = useCampaign();

  const stats = useQuery({
    queryKey: ['campaign-stats', campaignId],
    queryFn: () => api.get<StatsResponse>(`/campaigns/${campaignId}/stats`),
  });
  const funnel = useQuery({
    queryKey: ['campaign-funnel', campaignId],
    queryFn: () => api.get<FunnelResponse>(`/campaigns/${campaignId}/funnel`),
  });
  const perMessage = useQuery({
    queryKey: ['campaign-message-stats', campaignId],
    queryFn: () => api.get<MessageStatsResponse>(`/campaigns/${campaignId}/messages/stats`),
  });
  /**
   * The daily series has no endpoint, so it is built from the queue rows the API
   * WILL return — with the window stated on the chart rather than implied.
   *
   * `campaign_daily_stats` exists and is the right source, but nothing exposes it;
   * inventing a smooth curve from the totals would produce a chart that looks
   * exactly like a real one and is not.
   */
  const queue = useQuery({
    queryKey: ['campaign-queue-series', campaignId],
    queryFn: () => api.get<QueueResponse>('/queue', { campaignId, limit: 200 }),
  });

  const rateFor = (key: string) => stats.data?.rates.find((entry) => entry.key === key);

  return (
    <div className="space-y-3 p-3">
      {/* ── headline counts ────────────────────────────────────────────────── */}
      {stats.isPending ? (
        <LoadingState rows={2} label="Loading campaign stats" />
      ) : stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => void stats.refetch()} title="Stats did not load" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            <StatCard label="Queued" value={int(stats.data.counts.queued)} hint="pending + processing" />
            <StatCard label="Sent" value={int(stats.data.counts.sent)} hint="sent_at is not null" tone="accent" />
            <StatCard label="Delivered" value={int(stats.data.counts.delivered)} hint="provider receipt only" tone="ok" />
            <StatCard label="Bounced" value={int(stats.data.counts.bounced)} hint="hard + soft" tone="bad" />
            <StatCard label="Complained" value={int(stats.data.counts.complained)} tone="bad" />
            <StatCard label="Cancelled" value={int(stats.data.counts.cancelled)} hint="opt-out, pause, operator" />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {stats.data.rates.map((entry) => (
              <RateCard key={entry.key} rate={entry} />
            ))}
          </div>
        </>
      )}

      {/* ── per channel: the metric vocabulary, generated ───────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Which metrics exist on each channel</span>
          <span className="text-[11px] text-ink-faint">
            generated from <code className="font-mono">metricsForChannel()</code>
          </span>
        </div>
        <div className="grid gap-3 p-4 md:grid-cols-2">
          {campaign.channels.map((channel) => (
            <ChannelPanel
              key={channel}
              channel={channel}
              singleChannel={campaign.channels.length === 1}
              rateFor={rateFor}
              loading={stats.isPending}
            />
          ))}
        </div>
      </section>

      {/* ── funnel ─────────────────────────────────────────────────────────── */}
      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Funnel</span>
            <Tooltip
              align="right"
              content={
                <div className="text-ink-dim">
                  The stages count different units. <b className="text-ink">enrolled</b> counts
                  people; <b className="text-ink">sent</b> counts messages, and a journey sends
                  several messages per person — so a single &ldquo;conversion rate&rdquo; from the
                  top of this funnel to the bottom is a category error. Each bar names its own unit.
                </div>
              }
            >
              <span className="text-[11px] text-ink-faint underline decoration-dotted underline-offset-4">
                why there is no overall %
              </span>
            </Tooltip>
          </div>

          {funnel.isPending ? (
            <LoadingState rows={6} label="Loading funnel" />
          ) : funnel.isError ? (
            <ErrorState error={funnel.error} onRetry={() => void funnel.refetch()} />
          ) : funnel.data.stages.every((stage) => stage.count === 0) ? (
            <EmptyState
              glyph="⌛"
              title="This campaign has not enrolled anybody yet"
              detail="Every stage is a genuine zero from the database — no rows exist, rather than the request having failed."
            />
          ) : (
            <Funnel stages={funnel.data.stages} />
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Where the rest went</span>
          </div>
          {funnel.isPending ? (
            <LoadingState rows={4} label="Loading skip reasons" />
          ) : funnel.isError ? (
            <ErrorState error={funnel.error} />
          ) : funnel.data.skipsByReason.length === 0 ? (
            <EmptyState
              compact
              glyph="∅"
              title="No skip decisions recorded"
              detail="A genuine zero: the decision log has a row only when something was decided."
            />
          ) : (
            <ul className="divide-y divide-line">
              {funnel.data.skipsByReason.map((skip) => (
                <li key={skip.reasonCode} className="flex items-center justify-between gap-3 px-4 py-2">
                  <ReasonChip code={skip.reasonCode} />
                  <span className="num text-ink-dim">{int(skip.count)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-line px-4 py-2.5 text-[11px] leading-relaxed text-ink-faint">
            A funnel that counts only successes cannot answer &ldquo;where did the other four
            thousand go?&rdquo;. These come from <code className="font-mono">send_decisions</code>,
            one row per skip, with a code from a closed vocabulary.
          </p>
        </section>
      </div>

      {/* ── daily series ───────────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Daily activity</span>
          <span className="text-[11px] text-ink-faint">
            derived from <code className="font-mono">/queue?campaignId</code>
          </span>
        </div>
        {queue.isPending ? (
          <LoadingState rows={6} label="Loading queue rows" />
        ) : queue.isError ? (
          <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
        ) : (
          <DailySeries rows={queue.data.messages} limit={queue.data.page.limit} />
        )}
      </section>

      {/* ── per message ────────────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Per message</span>
          <span className="text-[11px] text-ink-faint">
            every rate below is <code className="font-mono">rate()</code> from the domain — hover for
            its denominator
          </span>
        </div>
        {perMessage.isPending ? (
          <LoadingState rows={5} label="Loading per-message stats" />
        ) : perMessage.isError ? (
          <ErrorState error={perMessage.error} onRetry={() => void perMessage.refetch()} />
        ) : perMessage.data.messages.length === 0 ? (
          <EmptyState
            glyph="✉"
            title="This campaign has no messages"
            detail="Add one on the Messages or Journey tab. A campaign with no enabled message enrols contacts and sends nothing."
          />
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className="th">#</th>
                <th className="th">Channel</th>
                <th className="th">Condition</th>
                <th className="th text-right">Queued</th>
                <th className="th text-right">Sent</th>
                <th className="th text-right">Delivered</th>
                <th className="th text-right">Cancelled</th>
                <th className="th text-right">Delivery</th>
                <th className="th text-right">Open</th>
                <th className="th text-right">Click</th>
              </tr>
            </thead>
            <tbody>
              {perMessage.data.messages.map((message) => {
                const inputs = metricInputs({
                  queued: message.queued,
                  sent: message.sent,
                  delivered: message.delivered,
                  uniqueOpens: message.uniqueOpens,
                  uniqueClicks: message.uniqueClicks,
                });
                return (
                  <tr key={message.id} className="border-b border-line/60">
                    <td className="cell num text-ink-faint">{message.sequenceOrder}</td>
                    <td className="cell">
                      <span className="flex items-center gap-1.5">
                        <ChannelBadge channel={message.channel} />
                        {!message.isEnabled && <Pill tone="quiet">off</Pill>}
                      </span>
                    </td>
                    <td className="cell font-mono text-[11px] text-ink-dim">{message.sendCondition}</td>
                    <td className="cell num text-right">{int(message.queued)}</td>
                    <td className="cell num text-right">{int(message.sent)}</td>
                    <td className="cell num text-right">{int(message.delivered)}</td>
                    <td className="cell num text-right">{int(message.cancelled)}</td>
                    <td className="cell text-right">
                      <RateValue metricKey="delivery_rate" inputs={inputs} channel={message.channel} />
                    </td>
                    <td className="cell text-right">
                      <RateValue metricKey="open_rate" inputs={inputs} channel={message.channel} />
                    </td>
                    <td className="cell text-right">
                      <RateValue
                        metricKey="click_rate"
                        inputs={inputs}
                        channel={message.channel}
                        note="This endpoint does not report how many of these delivered messages actually contained a link, so the denominator is unavailable per message and the rate is shown as unknown rather than computed against `delivered`."
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ── per-channel metric vocabulary ────────────────────────────────────────────

/**
 * The metrics that exist on this channel, generated rather than listed.
 *
 * When the campaign sends on exactly one channel, the campaign-wide figure from
 * `/stats` IS the figure for that channel and is rendered. When it sends on two,
 * it is not: the API reports counts campaign-wide, and per-message uniques cannot
 * be summed into a per-channel unique. So the value is an em dash with the reason
 * on hover, which is the true answer.
 */
function ChannelPanel({
  channel,
  singleChannel,
  rateFor,
  loading,
}: {
  channel: Channel;
  singleChannel: boolean;
  rateFor: (key: string) => StatsResponse['rates'][number] | undefined;
  loading: boolean;
}) {
  const definitions = metricsForChannel(channel);
  const absent = (Object.keys(METRICS) as MetricKey[]).filter(
    (key) => !METRICS[key].channels.includes(channel),
  );

  return (
    <div className="rounded-md border border-line bg-ground/40">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <ChannelBadge channel={channel} />
        <span className="text-[12px] font-medium text-ink">
          {definitions.length} metric{definitions.length === 1 ? '' : 's'} defined
        </span>
      </div>
      <ul className="divide-y divide-line/60">
        {definitions.map((definition) => {
          const apiRate = rateFor(definition.key);
          return (
            <li key={definition.key} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0">
                <span className="block truncate text-[12px] text-ink-dim">{definition.label}</span>
                <span className="block truncate font-mono text-[10px] text-ink-faint">
                  {definition.denominatorLabel}
                </span>
              </span>
              <span className="shrink-0">
                {loading ? (
                  <span className="text-ink-faint">·</span>
                ) : singleChannel && apiRate !== undefined ? (
                  <ApiRateValue rate={apiRate} />
                ) : (
                  <Unknown
                    why={
                      apiRate === undefined
                        ? `/campaigns/:id/stats does not report ${definition.key}, so there is no value to show. It is unknown, not zero.`
                        : 'This campaign sends on more than one channel and the API reports counts campaign-wide. Splitting them here would mean summing per-message unique contacts, which double counts anybody who opened two messages.'
                    }
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {absent.length > 0 && (
        <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-faint">
          Not defined on {channel.toUpperCase()}:{' '}
          {absent.map((key) => (
            <code key={key} className="mr-1 font-mono text-ink-dim">
              {key}
            </code>
          ))}
          {channel === 'sms' && (
            <>
              — SMS has no open tracking of any kind. There is no pixel and no receipt for
              &ldquo;read&rdquo;, so a number here would be fabricated. This row is absent because
              the list is generated from the metric definitions, not because a condition hid it.
            </>
          )}
        </p>
      )}
    </div>
  );
}

// ── funnel ───────────────────────────────────────────────────────────────────

function Funnel({ stages }: { stages: FunnelResponse['stages'] }) {
  const peak = Math.max(...stages.map((stage) => stage.count), 1);
  return (
    <div className="space-y-1.5 p-4">
      {stages.map((stage, index) => {
        const previous = stages[index - 1];
        const comparable = previous?.unit === stage.unit;
        const share =
          comparable && previous !== undefined && previous.count > 0
            ? stage.count / previous.count
            : null;
        return (
          <div key={stage.stage} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-right text-[12px] text-ink-dim">{stage.stage}</span>
            <div className="relative h-6 flex-1 overflow-hidden rounded border border-line bg-ground">
              <div
                className={clsx(
                  'h-full transition-[width]',
                  stage.unit === 'contacts' ? 'bg-accent-dim/70' : 'bg-ok/25',
                )}
                style={{ width: `${String(Math.max((stage.count / peak) * 100, stage.count > 0 ? 1.5 : 0))}%` }}
              />
              <span className="absolute inset-y-0 left-2 flex items-center gap-2 text-[11px]">
                <span className="num text-ink">{int(stage.count)}</span>
                <span className="text-ink-faint">{stage.unit}</span>
              </span>
            </div>
            <span className="w-28 shrink-0 text-[11px]">
              {previous === undefined ? (
                <span className="text-ink-faint">—</span>
              ) : !comparable ? (
                <Tooltip
                  align="right"
                  content={
                    <div className="text-ink-dim">
                      The stage above counts <b className="text-ink">{previous.unit}</b> and this one
                      counts <b className="text-ink">{stage.unit}</b>. Dividing them would produce a
                      number that is wrong by the average messages-per-recipient — stable enough that
                      nobody notices it is wrong, only that it seems low.
                    </div>
                  }
                >
                  <span className="text-ink-faint underline decoration-dotted underline-offset-4">
                    unit change
                  </span>
                </Tooltip>
              ) : share === null ? (
                <span className="num text-ink-faint" title="The stage above is zero, so this share is not computable.">
                  {DASH}
                </span>
              ) : (
                <span className="num text-ink-dim">{(share * 100).toFixed(1)}%</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── daily series ─────────────────────────────────────────────────────────────

type Point = { day: string; scheduled: number; sent: number; delivered: number };

function DailySeries({ rows, limit }: { rows: QueueResponse['messages']; limit: number }) {
  const byDay = new Map<string, Point>();
  const bump = (iso: string | null, field: 'scheduled' | 'sent' | 'delivered') => {
    const key = dayKey(iso);
    if (key === null) return;
    const point = byDay.get(key) ?? { day: key, scheduled: 0, sent: 0, delivered: 0 };
    byDay.set(key, { ...point, [field]: point[field] + 1 });
  };
  for (const row of rows) {
    bump(row.scheduled_at, 'scheduled');
    bump(row.sent_at, 'sent');
    bump(row.delivered_at, 'delivered');
  }
  const points = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const truncated = rows.length >= limit;

  if (rows.length === 0) {
    return (
      <EmptyState
        glyph="◷"
        title="No queue rows for this campaign"
        detail="Nothing has been enqueued yet, so there is no day with activity to plot. This is an empty result, not a failed request."
      />
    );
  }

  return (
    <>
      {truncated && (
        <p className="border-b border-held/25 bg-held-wash px-4 py-2 text-[12px] leading-relaxed text-held">
          Showing the {limit} most recently scheduled rows, which is this endpoint&rsquo;s maximum
          page. Days outside that window are missing from the chart — it is a window, not the
          campaign&rsquo;s history.
        </p>
      )}
      {points.length === 1 && (
        <p className="border-b border-line px-4 py-2 text-[12px] text-ink-dim">
          All activity falls on a single day, so there is no trend to read yet.
        </p>
      )}
      <div className="h-64 px-2 py-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: -12 }}>
            <CartesianGrid stroke="#222833" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="day"
              tick={{ fill: '#6b7488', fontSize: 11 }}
              stroke="#2e3646"
              tickMargin={6}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fill: '#6b7488', fontSize: 11 }}
              stroke="#2e3646"
              width={48}
            />
            <ChartTooltip
              contentStyle={{
                background: '#161a22',
                border: '1px solid #2e3646',
                borderRadius: 6,
                fontSize: 12,
              }}
              labelStyle={{ color: '#e7ebf3' }}
              itemStyle={{ color: '#9aa4b6' }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#9aa4b6' }} />
            {SERIES.map((series) => (
              <Line
                key={series.key}
                type="monotone"
                dataKey={series.key}
                name={series.label}
                stroke={series.color}
                strokeWidth={1.75}
                dot={false}
                activeDot={{ r: 3 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <UnavailableState
        what="This is a derived chart, not a reported one"
        because={
          <>
            The daily rollup lives in <code className="font-mono text-ink-dim">campaign_daily_stats</code>{' '}
            and is rebuildable from <code className="font-mono text-ink-dim">message_events</code>, but
            no endpoint returns it — there is no{' '}
            <code className="font-mono text-ink-dim">GET /campaigns/:id/timeseries</code>. Each point
            above is a count of queue rows whose <code className="font-mono text-ink-dim">scheduled_at</code>,{' '}
            <code className="font-mono text-ink-dim">sent_at</code> or{' '}
            <code className="font-mono text-ink-dim">delivered_at</code> falls on that day, computed
            from rows this page actually received. Opens and clicks are not plotted, because those
            live in <code className="font-mono text-ink-dim">message_events</code> and this endpoint
            does not return them.
          </>
        }
      />
    </>
  );
}
