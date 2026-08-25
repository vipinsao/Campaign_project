import { createContext, use, useState } from 'react';
import { NavLink, Outlet, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api, failuresByMessage } from '../lib/api.ts';
import type { Campaign, CampaignMessage, CampaignResponse, MessagesResponse } from '../lib/types.ts';
import { PageHeader, Scroll } from '../components/Layout.tsx';
import { CampaignStatusPill, ChannelBadges, Pill } from '../components/Pill.tsx';
import { ErrorState, LoadingState } from '../components/States.tsx';
import { titleCase } from '../lib/format.ts';

const TABS = [
  { path: 'overview', label: 'Overview' },
  { path: 'audience', label: 'Audience' },
  { path: 'messages', label: 'Messages' },
  { path: 'journey', label: 'Journey' },
  { path: 'schedule', label: 'Schedule' },
  { path: 'analytics', label: 'Analytics' },
] as const;

export type CampaignContextValue = {
  readonly campaignId: string;
  readonly campaign: Campaign;
  readonly messages: readonly CampaignMessage[];
  readonly reload: () => void;
  /**
   * Activation failures keyed by `campaignMessageId`, from the 422 the API
   * returned. `'__campaign'` holds the ones that belong to the campaign itself.
   *
   * They live up here rather than in a toast because the journey canvas renders
   * them on the offending node, and a toast that says "3 problems" while the node
   * that has the problem looks fine is worse than no message at all.
   */
  readonly activationFailures: Map<string, string[]>;
  readonly clearActivationFailures: () => void;
};

const CampaignContext = createContext<CampaignContextValue | null>(null);

export function useCampaign(): CampaignContextValue {
  const value = use(CampaignContext);
  if (value === null) throw new Error('useCampaign() outside a campaign route');
  return value;
}

export function CampaignEditor() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [activationFailures, setActivationFailures] = useState<Map<string, string[]>>(new Map());
  const [actionError, setActionError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const campaignQuery = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api.get<CampaignResponse>(`/campaigns/${id}`),
  });
  const messagesQuery = useQuery({
    queryKey: ['campaign-messages', id],
    queryFn: () => api.get<MessagesResponse>(`/campaigns/${id}/messages`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['campaign', id] });
    void queryClient.invalidateQueries({ queryKey: ['campaign-messages', id] });
    void queryClient.invalidateQueries({ queryKey: ['campaign-stats', id] });
  };

  const activate = useMutation({
    mutationFn: () => api.post<{ campaign: Campaign; version: { version: number } }>(`/campaigns/${id}/activate`),
    onMutate: () => {
      setActionError(null);
      setNote(null);
      setActivationFailures(new Map());
    },
    onSuccess: (result) => {
      setNote(`Activated as version ${String(result.version.version)}. The definition is now frozen for messages already queued.`);
      invalidate();
    },
    onError: (error) => {
      // The 422 carries EVERY failing check in `details.failures`, not the first
      // one. Scattering them onto the tabs they belong to is the whole reason the
      // API collects them instead of throwing on the first.
      if (error instanceof ApiError) setActivationFailures(failuresByMessage(error.details));
      setActionError(error);
    },
  });

  const pause = useMutation({
    mutationFn: () => api.post<{ heldMessages: number; note: string }>(`/campaigns/${id}/pause`),
    onMutate: () => {
      setActionError(null);
      setNote(null);
    },
    onSuccess: (result) => {
      setNote(`${String(result.heldMessages)} queued message(s) held. ${result.note}`);
      invalidate();
    },
    onError: setActionError,
  });

  if (campaignQuery.isPending || messagesQuery.isPending) {
    return (
      <>
        <PageHeader title="Campaign" />
        <LoadingState rows={10} label="Loading campaign" />
      </>
    );
  }
  if (campaignQuery.isError) {
    return (
      <>
        <PageHeader title="Campaign" />
        <ErrorState error={campaignQuery.error} onRetry={() => void campaignQuery.refetch()} />
      </>
    );
  }
  if (messagesQuery.isError) {
    return (
      <>
        <PageHeader title="Campaign" />
        <ErrorState error={messagesQuery.error} onRetry={() => void messagesQuery.refetch()} />
      </>
    );
  }

  const campaign = campaignQuery.data.campaign;
  const messages = messagesQuery.data.messages;
  const campaignLevelFailures = activationFailures.get('__campaign') ?? [];

  const context: CampaignContextValue = {
    campaignId: id,
    campaign,
    messages,
    reload: invalidate,
    activationFailures,
    clearActivationFailures: () => { setActivationFailures(new Map()); },
  };

  return (
    <CampaignContext value={context}>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            {campaign.name}
            <CampaignStatusPill status={campaign.status} />
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Pill tone="quiet">{titleCase(campaign.category)}</Pill>
            <Pill tone="quiet" mono>
              {campaign.triggerType}
            </Pill>
            <ChannelBadges channels={campaign.channels} />
            <span className="font-mono text-[11px] text-ink-faint">{campaign.id}</span>
          </span>
        }
        actions={
          <>
            {campaign.status !== 'active' && campaign.status !== 'archived' && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={activate.isPending}
                onClick={() => { activate.mutate(); }}
              >
                {activate.isPending ? 'Checking…' : 'Activate'}
              </button>
            )}
            {(campaign.status === 'active' || campaign.status === 'observe') && (
              <button
                type="button"
                className="btn"
                disabled={pause.isPending}
                onClick={() => { pause.mutate(); }}
              >
                Pause
              </button>
            )}
          </>
        }
        tabs={
          <nav className="-mb-px flex gap-1">
            {TABS.map((tab) => (
              <NavLink
                key={tab.path}
                to={tab.path}
                className={({ isActive }) =>
                  clsx(
                    'border-b-2 px-3 py-2 text-[13px] transition-colors',
                    isActive
                      ? 'border-accent text-ink'
                      : 'border-transparent text-ink-dim hover:border-line-strong hover:text-ink',
                  )
                }
              >
                {tab.label}
                {tab.path === 'journey' && activationFailures.size > 0 && (
                  <span className="ml-1.5 rounded bg-bad-wash px-1 font-mono text-[10px] text-bad">
                    {[...activationFailures.values()].reduce((sum, list) => sum + list.length, 0)}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
        }
      />

      <Scroll>
        {note !== null && (
          <div className="mx-3 mt-3 rounded-md border border-ok/30 bg-ok-wash px-3 py-2 text-[12px] text-ok">
            {note}
          </div>
        )}
        {actionError !== null && (
          <ErrorState
            error={actionError}
            title={activate.isError ? 'This campaign cannot be activated yet' : 'The action failed'}
          />
        )}
        {campaignLevelFailures.length > 0 && (
          <div className="mx-3 mt-3 rounded-md border border-bad/30 bg-bad-wash px-3 py-2">
            <div className="mb-1 text-[12px] font-medium text-bad">Campaign-level problems</div>
            <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-ink-dim">
              {campaignLevelFailures.map((failure, index) => (
                <li key={index}>{failure}</li>
              ))}
            </ul>
          </div>
        )}
        <Outlet />
      </Scroll>
    </CampaignContext>
  );
}
