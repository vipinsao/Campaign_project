import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../../lib/api.ts';
import { useCampaign } from '../CampaignEditor.tsx';
import { ErrorState, UnavailableState } from '../../components/States.tsx';
import { Pill } from '../../components/Pill.tsx';
import { Tooltip } from '../../components/Tooltip.tsx';
import { DASH, dayName, sendDaysLabel } from '../../lib/format.ts';

/**
 * Quiet hours, made visible  (I5).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The invariant is that a send window is evaluated in the RECIPIENT's timezone,
 * falling back to the tenant default and never to the server's — and that campaign
 * configuration may NARROW the tenant floor and can never widen it.
 *
 * Stated in prose, that is a sentence in a README. The strip below is the same
 * sentence as a fact on screen: pick an instant, and see what each of six real
 * zones does with it. The operator in London who sets "09:00–17:00" and reads it
 * as "my afternoon" is the person this screen exists for; the row that says a
 * contact in Asia/Tokyo is held until tomorrow morning is the thing that tells
 * them before a customer does.
 *
 * The arithmetic here mirrors `resolveSendTime` in
 * packages/core/src/scheduling/quiet-hours.ts — same window intersection, same
 * "advance to the next permitted local weekday" loop. It is a PREVIEW, and it says
 * so: the real decision is taken again at send time by that module, because a
 * decision made at enqueue is stale by the time a worker picks the row up (I1).
 *
 * It runs on `Intl` rather than on offset arithmetic, for the same reason core
 * runs on Luxon: `+ offsetHours * 3600000` is correct until the offset changes
 * underneath you, twice a year, in only some countries.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Six zones chosen to break things: a half-hour offset, a no-DST zone, and a
 *  date-line pair that lands on different DAYS for the same instant. */
const ZONES: readonly { id: string; label: string; why: string }[] = [
  { id: 'America/Los_Angeles', label: 'Los Angeles', why: 'UTC−8/−7, observes DST.' },
  { id: 'America/New_York', label: 'New York', why: 'UTC−5/−4, observes DST.' },
  { id: 'Europe/London', label: 'London', why: 'UTC+0/+1 — the zone an operator most often mistakes for UTC.' },
  { id: 'Europe/Berlin', label: 'Berlin', why: 'UTC+1/+2, observes DST.' },
  { id: 'Asia/Kolkata', label: 'Kolkata', why: 'UTC+5:30 — a half-hour offset, which breaks integer-hour maths.' },
  { id: 'Asia/Tokyo', label: 'Tokyo', why: 'UTC+9, no DST at all, and usually the next calendar day already.' },
];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const PARTS_FORMAT = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const existing = PARTS_FORMAT.get(zone);
  if (existing !== undefined) return existing;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  PARTS_FORMAT.set(zone, created);
  return created;
}

/** The wall-clock reading in `zone` at `instant`. */
function partsIn(instant: Date, zone: string): Parts {
  const bag: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(instant)) bag[part.type] = part.value;
  return {
    year: Number(bag.year),
    // `hour12:false` can render midnight as 24 in some engines; normalise it.
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour) % 24,
    minute: Number(bag.minute),
    weekday: WEEKDAY_INDEX[bag.weekday ?? 'Sun'] ?? 0,
  };
}

/** The zone's offset from UTC, in minutes, at that instant. */
function offsetMinutes(instant: Date, zone: string): number {
  const parts = partsIn(instant, zone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The instant at which `zone` reads the given wall-clock time.
 *
 * Applied twice because the offset used to make the first guess is the offset at
 * the WRONG instant whenever the guess crosses a DST boundary. Two passes settle
 * everywhere outside the one-hour gap itself, and a time inside a spring-forward
 * gap does not exist — the caller steps over it, exactly as core does.
 */
function instantOf(zone: string, year: number, month: number, day: number, minuteOfDay: number): Date {
  const naive = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let guess = new Date(naive - offsetMinutes(new Date(naive), zone) * 60_000);
  guess = new Date(naive - offsetMinutes(guess, zone) * 60_000);
  return guess;
}

function toMinutes(hm: string): number {
  const [hour = '0', minute = '0'] = hm.split(':');
  return Number(hour) * 60 + Number(minute);
}

function hhmm(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60) % 24;
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

type Verdict =
  | { kind: 'now'; local: string; localDay: string }
  | { kind: 'held'; local: string; localDay: string; releaseLocal: string; releaseDay: string; releaseInstant: Date }
  | { kind: 'exempt'; local: string; localDay: string }
  | { kind: 'impossible'; reason: string };

/**
 * The same decision `resolveSendTime` makes, for one zone.
 *
 * Kept structurally parallel to the domain function on purpose: window
 * intersection, then "is this instant inside it on a permitted day", then advance
 * to the next day's OPENING and walk forward to a permitted weekday.
 */
function decide(
  instant: Date,
  zone: string,
  window: { start: number; end: number } | null,
  sendDays: readonly number[],
  exempt: boolean,
): Verdict {
  const parts = partsIn(instant, zone);
  const local = `${hhmm(parts.hour * 60 + parts.minute)}`;
  const localDay = `${dayName(parts.weekday)} ${String(parts.day).padStart(2, '0')}`;

  if (exempt) return { kind: 'exempt', local, localDay };
  if (window === null) return { kind: 'impossible', reason: 'window unknown' };

  const minuteOfDay = parts.hour * 60 + parts.minute;
  const days = new Set(sendDays);
  if (days.size === 0) return { kind: 'impossible', reason: 'no permitted send day' };

  const inWindow = minuteOfDay >= window.start && minuteOfDay < window.end;
  if (inWindow && days.has(parts.weekday)) return { kind: 'now', local, localDay };

  // Too late, or not a permitted day: the next opening is tomorrow. Too early:
  // this morning's opening.
  let cursor = instantOf(zone, parts.year, parts.month, parts.day, window.start);
  if (minuteOfDay >= window.end || !days.has(parts.weekday)) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const shifted = partsIn(cursor, zone);
    cursor = instantOf(zone, shifted.year, shifted.month, shifted.day, window.start);
  }

  for (let hop = 0; hop < 8; hop++) {
    const at = partsIn(cursor, zone);
    if (days.has(at.weekday)) {
      return {
        kind: 'held',
        local,
        localDay,
        releaseLocal: hhmm(at.hour * 60 + at.minute),
        releaseDay: `${dayName(at.weekday)} ${String(at.day).padStart(2, '0')}`,
        releaseInstant: cursor,
      };
    }
    const next = new Date(cursor.getTime() + 86_400_000);
    const shifted = partsIn(next, zone);
    cursor = instantOf(zone, shifted.year, shifted.month, shifted.day, window.start);
  }
  return { kind: 'impossible', reason: 'no permitted day within a week' };
}

// ── the tab ──────────────────────────────────────────────────────────────────

export function ScheduleTab() {
  const { campaignId, campaign, reload } = useCampaign();
  const [start, setStart] = useState(campaign.sendWindowStart ?? '');
  const [end, setEnd] = useState(campaign.sendWindowEnd ?? '');
  const [days, setDays] = useState<readonly number[]>(campaign.sendDays);
  const [when, setWhen] = useState<string>(() => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/campaigns/${campaignId}`, body),
    onSuccess: reload,
  });

  const exempt = campaign.category === 'transactional' || campaign.category === 'operational';
  const startValid = start === '' || TIME.test(start);
  const endValid = end === '' || TIME.test(end);
  const inverted =
    startValid && endValid && start !== '' && end !== '' && toMinutes(start) >= toMinutes(end);

  const dirty =
    start !== (campaign.sendWindowStart ?? '') ||
    end !== (campaign.sendWindowEnd ?? '') ||
    JSON.stringify([...days].sort((a, b) => a - b)) !==
      JSON.stringify([...campaign.sendDays].sort((a, b) => a - b));

  /**
   * The effective window CANNOT be computed here, and that is the honest answer.
   *
   * `effectiveWindow()` is `max(floorStart, windowStart) … min(floorEnd, windowEnd)`
   * — it needs the tenant's `quiet_hours_start`/`quiet_hours_end`, and no endpoint
   * in this API returns them. Rather than substituting the schema default (08:00–
   * 21:00) and drawing a strip that would be silently wrong for any tenant that
   * changed it, the preview runs on the campaign's own window and says loudly that
   * the floor may narrow it further.
   */
  const previewWindow =
    startValid && endValid && start !== '' && end !== '' && !inverted
      ? { start: toMinutes(start), end: toMinutes(end) }
      : null;

  const instant = new Date(when);
  const instantValid = !Number.isNaN(instant.getTime());

  return (
    <div className="space-y-3 p-3">
      <div className="grid gap-3 lg:grid-cols-[400px_1fr]">
        <section className="panel h-fit">
          <div className="panel-head">
            <span className="panel-title">Campaign window</span>
            {save.isPending && <span className="text-[11px] text-ink-faint">saving…</span>}
          </div>

          <div className="space-y-3 p-4">
            <p className="text-[12px] leading-relaxed text-ink-dim">
              These times are <b className="text-ink">recipient-local</b>. They are not the operator&rsquo;s
              times, and they are not the server&rsquo;s — a server running UTC makes the two look
              identical for roughly one sixth of the world.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="window-start">Opens</label>
                <input
                  id="window-start"
                  className={clsx('input font-mono', !startValid && 'border-bad')}
                  placeholder="09:00"
                  value={start}
                  onChange={(event) => { setStart(event.target.value); }}
                />
              </div>
              <div>
                <label className="label" htmlFor="window-end">Closes</label>
                <input
                  id="window-end"
                  className={clsx('input font-mono', !endValid && 'border-bad')}
                  placeholder="18:00"
                  value={end}
                  onChange={(event) => { setEnd(event.target.value); }}
                />
              </div>
            </div>
            {(!startValid || !endValid) && (
              <p className="text-[12px] text-bad">
                Both fields are <code className="font-mono">HH:mm</code> on a 24-hour clock. The API
                rejects anything else rather than guessing.
              </p>
            )}
            {inverted && (
              <p className="text-[12px] text-bad">
                Opens is not before closes, so this window can never be satisfied.
              </p>
            )}
            <p className="text-[11px] leading-relaxed text-ink-faint">
              Leave both empty to inherit the tenant floor unchanged. The two fields are written
              together — the API treats them as one edit.
            </p>

            <div>
              <span className="label">Send days</span>
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4, 5, 6].map((day) => {
                  const on = days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      className={clsx(
                        'flex-1 rounded border px-1 py-1 text-[11px] transition-colors',
                        on
                          ? 'border-accent-dim bg-accent-wash text-accent'
                          : 'border-line text-ink-faint hover:border-line-strong hover:text-ink',
                      )}
                      onClick={() => {
                        setDays(on ? days.filter((entry) => entry !== day) : [...days, day]);
                      }}
                    >
                      {dayName(day)}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-ink-faint">
                {days.length === 0
                  ? 'No permitted day: nothing could ever be sent, and the scheduler refuses this rather than looping.'
                  : sendDaysLabel(days)}
              </p>
            </div>

            {save.isError && <ErrorState error={save.error} title="The window was not saved" />}

            <button
              type="button"
              className="btn btn-primary w-full justify-center"
              disabled={
                !dirty || save.isPending || !startValid || !endValid || inverted || days.length === 0
              }
              onClick={() => {
                save.mutate({
                  sendWindowStart: start === '' ? null : start,
                  sendWindowEnd: end === '' ? null : end,
                  sendDays: [...days].sort((a, b) => a - b),
                });
              }}
            >
              {save.isPending ? 'Saving…' : dirty ? 'Save window' : 'Saved'}
            </button>
          </div>
        </section>

        <div className="space-y-3">
          <section className="panel">
            <div className="panel-head">
              <span className="panel-title">Narrowing, not widening</span>
              <Pill tone="info">I5</Pill>
            </div>
            <div className="p-4">
              <div className="flex flex-wrap items-center gap-3 font-mono text-[12px]">
                <span className="rounded border border-line-strong bg-ground px-2 py-1 text-ink-faint">
                  tenant floor {DASH} … {DASH}
                </span>
                <span className="text-ink-faint">∩</span>
                <span className="rounded border border-accent-dim bg-accent-wash px-2 py-1 text-accent">
                  campaign {start === '' ? DASH : start} … {end === '' ? DASH : end}
                </span>
                <span className="text-ink-faint">=</span>
                <span className="rounded border border-line-strong bg-ground px-2 py-1 text-ink-dim">
                  max(start) … min(end)
                </span>
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-ink-dim">
                The intersection takes the <b className="text-ink">later</b> opening and the{' '}
                <b className="text-ink">earlier</b> closing, which is what makes narrowing the only
                direction available. A campaign asking for 06:00 under a 08:00 floor gets 08:00; it
                cannot opt itself into 3am.
              </p>
              <UnavailableState
                what="The tenant floor is not on screen because no endpoint returns it"
                because={
                  <>
                    <code className="font-mono text-ink-dim">tenants.quiet_hours_start</code> /{' '}
                    <code className="font-mono text-ink-dim">quiet_hours_end</code> exist in the
                    schema and are read by the scheduler, but nothing in this API exposes them — see{' '}
                    <code className="font-mono text-ink-dim">GET /auth/me</code>, which returns the
                    user and no tenant settings. The strip below therefore previews the{' '}
                    <b>campaign</b> window only. The floor can narrow it further, never widen it, so
                    every &ldquo;held&rdquo; row below is still held and some &ldquo;sends now&rdquo;
                    rows may not be.
                  </>
                }
              />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <span className="panel-title">Exemption</span>
              <Pill tone={exempt ? 'held' : 'quiet'}>{campaign.category}</Pill>
            </div>
            <p className="px-4 py-3 text-[12px] leading-relaxed text-ink-dim">
              {exempt ? (
                <>
                  This campaign is <b className="text-held">exempt</b> from quiet hours. The
                  exemption is keyed on the campaign category, which is a closed set enforced by a
                  database constraint — so a campaign cannot quietly grant itself the exemption,
                  because changing the category also changes how consent is handled. A
                  &ldquo;your order is out for delivery&rdquo; SMS at 21:30 is wanted; a promotional
                  one at the same time is not.
                </>
              ) : (
                <>
                  Quiet hours apply to every message this campaign sends. Only{' '}
                  <code className="font-mono">transactional</code> and{' '}
                  <code className="font-mono">operational</code> categories are exempt, and moving a
                  campaign into one of those changes its consent handling too.
                </>
              )}
            </p>
          </section>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Timezone preview</span>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-ink-faint" htmlFor="preview-at">
              a message becomes ready at
            </label>
            <input
              id="preview-at"
              type="datetime-local"
              className="input w-56"
              value={when}
              onChange={(event) => { setWhen(event.target.value); }}
            />
          </div>
        </div>

        {!instantValid ? (
          <p className="px-4 py-3 text-[12px] text-bad">
            That is not a valid date and time, so there is nothing to preview.
          </p>
        ) : (
          <>
            <p className="border-b border-line px-4 py-2 text-[12px] leading-relaxed text-ink-dim">
              Read in your own zone that is{' '}
              <span className="font-mono text-ink">
                {instant.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
              . Below is what each of six contacts sees — same instant, six different answers.
            </p>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="th">Contact&rsquo;s zone</th>
                  <th className="th">Their local time</th>
                  <th className="th">Verdict</th>
                  <th className="th">They receive it</th>
                </tr>
              </thead>
              <tbody>
                {ZONES.map((zone) => {
                  const verdict = decide(instant, zone.id, previewWindow, days, exempt);
                  return (
                    <tr key={zone.id} className="border-b border-line/60">
                      <td className="cell">
                        <Tooltip
                          align="left"
                          content={
                            <>
                              <div className="mb-1 font-semibold text-ink">{zone.id}</div>
                              <div className="text-ink-dim">{zone.why}</div>
                            </>
                          }
                        >
                          <span className="text-[12px] text-ink underline decoration-line-strong decoration-dotted underline-offset-4">
                            {zone.label}
                          </span>
                        </Tooltip>
                        <div className="font-mono text-[10px] text-ink-faint">{zone.id}</div>
                      </td>
                      <td className="cell num">
                        {verdict.kind === 'impossible' ? (
                          <span className="text-ink-faint">{DASH}</span>
                        ) : (
                          <>
                            <span className="text-ink">{verdict.local}</span>{' '}
                            <span className="text-ink-faint">{verdict.localDay}</span>
                          </>
                        )}
                      </td>
                      <td className="cell">
                        {verdict.kind === 'now' && <Pill tone="ok">sends immediately</Pill>}
                        {verdict.kind === 'held' && <Pill tone="held">held for quiet hours</Pill>}
                        {verdict.kind === 'exempt' && <Pill tone="info">category exempt</Pill>}
                        {verdict.kind === 'impossible' && <Pill tone="quiet">not computable</Pill>}
                      </td>
                      <td className="cell text-[12px]">
                        {verdict.kind === 'now' && (
                          <span className="text-ink-dim">
                            at <span className="num text-ink">{verdict.local}</span> their time
                          </span>
                        )}
                        {verdict.kind === 'exempt' && (
                          <span className="text-ink-dim">
                            at <span className="num text-ink">{verdict.local}</span> their time —
                            quiet hours are not evaluated for this category
                          </span>
                        )}
                        {verdict.kind === 'held' && (
                          <span className="text-ink-dim">
                            <span className="num text-held">
                              {verdict.releaseLocal} {verdict.releaseDay}
                            </span>{' '}
                            their time
                            <span className="ml-2 text-[11px] text-ink-faint">
                              (
                              {verdict.releaseInstant.toLocaleString(undefined, {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              })}{' '}
                              yours)
                            </span>
                          </span>
                        )}
                        {verdict.kind === 'impossible' && (
                          <span className="text-ink-faint">
                            {DASH} — {verdict.reason}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="border-t border-line px-4 py-2.5 text-[11px] leading-relaxed text-ink-faint">
              A preview, not the decision. The send path re-evaluates this at send time against the
              recipient&rsquo;s stored timezone (falling back to the tenant default), because a
              schedule computed at enqueue is already stale when a worker picks the row up. A
              deferral is also not a failed attempt — it does not consume a delivery attempt, which
              is why the queue shows <code className="font-mono">deferrals</code> and{' '}
              <code className="font-mono">attempts</code> as two separate numbers.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
