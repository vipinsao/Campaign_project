import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CampaignCategory, CampaignStatus, Channel } from '@campaign/shared';
import type {
  CampaignCategory as Category,
  CampaignStatus as Status,
  Channel as Chan,
} from '@campaign/shared';
import { api } from '../lib/api.ts';
import type {
  Campaign,
  CampaignListResponse,
  EnrollmentsResponse,
  StatsResponse,
} from '../lib/types.ts';
import { DASH, int, relative, titleCase } from '../lib/format.ts';
import { PageHeader, Scroll } from '../components/Layout.tsx';
import { CampaignStatusPill, ChannelBadges, Pill } from '../components/Pill.tsx';
import { ApiRateValue, Unknown } from '../components/Rate.tsx';
import { EmptyState, ErrorState, LoadingState } from '../components/States.tsx';
import { Tooltip } from '../components/Tooltip.tsx';

/**
 * The campaign list.
 *
 * `status` filters on the server (the endpoint takes it); category, channel and
 * the text search filter the loaded page in the browser, and the footer says so
 * rather than implying the counts are tenant-wide.
 *
 * Per-row delivery and open rates come from `/campaigns/:id/stats`, one query per
 * row, which returns each rate ALREADY paired with its denominator sentence and
 * caveat. The list therefore shows exactly the numbers the analytics tab shows,
 * because they are literally the same payload.
 */
export function CampaignsPage() {
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [category, setCategory] = useState<Category | null>(null);
  const [channel, setChannel] = useState<Chan | null>(null);

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

  const list = useQuery({
    queryKey: ['campaigns', status],
    queryFn: () =>
      api.get<CampaignListResponse>('/campaigns', {
        limit: 200,
        ...(status === null ? {} : { status }),
      }),
  });

  const all = list.data?.campaigns ?? [];
  const needle = search.trim().toLowerCase();
  const rows = all.filter(
    (campaign) =>
      (category === null || campaign.category === category) &&
      (channel === null || campaign.channels.includes(channel)) &&
      (needle.length === 0 ||
        campaign.name.toLowerCase().includes(needle) ||
        (campaign.description ?? '').toLowerCase().includes(needle) ||
        campaign.id.startsWith(needle)),
  );

  const stats = useQueries({
    queries: rows.map((campaign) => ({
      queryKey: ['campaign-stats', campaign.id],
      queryFn: () => api.get<StatsResponse>(`/campaigns/${campaign.id}/stats`),
      staleTime: 30_000,
    })),
  });

  const enrolled = useQueries({
    queries: rows.map((campaign) => ({
      queryKey: ['campaign-enrolled', campaign.id],
      queryFn: () =>
        api.get<EnrollmentsResponse>(`/campaigns/${campaign.id}/enrollments`, { limit: 1 }),
      staleTime: 30_000,
    })),
  });

  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle={
          <>
            Every rate below carries its denominator — hover it. A rate whose denominator is zero
            renders as <span className="font-mono text-ink">—</span>, never as 0.0%.
          </>
        }
        actions={
          <>
            <div className="relative">
              <input
                ref={searchRef}
                className="input w-64 pl-7"
                placeholder="Search name, description, id"
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
            <button type="button" className="btn" onClick={() => void list.refetch()}>
              Refresh
            </button>
          </>
        }
        tabs={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-3">
            <ChipGroup
              label="status"
              options={CampaignStatus.options}
              value={status}
              onChange={setStatus}
            />
            <ChipGroup
              label="category"
              options={CampaignCategory.options}
              value={category}
              onChange={setCategory}
            />
            <ChipGroup
              label="channel"
              options={Channel.options}
              value={channel}
              onChange={setChannel}
            />
          </div>
        }
      />

      <Scroll>
        {list.isPending ? (
          <LoadingState rows={8} label="Loading campaigns" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            glyph={all.length === 0 ? '∅' : '⌕'}
            title={
              all.length === 0
                ? 'No campaigns in this tenant yet'
                : 'No campaign matches these filters'
            }
            detail={
              all.length === 0 ? (
                <>
                  Run <code className="font-mono text-ink-dim">npm run seed:demo</code> to populate
                  the demo dataset, or create one through{' '}
                  <code className="font-mono text-ink-dim">POST /campaigns</code>.
                </>
              ) : (
                `${String(all.length)} campaigns loaded; none of them match.`
              )
            }
            action={
              all.length > 0 ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setSearch('');
                    setStatus(null);
                    setCategory(null);
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
                <th className="th">Campaign</th>
                <th className="th">Category</th>
                <th className="th">Status</th>
                <th className="th">Channels</th>
                <th className="th text-right">Enrolled</th>
                <th className="th text-right">
                  <Tooltip
                    align="right"
                    content={
                      <>
                        <div className="mb-1 font-semibold text-ink">Sent — all time</div>
                        <div className="text-ink-dim">
                          The API exposes no time-windowed send count, so a “last 7 days” figure
                          would have to be invented here. This is the all-time count from{' '}
                          <span className="font-mono text-accent">/campaigns/:id/stats</span>.
                        </div>
                      </>
                    }
                  >
                    <span className="underline decoration-dotted underline-offset-4">Sent</span>
                  </Tooltip>
                </th>
                <th className="th text-right">Delivery</th>
                <th className="th text-right">Open</th>
                <th className="th text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((campaign, index) => (
                <Row
                  key={campaign.id}
                  campaign={campaign}
                  stats={stats[index]?.data}
                  statsPending={stats[index]?.isPending ?? true}
                  statsFailed={stats[index]?.isError ?? false}
                  enrolled={enrolled[index]?.data?.page.total}
                  onOpen={() => void navigate(`/campaigns/${campaign.id}/overview`)}
                />
              ))}
            </tbody>
          </table>
        )}

        {!list.isPending && !list.isError && (
          <div className="px-5 py-3 text-[11px] text-ink-faint">
            {rows.length} of {all.length} loaded
            {status !== null && <> · server-filtered to {status}</>} · page limit 200
            {(list.data?.page.total ?? 0) > all.length && (
              <>
                {' '}
                · {list.data?.page.total} exist in this tenant, so category/channel/search filters
                apply to the loaded page only
              </>
            )}
          </div>
        )}
      </Scroll>
    </>
  );
}

function Row({
  campaign,
  stats,
  statsPending,
  statsFailed,
  enrolled,
  onOpen,
}: {
  campaign: Campaign;
  stats: StatsResponse | undefined;
  statsPending: boolean;
  statsFailed: boolean;
  enrolled: number | undefined;
  onOpen: () => void;
}) {
  const delivery = stats?.rates.find((entry) => entry.key === 'delivery_rate');
  const open = stats?.rates.find((entry) => entry.key === 'open_rate');

  return (
    <tr
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer border-b border-line/60 outline-none hover:bg-raised focus-visible:bg-raised"
    >
      <td className="cell max-w-md">
        <div className="truncate font-medium text-ink">{campaign.name}</div>
        {campaign.description !== null && campaign.description.length > 0 && (
          <div className="truncate text-[11px] text-ink-faint">{campaign.description}</div>
        )}
      </td>
      <td className="cell">
        <Pill
          tone={
            campaign.category === 'transactional' || campaign.category === 'operational'
              ? 'info'
              : 'quiet'
          }
        >
          {titleCase(campaign.category)}
        </Pill>
      </td>
      <td className="cell">
        <CampaignStatusPill status={campaign.status} />
      </td>
      <td className="cell">
        <ChannelBadges channels={campaign.channels} />
      </td>
      <td className="cell num text-right">
        {enrolled === undefined ? <span className="text-ink-faint">·</span> : int(enrolled)}
      </td>
      <td className="cell num text-right">
        {statsPending ? (
          <span className="text-ink-faint">·</span>
        ) : statsFailed ? (
          <Unknown why="This campaign's stats request failed. The row is not zero — it is unknown." />
        ) : (
          int(stats?.counts.sent)
        )}
      </td>
      <td className="cell text-right">
        {delivery === undefined ? (
          <span className="text-ink-faint">{DASH}</span>
        ) : (
          <ApiRateValue rate={delivery} />
        )}
      </td>
      <td className="cell text-right">
        {open === undefined ? (
          <span className="text-ink-faint">{DASH}</span>
        ) : (
          <ApiRateValue rate={open} />
        )}
      </td>
      <td className="cell text-right text-[11px] whitespace-nowrap text-ink-faint">
        {relative(campaign.updatedAt)}
      </td>
    </tr>
  );
}

function ChipGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T | null;
  onChange: (next: T | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] tracking-wide text-ink-faint uppercase">{label}</span>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => {
            onChange(value === option ? null : option);
          }}
          className={clsx(
            'rounded border px-1.5 py-px text-[11px] transition-colors',
            value === option
              ? 'border-accent-dim bg-accent-wash text-accent'
              : 'border-line text-ink-dim hover:border-line-strong hover:text-ink',
          )}
        >
          {titleCase(option)}
        </button>
      ))}
    </div>
  );
}
