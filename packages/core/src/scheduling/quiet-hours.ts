import { DateTime } from 'luxon';
import type { CampaignCategory } from '@campaign/shared';

/**
 * Recipient-local quiet hours  (I5).
 *
 * The bug this prevents is a message delivered at 02:03 local time, and the reason
 * it happens is almost never "nobody thought about timezones". It is that the
 * timezone used was the SERVER's, and on a server running UTC that looks correct
 * for roughly one sixth of the world.
 *
 * Three rules hold here, and each has a test:
 *
 *  1. The zone is the RECIPIENT's, falling back to the tenant default, and never to
 *     the server. There is no `DateTime.local()` in this file for that reason.
 *  2. The tenant window is a HARD FLOOR. Campaign configuration may narrow it and
 *     can never widen it, so a campaign cannot opt itself into 3am.
 *  3. All arithmetic goes through Luxon's zone-aware types, never through manual
 *     offset maths. Adding `offsetHours * 3600000` is correct until the day the
 *     offset changes underneath you, twice a year, in only some countries.
 */

export type QuietHoursConfig = {
  /** Tenant hard floor, 'HH:mm'. */
  readonly floorStart: string;
  readonly floorEnd: string;
  /** Campaign narrowing, 'HH:mm'. Null means "do not narrow". */
  readonly windowStart?: string | null;
  readonly windowEnd?: string | null;
  /** JS weekday numbers, 0 = Sunday. */
  readonly sendDays: readonly number[];
};

export type ScheduleInput = {
  readonly target: Date;
  readonly timezone: string | null | undefined;
  readonly tenantTimezone: string;
  readonly config: QuietHoursConfig;
};

export type ScheduleDecision =
  | { readonly eligible: true; readonly at: Date }
  | { readonly eligible: false; readonly nextEligibleAt: Date; readonly reason: 'quiet_hours' };

/**
 * Transactional and operational messages are exempt from quiet hours.
 *
 * The build spec contained a genuine contradiction here: it declared the floor
 * un-widenable, and separately required a shipping-notification campaign that sends
 * at any hour. Both cannot be true, so this is the resolution, recorded in
 * docs/DECISIONS.md:
 *
 *   The exemption is keyed on the campaign CATEGORY, which is a closed set enforced
 *   by a database CHECK constraint. It is a named predicate rather than a boolean
 *   column, so a campaign cannot quietly grant itself the exemption — an operator
 *   would have to change the category, which changes consent handling too.
 *
 * A "your order is out for delivery" SMS at 21:30 is expected and wanted. A
 * promotional message at the same time is not. The distinction is real, it is the
 * one CAN-SPAM and TCPA also draw, and it belongs in the type system.
 */
export function isQuietHoursExempt(category: CampaignCategory): boolean {
  return category === 'transactional' || category === 'operational';
}

function parseHm(hm: string): { hour: number; minute: number } {
  const parts = hm.split(':');
  const hour = Number(parts[0]);
  const minute = Number(parts[1] ?? '0');
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute)) {
    throw new Error(`Invalid time-of-day '${hm}'; expected HH:mm.`);
  }
  return { hour, minute };
}

/** Minutes since local midnight, used to compare a wall time against a window. */
function minutesOfDay(dt: DateTime): number {
  return dt.hour * 60 + dt.minute;
}

function toMinutes(hm: string): number {
  const { hour, minute } = parseHm(hm);
  return hour * 60 + minute;
}

/**
 * The effective window: the tenant floor, narrowed by campaign configuration.
 * `max` on the start and `min` on the end is what makes narrowing the only
 * possible direction.
 */
export function effectiveWindow(config: QuietHoursConfig): { start: number; end: number } {
  const floorStart = toMinutes(config.floorStart);
  const floorEnd = toMinutes(config.floorEnd);
  const start = config.windowStart
    ? Math.max(floorStart, toMinutes(config.windowStart))
    : floorStart;
  const end = config.windowEnd ? Math.min(floorEnd, toMinutes(config.windowEnd)) : floorEnd;

  if (start >= end) {
    // Reachable only if a campaign window sits entirely outside the tenant floor.
    // A CHECK constraint rejects an inverted campaign window at write time, and this
    // throws rather than returning an unsatisfiable window that would make the
    // day-advancing loop below spin forever looking for a slot that cannot exist.
    throw new Error(
      `Campaign send window does not intersect the tenant quiet-hours floor ` +
        `(${config.floorStart}-${config.floorEnd} narrowed to an empty range). ` +
        `Widen the campaign window or the tenant floor.`,
    );
  }
  return { start, end };
}

/** Luxon weekday is 1=Mon..7=Sun; the product uses the JS convention 0=Sun. */
function jsWeekday(dt: DateTime): number {
  return dt.weekday % 7;
}

/** Luxon declares `isValid` as a plain boolean rather than a type predicate, so a
 *  bare `if (dt.isValid)` does not narrow DateTime<boolean> to DateTime<true>.
 *  This guard does the narrowing once, honestly, instead of casting at each site. */
function isValidDateTime(dt: DateTime): dt is DateTime<true> {
  return dt.isValid;
}

/**
 * Set a wall-clock time on a zoned date.
 *
 * An earlier version of this function was built on a premise that is false:
 * "Luxon reports non-existent times as invalid". It does not. `DateTime.set()`
 * into a spring-forward gap returns a VALID DateTime, silently shifted forward by
 * the size of the gap. The validity guard therefore never fired, the 180-iteration
 * fallback loop behind it was unreachable, and the shifted instant was returned
 * unchecked.
 *
 * So a caller CANNOT assume it got the minute it asked for. What it gets is a real
 * instant; `minutesOfDay` on the result is the only honest way to learn where that
 * instant actually landed. `windowOpeningOn` is the caller that checks.
 */
function atLocalMinute(day: DateTime<true>, minuteOfDay: number): DateTime<true> {
  const candidate = day.set({
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
    millisecond: 0,
  });
  if (!isValidDateTime(candidate)) {
    // Not reachable for a DST gap. Only a corrupt zone gets here, and resolveSendTime
    // has already rejected those — kept as an assertion rather than a silent cast.
    throw new Error(`Could not set local minute ${minuteOfDay} in ${day.zoneName}`);
  }
  return candidate;
}

/**
 * The instant this window opens on this date, or `null` if it does not open at all.
 *
 * A spring-forward gap can push the opening minute past the window's own CLOSE, and
 * then the window does not exist on that date:
 *
 *   - New York, 8 Mar 2026: an 02:00-02:30 window opens at 03:00.
 *   - Lord Howe, 4 Oct 2026: the shift is THIRTY minutes, so an 02:00-02:15 window
 *     opens at 02:30.
 *   - Santiago and Cairo transition AT midnight, so a 00:00 tenant floor opens at
 *     01:00 — past a floor that closes at 00:45.
 *
 * Returning the shifted instant regardless is how `resolveSendTime` came to hand
 * back a send time outside the quiet-hours window it had just computed, and
 * `scheduleWithin` came to write that instant into `scheduled_at`. Quiet hours are
 * the one gate whose entire purpose is that the recipient's local clock is
 * respected (I5); a gate that reports compliance while violating it is worse than
 * no gate.
 */
function windowOpeningOn(day: DateTime<true>, start: number, end: number): DateTime<true> | null {
  const at = atLocalMinute(day, start);
  const landed = minutesOfDay(at);
  return landed >= start && landed < end ? at : null;
}

/**
 * Decide when `target` may actually be sent, in the recipient's local time.
 *
 * Returns `eligible: true` when the target instant already sits inside the window
 * on a permitted day, and otherwise the next instant that does — which the caller
 * uses either to schedule (at enqueue time) or to defer (at send time). Both call
 * sites use this same function, because a schedule-time decision is stale by the
 * time the worker picks the row up, and I1 requires the gate to run again.
 */
export function resolveSendTime(input: ScheduleInput): ScheduleDecision {
  const zone = input.timezone ?? input.tenantTimezone;
  const { start, end } = effectiveWindow(input.config);

  const sendDays = new Set(input.config.sendDays);
  if (sendDays.size === 0) {
    throw new Error('Campaign has no permitted send days; nothing could ever be sent.');
  }

  const parsed = DateTime.fromJSDate(input.target, { zone });
  if (!isValidDateTime(parsed)) {
    throw new Error(`Unknown IANA timezone '${zone}' (${parsed.invalidReason}).`);
  }
  let local: DateTime<true> = parsed;

  const startsInWindow = minutesOfDay(local) >= start && minutesOfDay(local) < end;
  const startsOnSendDay = sendDays.has(jsWeekday(local));
  if (startsInWindow && startsOnSendDay) {
    return { eligible: true, at: local.toJSDate() };
  }

  // Too late in the day (or not a permitted day) — start looking tomorrow. Too
  // early — today's window may still open.
  let day: DateTime<true> =
    minutesOfDay(local) >= end || !startsOnSendDay
      ? local.plus({ days: 1 }).startOf('day')
      : local.startOf('day');

  // Advance to the next date that is BOTH a permitted send day AND one where the
  // window actually opens. The second condition is not a formality: on a DST
  // spring-forward date the opening minute can be swallowed by the gap and land
  // past the window's close, and that date has no slot at all.
  //
  // Bounded at 14 rather than 8: a non-empty send_days set guarantees a permitted
  // weekday within 7, and a transition can cost one of them. An unbounded `while`
  // here would be an infinite loop on a configuration mistake.
  for (let i = 0; i < 14; i++) {
    if (sendDays.has(jsWeekday(day))) {
      const opening = windowOpeningOn(day, start, end);
      if (opening) {
        return { eligible: false, nextEligibleAt: opening.toJSDate(), reason: 'quiet_hours' };
      }
    }
    day = day.plus({ days: 1 }).startOf('day');
  }
  throw new Error(
    'No permitted send day with a reachable window within a fortnight; ' +
      'send_days or the quiet-hours window is inconsistent.',
  );
}

/** Convenience for the enqueue path: the instant to store in `scheduled_at`. */
export function scheduleWithin(input: ScheduleInput): Date {
  const decision = resolveSendTime(input);
  return decision.eligible ? decision.at : decision.nextEligibleAt;
}
