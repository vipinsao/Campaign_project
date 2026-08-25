import type { ReactNode } from 'react';
import clsx from 'clsx';
import { ApiError, NetworkError, explainDetails } from '../lib/api.ts';

/**
 * Loading, empty and error. Three components, three silhouettes.
 *
 * They are deliberately not variants of one component, because the failure this
 * prevents is visual: a spinner that resolves into "No results" looks identical
 * whether the query returned nothing or the request failed. An operator who reads
 * "no failed messages" from a 500 stops looking — which is the worst possible
 * outcome on a page whose entire job is to tell them what went wrong.
 *
 *   loading  animated grey skeleton rows, no border, no icon
 *   empty    dashed outline, centred glyph, neutral, offers the next action
 *   error    solid red wash, a red rule down the left, the code, and `details`
 *
 * You can tell them apart from across the room, which is the test.
 */

export function LoadingState({ rows = 5, label }: { rows?: number; label?: string }) {
  return (
    <div className="p-4" role="status" aria-live="polite" aria-busy="true">
      <div className="mb-3 flex items-center gap-2 text-[11px] tracking-wide text-ink-faint uppercase">
        <span className="inline-block size-2 animate-pulse rounded-full bg-accent" />
        {label ?? 'Loading'}
      </div>
      <div className="space-y-2">
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="h-7 animate-pulse rounded bg-raised"
            style={{ animationDelay: `${String(index * 90)}ms`, opacity: 1 - index * 0.12 }}
          />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  glyph = '∅',
  action,
  compact = false,
}: {
  title: string;
  detail?: ReactNode;
  glyph?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={clsx(
        'm-3 flex flex-col items-center justify-center rounded-md border border-dashed border-line-strong bg-ground/40 text-center',
        compact ? 'gap-1.5 px-4 py-6' : 'gap-2 px-6 py-12',
      )}
    >
      <div className="font-mono text-2xl leading-none text-ink-faint/60 select-none">{glyph}</div>
      <div className="text-[13px] font-medium text-ink-dim">{title}</div>
      {detail !== undefined && (
        <div className="max-w-lg text-[12px] leading-relaxed text-ink-faint">{detail}</div>
      )}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  const isApi = error instanceof ApiError;
  const isNetwork = error instanceof NetworkError;
  const code = isApi ? error.code : isNetwork ? 'unreachable' : 'unexpected_error';
  const status = isApi ? error.status : null;
  const message =
    error instanceof Error ? error.message : 'Something failed and produced no message.';
  const lines = isApi ? explainDetails(error.details) : [];

  return (
    <div className="m-3 overflow-hidden rounded-md border border-bad/40 bg-bad-wash" role="alert">
      <div className="flex items-start gap-3 border-l-2 border-bad px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-bad">
              {title ?? (isNetwork ? 'The API did not answer' : 'The request failed')}
            </span>
            <span className="rounded border border-bad/40 bg-ground/40 px-1.5 py-px font-mono text-[10px] text-bad">
              {status === null ? code : `${String(status)} · ${code}`}
            </span>
          </div>
          <p className="text-[12px] leading-relaxed text-ink-dim">{message}</p>

          {/*
            `error.details` on screen, not in a console nobody opens. The API
            preserves this field on purpose; dropping it here would turn a precise
            diagnosis — which of forty audience rules, which of nine activation
            checks — back into "failed".
          */}
          {lines.length > 0 && (
            <ul className="mt-2.5 space-y-1 border-t border-bad/20 pt-2.5">
              {lines.map((line, index) => (
                <li key={index} className="flex gap-2 text-[12px] leading-relaxed">
                  {line.at !== null && (
                    <code className="shrink-0 rounded bg-ground/50 px-1 font-mono text-[11px] text-held">
                      {line.at}
                    </code>
                  )}
                  <span className="text-ink-dim">{line.text}</span>
                </li>
              ))}
            </ul>
          )}

          {onRetry !== undefined && (
            <button type="button" className="btn btn-danger mt-3" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The fourth state, and the one most products skip: a thing the API cannot tell us.
 *
 * It is not an error (nothing failed) and it is not empty (there may well be data).
 * Rendering either of those would be a lie, so it gets its own treatment — an
 * amber note that names the endpoint that would answer the question.
 */
export function UnavailableState({ what, because }: { what: string; because: ReactNode }) {
  return (
    <div className="m-3 rounded-md border border-held/30 bg-held-wash/60 px-4 py-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-[13px] text-held select-none">—</span>
        <span className="text-[13px] font-medium text-held">{what}</span>
      </div>
      <p className="text-[12px] leading-relaxed text-ink-dim">{because}</p>
    </div>
  );
}
