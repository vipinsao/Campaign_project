import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CampaignCategory, Channel, TriggerType } from '@campaign/shared';
import { api } from '../../lib/api.ts';
import type { FunnelResponse, StatsResponse } from '../../lib/types.ts';
import { useCampaign } from '../CampaignEditor.tsx';
import { ErrorState, LoadingState } from '../../components/States.tsx';
import { StatCard } from '../../components/Rate.tsx';
import { int, sendDaysLabel, timestamp, titleCase } from '../../lib/format.ts';
import { Pill } from '../../components/Pill.tsx';

/**
 * The definition, editable in place, and the counts that follow from it.
 *
 * There is no wizard. Every field is a field; PATCH is per-field on blur, so a
 * half-finished draft is a saved half-finished draft rather than a modal an
 * operator has to complete before they are allowed to leave.
 */
export function OverviewTab() {
  const { campaignId, campaign, messages, reload } = useCampaign();
  const [error, setError] = useState<unknown>(null);

  const stats = useQuery({
    queryKey: ['campaign-stats', campaignId],
    queryFn: () => api.get<StatsResponse>(`/campaigns/${campaignId}/stats`),
  });
  const funnel = useQuery({
    queryKey: ['campaign-funnel', campaignId],
    queryFn: () => api.get<FunnelResponse>(`/campaigns/${campaignId}/funnel`),
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/campaigns/${campaignId}`, body),
    onMutate: () => { setError(null); },
    onSuccess: reload,
    onError: setError,
  });

  const enrolledStage = funnel.data?.stages.find((stage) => stage.stage === 'enrolled');

  return (
    <div className="space-y-3 p-3">
      {error !== null && <ErrorState error={error} />}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Enrolled"
          value={int(enrolledStage?.count)}
          hint="contacts, from /funnel"
        />
        <StatCard label="Queued" value={int(stats.data?.counts.queued)} hint="pending + processing" />
        <StatCard label="Sent" value={int(stats.data?.counts.sent)} hint="sent_at is not null" tone="accent" />
        <StatCard label="Delivered" value={int(stats.data?.counts.delivered)} hint="receipt received" tone="ok" />
        <StatCard label="Bounced" value={int(stats.data?.counts.bounced)} hint="hard + soft" tone="bad" />
        <StatCard label="Messages" value={int(messages.length)} hint={`${String(messages.filter((m) => m.isEnabled).length)} enabled`} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Definition</span>
            {patch.isPending && <span className="text-[11px] text-ink-faint">saving…</span>}
          </div>
          <div className="space-y-3 p-4">
            <div>
              <label className="label" htmlFor="name">Name</label>
              <input
                id="name"
                className="input"
                defaultValue={campaign.name}
                onBlur={(event) => {
                  if (event.target.value !== campaign.name && event.target.value.trim().length > 0) {
                    patch.mutate({ name: event.target.value });
                  }
                }}
              />
            </div>
            <div>
              <label className="label" htmlFor="description">Description</label>
              <textarea
                id="description"
                className="input min-h-16 resize-y"
                defaultValue={campaign.description ?? ''}
                onBlur={(event) => {
                  if (event.target.value !== (campaign.description ?? '')) {
                    patch.mutate({ description: event.target.value.length === 0 ? null : event.target.value });
                  }
                }}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="category">Category</label>
                <select
                  id="category"
                  className="input"
                  value={campaign.category}
                  onChange={(event) => { patch.mutate({ category: event.target.value }); }}
                >
                  {CampaignCategory.options.map((option) => (
                    <option key={option} value={option}>{titleCase(option)}</option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                  {campaign.category === 'transactional' || campaign.category === 'operational'
                    ? 'Exempt from quiet hours, and not required to carry an opt-out. Changing this changes consent handling.'
                    : 'Marketing: an opt-out link is required before this can activate (I7), and quiet hours apply.'}
                </p>
              </div>
              <div>
                <label className="label" htmlFor="trigger">Trigger</label>
                <select
                  id="trigger"
                  className="input"
                  value={campaign.triggerType}
                  onChange={(event) => { patch.mutate({ triggerType: event.target.value }); }}
                >
                  {TriggerType.options.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                  {campaign.triggerType.startsWith('order_')
                    ? 'Order-anchored, so {{order.*}} merge fields resolve.'
                    : 'No order anchor: any {{order.*}} merge field would render empty for every recipient, and activation refuses it.'}
                </p>
              </div>
            </div>

            <div>
              <span className="label">Channels</span>
              <div className="flex gap-2">
                {Channel.options.map((option) => {
                  const on = campaign.channels.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      className={on ? 'btn btn-primary' : 'btn'}
                      onClick={() => {
                        const next = on
                          ? campaign.channels.filter((entry) => entry !== option)
                          : [...campaign.channels, option];
                        if (next.length > 0) patch.mutate({ channels: next });
                      }}
                    >
                      {option.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2 text-[12px]">
              <input
                type="checkbox"
                className="mt-0.5 accent-accent"
                checked={campaign.oneTimePerContact}
                onChange={(event) => { patch.mutate({ oneTimePerContact: event.target.checked }); }}
              />
              <span>
                <span className="text-ink">Send at most once per contact</span>
                <span className="block text-ink-faint">
                  A second enrolment for the same contact is skipped with{' '}
                  <code className="font-mono">one_time_per_contact</code>, and the skip is logged.
                </span>
              </span>
            </label>
          </div>
        </section>

        <div className="space-y-3">
          <section className="panel">
            <div className="panel-head"><span className="panel-title">Current state</span></div>
            <dl className="divide-y divide-line text-[12px]">
              <Row label="Status">
                <span className="text-ink">{titleCase(campaign.status)}</span>
                {campaign.status === 'observe' && (
                  <span className="ml-2 text-ink-faint">
                    evaluates and logs decisions, enqueues nothing
                  </span>
                )}
              </Row>
              <Row label="Active version">
                {campaign.activeVersionId === null ? (
                  <span className="text-ink-faint">— never activated</span>
                ) : (
                  <code className="font-mono text-[11px] text-ink-dim">{campaign.activeVersionId}</code>
                )}
              </Row>
              <Row label="Send window">
                {campaign.sendWindowStart === null && campaign.sendWindowEnd === null ? (
                  <span className="text-ink-faint">— tenant floor only</span>
                ) : (
                  <span className="num">
                    {campaign.sendWindowStart ?? '—'} … {campaign.sendWindowEnd ?? '—'}
                  </span>
                )}
              </Row>
              <Row label="Send days">{sendDaysLabel(campaign.sendDays)}</Row>
              <Row label="Created">{timestamp(campaign.createdAt)}</Row>
              <Row label="Updated">{timestamp(campaign.updatedAt)}</Row>
            </dl>
          </section>

          <section className="panel">
            <div className="panel-head"><span className="panel-title">Where enrolments went</span></div>
            {funnel.isPending ? (
              <LoadingState rows={3} label="Loading skip reasons" />
            ) : funnel.isError ? (
              <ErrorState error={funnel.error} onRetry={() => void funnel.refetch()} />
            ) : (funnel.data.skipsByReason.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-ink-faint">
                No skip decisions recorded for this campaign yet. That is a genuine zero — the
                decision log has rows only when something was decided.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {funnel.data.skipsByReason.map((skip) => (
                  <li key={skip.reasonCode} className="flex items-center justify-between gap-3 px-4 py-2">
                    <Pill tone="quiet" mono>{skip.reasonCode}</Pill>
                    <span className="num text-ink-dim">{int(skip.count)}</span>
                  </li>
                ))}
              </ul>
            ))}
          </section>
        </div>
      </div>

      <TestSend campaignId={campaignId} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2">
      <dt className="w-32 shrink-0 text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink-dim">{children}</dd>
    </div>
  );
}

type TestSendResult = {
  readonly queuedMessageId: string | null;
  readonly to: string;
  readonly warnings: string[];
  readonly rendered: { subject: string | null; body: string; html: string | null };
};

/**
 * Test send, with the refusal it is famous for.
 *
 * `POST /test-send` returns 409 when the address belongs to a real contact in the
 * tenant — a test that mails a customer is not a test — and it returns `warnings`
 * when the campaign is not active, because the gate chain is not bypassed and the
 * message will be held. Both are rendered here rather than swallowed.
 */
function TestSend({ campaignId }: { campaignId: string }) {
  const [to, setTo] = useState('');
  const [result, setResult] = useState<TestSendResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  const send = useMutation({
    mutationFn: (address: string) =>
      api.post<TestSendResult>(`/campaigns/${campaignId}/test-send`, { to: address }),
    onMutate: () => { setError(null); setResult(null); },
    onSuccess: setResult,
    onError: setError,
  });

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Test send</span>
        <span className="text-[11px] text-ink-faint">
          enqueues through the one send path — every gate still applies
        </span>
      </div>
      <div className="p-4">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            send.mutate(to.trim());
          }}
        >
          <input
            className="input max-w-sm"
            placeholder="you@example.com or +15550100"
            value={to}
            onChange={(event) => { setTo(event.target.value); }}
          />
          <button type="submit" className="btn" disabled={send.isPending || to.trim().length === 0}>
            {send.isPending ? 'Queueing…' : 'Queue test'}
          </button>
        </form>

        {error !== null && <ErrorState error={error} title="Test send refused" />}

        {result !== null && (
          <div className="mt-3 rounded border border-line bg-ground/50 p-3 text-[12px]">
            <div className="mb-2 text-ink">
              Queued <code className="font-mono text-[11px] text-accent">{result.queuedMessageId ?? 'nothing (deduplicated)'}</code>{' '}
              for {result.to}
            </div>
            {result.warnings.map((warning, index) => (
              <p key={index} className="mb-2 rounded border border-held/30 bg-held-wash px-2 py-1.5 text-held">
                {warning}
              </p>
            ))}
            {result.rendered.subject !== null && (
              <div className="mb-1 text-ink-dim">
                <span className="text-ink-faint">subject </span>
                {result.rendered.subject}
              </div>
            )}
            <pre className="max-h-48 overflow-auto rounded bg-ground p-2 font-mono text-[11px] whitespace-pre-wrap text-ink-dim">
              {result.rendered.body}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}
