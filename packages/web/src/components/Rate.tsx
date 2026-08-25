import type { Channel } from '@campaign/shared';
import { METRICS, formatRate, isMetricValidForChannel, rate } from '../lib/metrics.ts';
import type { MetricInputs, MetricKey } from '../lib/metrics.ts';
import type { ApiRate } from '../lib/types.ts';
import { DASH } from '../lib/format.ts';
import { Tooltip } from './Tooltip.tsx';

/**
 * Every rate on screen goes through this file, and every one of them shows its
 * denominator on hover.
 *
 * Three states, never collapsed into two:
 *
 *   a value   "48.2%" — with `METRICS[key].denominatorLabel` and any caveat
 *   unknown   "—"     — the denominator is zero, so the rate is not computable
 *   n/a       "n/a"   — the metric does not exist on this channel at all
 *
 * The middle one is the one products get wrong. `rate()` returns null on a zero
 * denominator and this component renders that as an em dash. Printing 0.0% would
 * assert "nobody opened it" about a campaign that has delivered nothing, which is
 * where essentially every "0% open rate" escalation comes from.
 */

function Body({
  label,
  denominator,
  caveat,
  computable,
}: {
  label: string;
  denominator: string;
  caveat?: string | undefined;
  computable: boolean;
}) {
  return (
    <>
      <div className="mb-1 font-semibold text-ink">{label}</div>
      <div className="mb-1 font-mono text-[11px] text-accent">{denominator}</div>
      {!computable && (
        <div className="mb-1 text-ink-dim">
          The denominator is zero, so this rate is not computable yet. It is shown as{' '}
          <span className="font-mono">—</span> rather than 0%, because those are different answers.
        </div>
      )}
      {caveat !== undefined && <div className="text-ink-faint">{caveat}</div>}
    </>
  );
}

/** A rate computed here, from counts, using the domain's own `rate()`. */
export function RateValue({
  metricKey,
  inputs,
  channel,
  note,
  className,
}: {
  metricKey: MetricKey;
  inputs: MetricInputs;
  /** When given, an inapplicable metric renders `n/a` instead of a number. */
  channel?: Channel;
  /** Extra sentence for cases where an endpoint does not report the denominator. */
  note?: string;
  className?: string;
}) {
  const definition = METRICS[metricKey];

  if (channel !== undefined && !isMetricValidForChannel(metricKey, channel)) {
    return <NotApplicable metricKey={metricKey} channel={channel} />;
  }

  const value = rate(metricKey, inputs);
  const caveat = [definition.caveat, note].filter(Boolean).join(' ');

  return (
    <Tooltip
      content={
        <Body
          label={definition.label}
          denominator={definition.denominatorLabel}
          caveat={caveat.length > 0 ? caveat : undefined}
          computable={value !== null}
        />
      }
    >
      <span
        className={
          className ??
          (value === null
            ? 'num text-ink-faint'
            : 'num text-ink underline decoration-line-strong decoration-dotted underline-offset-4')
        }
      >
        {formatRate(value)}
      </span>
    </Tooltip>
  );
}

/**
 * A rate the API computed, rendered with the denominator and caveat IT sent.
 *
 * `/campaigns/:id/stats` returns `{ value, denominator, caveat, applicable }` for
 * every metric, straight off the core definition. Recomputing it here from counts
 * would be a second implementation of a module whose entire purpose is to be the
 * only implementation — so this component trusts the payload and renders it.
 */
export function ApiRateValue({ rate: apiRate }: { rate: ApiRate }) {
  if (!apiRate.applicable) {
    return (
      <Tooltip
        content={
          <>
            <div className="mb-1 font-semibold text-ink">{apiRate.label}</div>
            <div className="text-ink-dim">
              This metric does not exist on this campaign&rsquo;s channels. It is not zero and it is
              not unknown — there is nothing to measure.
            </div>
          </>
        }
      >
        <span className="num text-ink-faint/60 italic">n/a</span>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      content={
        <Body
          label={apiRate.label}
          denominator={apiRate.denominator}
          caveat={apiRate.caveat}
          computable={apiRate.value !== null}
        />
      }
    >
      <span
        className={
          apiRate.value === null
            ? 'num text-ink-faint'
            : 'num text-ink underline decoration-line-strong decoration-dotted underline-offset-4'
        }
      >
        {formatRate(apiRate.value)}
      </span>
    </Tooltip>
  );
}

export function NotApplicable({ metricKey, channel }: { metricKey: MetricKey; channel: Channel }) {
  return (
    <Tooltip
      content={
        <>
          <div className="mb-1 font-semibold text-ink">{METRICS[metricKey].label}</div>
          <div className="text-ink-dim">
            Not defined on {channel.toUpperCase()}.{' '}
            {metricKey === 'open_rate'
              ? 'SMS has no open tracking of any kind — there is no pixel and no receipt for “read”. A number here would be fabricated.'
              : `METRICS['${metricKey}'].channels does not include '${channel}'.`}
          </div>
        </>
      }
    >
      <span className="num text-ink-faint/60 italic">n/a</span>
    </Tooltip>
  );
}

/** A value the API simply does not report. An em dash, and a reason on hover. */
export function Unknown({ why }: { why: string }) {
  return (
    <Tooltip content={<div className="text-ink-dim">{why}</div>}>
      <span className="num text-ink-faint">{DASH}</span>
    </Tooltip>
  );
}

/** The big number on a stat card, with its denominator underneath. */
export function RateCard({ rate: apiRate }: { rate: ApiRate }) {
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="mb-1 truncate text-[11px] tracking-wide text-ink-faint uppercase">
        {apiRate.label}
      </div>
      <div className="text-xl leading-tight font-semibold tabular-nums">
        <ApiRateValue rate={apiRate} />
      </div>
      <div className="mt-1 truncate font-mono text-[10px] text-ink-faint">
        {apiRate.applicable ? apiRate.denominator : 'not defined on this channel'}
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'ok' | 'bad' | 'held' | 'accent';
}) {
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="mb-1 truncate text-[11px] tracking-wide text-ink-faint uppercase">
        {label}
      </div>
      <div
        className={
          'text-xl leading-tight font-semibold tabular-nums ' +
          (tone === 'ok'
            ? 'text-ok'
            : tone === 'bad'
              ? 'text-bad'
              : tone === 'held'
                ? 'text-held'
                : tone === 'accent'
                  ? 'text-accent'
                  : 'text-ink')
        }
      >
        {value}
      </div>
      {hint !== undefined && <div className="mt-1 truncate text-[10px] text-ink-faint">{hint}</div>}
    </div>
  );
}
