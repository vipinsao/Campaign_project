/**
 * I5 — Quiet hours are computed in the RECIPIENT's timezone, and the tenant floor
 *      cannot be widened by campaign configuration.
 *
 * Failure it prevents: messages delivered at 02:03 local time.
 *
 * The interesting part of this test is not that it checks one timezone. It is the
 * matrix: eight zones including both DST transitions, the extreme offsets at either
 * end of the day line, and a contact with no timezone at all. A quiet-hours
 * implementation that uses the server clock passes a single-timezone test on a UTC
 * CI runner and fails every row below.
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { resolveSendTime, effectiveWindow, isQuietHoursExempt } from '@campaign/core';
import type { QuietHoursConfig } from '@campaign/core';

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const FLOOR: QuietHoursConfig = {
  floorStart: '08:00',
  floorEnd: '21:00',
  sendDays: ALL_DAYS,
};

/** Every zone the matrix covers, and why it earns its place. */
const ZONES = [
  { zone: 'UTC', why: 'the server zone — must not be special' },
  { zone: 'America/New_York', why: 'US DST, UTC-5/-4' },
  { zone: 'America/Los_Angeles', why: 'US DST, three hours from New York' },
  { zone: 'Europe/London', why: 'DST transitions on a different date to the US' },
  { zone: 'Asia/Kolkata', why: 'a half-hour offset (UTC+5:30) — integer-offset maths fails here' },
  { zone: 'Australia/Adelaide', why: 'half-hour offset AND southern-hemisphere DST' },
  { zone: 'Pacific/Kiritimati', why: 'UTC+14, the far side of the date line' },
  { zone: 'Pacific/Niue', why: 'UTC-11, the other far side' },
  { zone: 'Asia/Tokyo', why: 'no DST at all — the control' },
] as const;

/** Instants chosen to land on both DST transitions in both hemispheres. */
const INSTANTS = [
  { at: '2026-01-15T03:00:00Z', why: 'ordinary winter night (northern)' },
  { at: '2026-03-08T06:30:00Z', why: 'US spring-forward day' },
  { at: '2026-03-29T01:00:00Z', why: 'EU spring-forward day' },
  { at: '2026-04-05T16:00:00Z', why: 'Australian fall-back day' },
  { at: '2026-06-21T12:00:00Z', why: 'midsummer midday' },
  { at: '2026-10-04T15:00:00Z', why: 'Australian spring-forward day' },
  { at: '2026-11-01T05:30:00Z', why: 'US fall-back day, inside the repeated hour' },
  { at: '2026-12-31T23:45:00Z', why: 'year boundary across the date line' },
] as const;

describe('I5 — quiet hours are recipient-local', () => {
  it('never schedules an instant outside the local window, across the full matrix', () => {
    const violations: string[] = [];

    for (const { zone } of ZONES) {
      for (const { at } of INSTANTS) {
        const decision = resolveSendTime({
          target: new Date(at),
          timezone: zone,
          tenantTimezone: 'UTC',
          config: FLOOR,
        });

        const instant = decision.eligible ? decision.at : decision.nextEligibleAt;
        const local = DateTime.fromJSDate(instant, { zone });

        expect(local.isValid, `${zone} @ ${at} produced an invalid local time`).toBe(true);

        const minutes = local.hour * 60 + local.minute;
        if (minutes < 8 * 60 || minutes >= 21 * 60) {
          violations.push(
            `${zone} @ ${at} -> ${local.toISO() ?? 'invalid'} (local ${local.toFormat('HH:mm')})`,
          );
        }
      }
    }

    expect(violations, `scheduled outside 08:00-21:00 local:\n${violations.join('\n')}`).toEqual(
      [],
    );
  });

  it('falls back to the tenant timezone when the contact has none — never to the server', () => {
    // 03:00 UTC is inside business hours in Tokyo (12:00) and the middle of the
    // night in New York (22:00 the previous day). A server-clock implementation
    // returns the same answer for both, which is how you tell the two apart.
    const target = new Date('2026-05-14T03:00:00Z');

    const tokyo = resolveSendTime({
      target,
      timezone: null,
      tenantTimezone: 'Asia/Tokyo',
      config: FLOOR,
    });
    expect(tokyo.eligible).toBe(true);

    const newYork = resolveSendTime({
      target,
      timezone: null,
      tenantTimezone: 'America/New_York',
      config: FLOOR,
    });
    expect(newYork.eligible).toBe(false);
  });

  it('lets the contact timezone override the tenant default', () => {
    const target = new Date('2026-05-14T03:00:00Z');
    const decision = resolveSendTime({
      target,
      timezone: 'Asia/Tokyo',
      tenantTimezone: 'America/New_York',
      config: FLOOR,
    });
    expect(decision.eligible).toBe(true);
  });

  it('defers to the NEXT day when the target is past the local window close', () => {
    // 23:00 in Kolkata on the 14th.
    const decision = resolveSendTime({
      target: new Date('2026-05-14T17:30:00Z'),
      timezone: 'Asia/Kolkata',
      tenantTimezone: 'UTC',
      config: FLOOR,
    });
    expect(decision.eligible).toBe(false);
    if (decision.eligible) return;
    const local = DateTime.fromJSDate(decision.nextEligibleAt, { zone: 'Asia/Kolkata' });
    expect(local.toFormat('HH:mm')).toBe('08:00');
    expect(local.day).toBe(15);
  });

  it('opens the window the SAME day when the target is before it', () => {
    // 05:00 in Kolkata — too early, but the same day's window has not opened yet.
    const decision = resolveSendTime({
      target: new Date('2026-05-13T23:30:00Z'),
      timezone: 'Asia/Kolkata',
      tenantTimezone: 'UTC',
      config: FLOOR,
    });
    expect(decision.eligible).toBe(false);
    if (decision.eligible) return;
    const local = DateTime.fromJSDate(decision.nextEligibleAt, { zone: 'Asia/Kolkata' });
    expect(local.toFormat('HH:mm')).toBe('08:00');
    expect(local.day).toBe(14);
  });

  it('skips a local weekday the campaign does not permit', () => {
    // Weekdays only. 2026-05-16 is a Saturday.
    const weekdaysOnly: QuietHoursConfig = { ...FLOOR, sendDays: [1, 2, 3, 4, 5] };
    const decision = resolveSendTime({
      target: new Date('2026-05-16T12:00:00Z'),
      timezone: 'UTC',
      tenantTimezone: 'UTC',
      config: weekdaysOnly,
    });
    expect(decision.eligible).toBe(false);
    if (decision.eligible) return;
    const local = DateTime.fromJSDate(decision.nextEligibleAt, { zone: 'UTC' });
    expect(local.weekday).toBe(1); // Monday
  });
});

describe('I5 — the tenant floor is a floor, not a suggestion', () => {
  it('lets a campaign NARROW the window', () => {
    const narrowed = effectiveWindow({ ...FLOOR, windowStart: '10:00', windowEnd: '17:00' });
    expect(narrowed).toEqual({ start: 600, end: 1020 });
  });

  it('refuses to let a campaign WIDEN the window in either direction', () => {
    // A campaign asking for 06:00-23:00 gets the tenant's 08:00-21:00, unchanged.
    const widened = effectiveWindow({ ...FLOOR, windowStart: '06:00', windowEnd: '23:00' });
    expect(widened).toEqual({ start: 8 * 60, end: 21 * 60 });
  });

  it('rejects a campaign window that does not intersect the floor at all', () => {
    // 22:00-23:00 clamps to start 22:00 / end 21:00 — an empty range. Throwing here
    // is deliberate: returning it would send the day-advancing loop looking for a
    // slot that cannot exist on any day.
    expect(() => effectiveWindow({ ...FLOOR, windowStart: '22:00', windowEnd: '23:00' })).toThrow(
      /does not intersect/i,
    );
  });
});

describe('I5 — the transactional carve-out is explicit', () => {
  it('exempts transactional and operational categories only', () => {
    expect(isQuietHoursExempt('transactional')).toBe(true);
    expect(isQuietHoursExempt('operational')).toBe(true);
    expect(isQuietHoursExempt('promotional')).toBe(false);
    expect(isQuietHoursExempt('lifecycle')).toBe(false);
  });
});
