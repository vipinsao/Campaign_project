import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { CampaignStatus, Channel } from '@campaign/shared';
import { titleCase } from '../lib/format.ts';

/**
 * Status at a glance, and the glance has to be right.
 *
 * The tones encode MEANING, and the meaning that matters most on this screen is
 * the retryable/terminal split the domain draws: `quiet_hours_deferred` is the
 * system working (held, amber) and `suppressed_complaint` is the system refusing
 * forever (terminal, red). Painting both of them red is how an operator "fixes"
 * quiet hours by widening the window.
 */
export type Tone = 'ok' | 'held' | 'bad' | 'info' | 'quiet' | 'accent';

const TONES: Record<Tone, string> = {
  ok: 'border-ok/35 bg-ok-wash text-ok',
  held: 'border-held/35 bg-held-wash text-held',
  bad: 'border-bad/35 bg-bad-wash text-bad',
  info: 'border-info/35 bg-info-wash text-info',
  quiet: 'border-line-strong bg-quiet-wash text-ink-dim',
  accent: 'border-accent-dim bg-accent-wash text-accent',
};

export function Pill({
  tone = 'quiet',
  children,
  mono = false,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] leading-[18px] font-medium whitespace-nowrap',
        mono && 'font-mono text-[10px]',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

const CAMPAIGN_STATUS: Record<CampaignStatus, Tone> = {
  draft: 'quiet',
  observe: 'info',
  active: 'ok',
  paused: 'held',
  archived: 'quiet',
};

export function CampaignStatusPill({ status }: { status: CampaignStatus }) {
  return (
    <Pill tone={CAMPAIGN_STATUS[status]}>
      <Dot tone={CAMPAIGN_STATUS[status]} />
      {titleCase(status)}
    </Pill>
  );
}

const QUEUE_STATUS: Record<string, Tone> = {
  pending: 'quiet',
  processing: 'info',
  sent: 'accent',
  delivered: 'ok',
  failed: 'bad',
  cancelled: 'quiet',
  suppressed: 'held',
  bounced: 'bad',
  complained: 'bad',
};

export function QueueStatusPill({ status }: { status: string }) {
  const tone = QUEUE_STATUS[status] ?? 'quiet';
  return (
    <Pill tone={tone}>
      <Dot tone={tone} />
      {titleCase(status)}
    </Pill>
  );
}

function Dot({ tone }: { tone: Tone }) {
  return (
    <span
      className={clsx(
        'inline-block size-1.5 rounded-full',
        tone === 'ok' && 'bg-ok',
        tone === 'held' && 'bg-held',
        tone === 'bad' && 'bg-bad',
        tone === 'info' && 'bg-info',
        tone === 'accent' && 'bg-accent',
        tone === 'quiet' && 'bg-ink-faint',
      )}
    />
  );
}

export function ChannelBadge({ channel }: { channel: Channel }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded border px-1 py-px font-mono text-[10px] tracking-wider uppercase',
        channel === 'email'
          ? 'border-accent-dim/60 bg-accent-wash text-accent'
          : 'border-ok/30 bg-ok-wash text-ok',
      )}
    >
      {channel === 'email' ? 'EML' : 'SMS'}
    </span>
  );
}

export function ChannelBadges({ channels }: { channels: readonly Channel[] }) {
  return (
    <span className="inline-flex gap-1">
      {channels.map((channel) => (
        <ChannelBadge key={channel} channel={channel} />
      ))}
    </span>
  );
}

/**
 * The reason a message did or did not go out.
 *
 * The tone is derived from the code's FAMILY, which is the same grouping the
 * domain uses: proceed / permanently refused / held for later / not applicable.
 * The code itself is always shown in mono — it is the thing an operator pastes
 * into a search box, and prose alone cannot be grepped.
 */
export function reasonTone(code: string): Tone {
  if (code === 'enqueued' || code === 'sent') return 'ok';
  if (code === 'observe_mode_no_enqueue' || code === 'trigger_dry_run') return 'info';
  if (
    code.startsWith('suppressed_') ||
    code.startsWith('consent_') ||
    code === 'provider_terminal_error' ||
    code === 'retry_exhausted' ||
    code === 'stale_claim_exhausted' ||
    code === 'no_recipient_address' ||
    code === 'recipient_ambiguous' ||
    code === 'delivery_anchor_expired'
  ) {
    return 'bad';
  }
  if (
    code === 'quiet_hours_deferred' ||
    code === 'frequency_cap' ||
    code === 'campaign_not_active' ||
    code === 'provider_transient_error' ||
    code === 'trigger_circuit_breaker' ||
    code === 'trigger_floor_not_set'
  ) {
    return 'held';
  }
  return 'quiet';
}

export function ReasonChip({ code, title }: { code: string; title?: string }) {
  return (
    <Pill tone={reasonTone(code)} mono title={title}>
      {code}
    </Pill>
  );
}

export function DecisionChip({ decision }: { decision: string }) {
  const tone: Tone =
    decision === 'proceed' ? 'ok' : decision === 'skip' ? 'bad' : decision === 'defer' ? 'held' : 'quiet';
  return (
    <Pill tone={tone} mono>
      {decision}
    </Pill>
  );
}
