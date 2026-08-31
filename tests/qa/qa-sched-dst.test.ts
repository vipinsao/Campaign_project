/**
 * QA — adversarial review of `atLocalMinute` / `resolveSendTime` DST handling
 * (hypotheses 7 and 9).
 *
 * `atLocalMinute` WAS built on a premise that is false:
 *
 *     "Luxon reports non-existent times as invalid; silently accepting the invalid
 *      value would produce an Invalid DateTime that serialises to null far away
 *      from here."
 *
 * Luxon does not do that. `DateTime.set()` into a spring-forward gap returns a
 * VALID DateTime, shifted forward by the size of the gap. The `isValidDateTime`
 * guard therefore never fired, the 180-iteration fallback loop behind it was dead
 * code, and the shifted value was returned unchecked — which is how
 * `resolveSendTime` came to hand back an instant sitting OUTSIDE the window it had
 * just computed, and `scheduleWithin` came to write that instant into
 * `scheduled_at`.
 *
 * The first two tests below pin Luxon's real behaviour, so that the premise cannot
 * quietly come back. The rest assert the fix: a date whose window opening is
 * swallowed by a gap has no slot, and the search moves to the next date that does.
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { resolveSendTime, effectiveWindow, scheduleWithin } from '@campaign/core';
import type { QuietHoursConfig } from '@campaign/core';

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function localMinutes(instant: Date, zone: string): number {
  const local = DateTime.fromJSDate(instant, { zone });
  return local.hour * 60 + local.minute;
}

function describeResult(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISO() ?? 'invalid';
}

describe('QA/sched — the premise `atLocalMinute` was built on (CHARACTERISATION)', () => {
  it('Luxon never returns an invalid DateTime for a spring-forward gap', () => {
    const gap = DateTime.fromISO('2026-03-08T00:00:00', { zone: 'America/New_York' }).set({
      hour: 2,
      minute: 30,
      second: 0,
      millisecond: 0,
    });
    // 02:30 does not exist on 2026-03-08 in New York. Luxon returns it as valid
    // anyway, shifted an hour forward — which is why the fallback loop that used to
    // sit behind an `isValid` check could never run.
    expect(gap.isValid, 'a validity check can never detect a DST gap').toBe(true);
    expect(gap.toFormat('HH:mm'), 'silently shifted past the gap').toBe('03:30');
  });

  it('the gap is silently absorbed, so the caller must check where it landed', () => {
    const shifted = DateTime.fromISO('2026-10-04T00:00:00', {
      zone: 'Australia/Lord_Howe',
    }).set({ hour: 2, minute: 0, second: 0, millisecond: 0 });
    // Lord Howe shifts by THIRTY minutes at 02:00 local, so 02:00-02:29 is a gap.
    // `windowOpeningOn` exists precisely because this returns 02:30, not 02:00.
    expect(shifted.isValid).toBe(true);
    expect(shifted.toFormat('HH:mm'), 'silently became 02:30').toBe('02:30');
  });
});

describe('QA/sched — resolveSendTime never returns an instant outside its window (FIXED)', () => {
  const cases: { zone: string; target: string; config: QuietHoursConfig; why: string }[] = [
    {
      zone: 'Australia/Lord_Howe',
      target: '2026-10-03T10:00:00Z',
      config: {
        floorStart: '00:00',
        floorEnd: '23:59',
        windowStart: '02:00',
        windowEnd: '02:15',
        sendDays: ALL_DAYS,
      },
      why: 'a 30-minute DST shift would land the opening at 02:30, past the 02:15 close',
    },
    {
      zone: 'America/New_York',
      target: '2026-03-07T20:00:00Z',
      config: {
        floorStart: '00:00',
        floorEnd: '23:59',
        windowStart: '02:00',
        windowEnd: '02:30',
        sendDays: ALL_DAYS,
      },
      why: 'US spring-forward would land the opening at 03:00, past the 02:30 close',
    },
    {
      zone: 'America/Santiago',
      target: '2026-09-05T12:00:00Z',
      config: { floorStart: '00:00', floorEnd: '01:00', sendDays: ALL_DAYS },
      why: 'Chile transitions AT midnight, so the TENANT FLOOR opening does not exist',
    },
    {
      zone: 'Africa/Cairo',
      target: '2026-04-23T12:00:00Z',
      config: { floorStart: '00:00', floorEnd: '00:45', sendDays: ALL_DAYS },
      why: 'Egypt transitions AT midnight, so the floor opening would be skipped to 01:00',
    },
  ];

  for (const { zone, target, config, why } of cases) {
    it(`${zone} — ${why}`, () => {
      const { start, end } = effectiveWindow(config);
      const decision = resolveSendTime({
        target: new Date(target),
        timezone: zone,
        tenantTimezone: 'UTC',
        config,
      });
      const instant = decision.eligible ? decision.at : decision.nextEligibleAt;
      const minutes = localMinutes(instant, zone);

      expect(
        minutes >= start && minutes < end,
        `resolveSendTime returned ${describeResult(instant, zone)} (local minute ${minutes}) ` +
          `for the window [${start}, ${end})`,
      ).toBe(true);
    });
  }

  it('scheduleWithin therefore writes a scheduled_at inside the tenant floor', () => {
    // This is the enqueue path. `scheduled_at` is what an operator reads off the
    // queue when asked "when is this going out?".
    const config: QuietHoursConfig = {
      floorStart: '00:00',
      floorEnd: '01:00',
      sendDays: ALL_DAYS,
    };
    const at = scheduleWithin({
      target: new Date('2026-09-05T12:00:00Z'),
      timezone: 'America/Santiago',
      tenantTimezone: 'UTC',
      config,
    });
    const minutes = localMinutes(at, 'America/Santiago');
    expect(
      minutes < 60,
      `queued for ${describeResult(at, 'America/Santiago')}, outside the 00:00-01:00 floor`,
    ).toBe(true);
  });
});

describe('QA/sched — zones the existing I5 matrix does not cover (SAFE)', () => {
  const EXTRA_ZONES = [
    'Australia/Lord_Howe', // 30-minute DST shift
    'America/Santiago', // transition at midnight
    'Asia/Tehran', // DST abolished in 2022 — a historical offset change
    'Africa/Cairo', // DST reintroduced in 2023, transition at midnight
    'Pacific/Apia', // skipped an entire calendar day in 2011
    'Asia/Kathmandu', // UTC+05:45
    'Australia/Eucla', // UTC+08:45
    'America/St_Johns', // UTC-03:30 with DST
  ];

  const INSTANTS = [
    '2026-01-15T03:00:00Z',
    '2026-03-08T06:30:00Z',
    '2026-03-29T01:00:00Z',
    '2026-04-19T21:00:00Z',
    '2026-09-05T03:00:00Z',
    '2026-10-04T15:00:00Z',
    '2026-11-01T05:30:00Z',
    '2026-12-31T23:45:00Z',
  ];

  it('holds an 08:00-21:00 floor across every extra zone and instant', () => {
    const config: QuietHoursConfig = {
      floorStart: '08:00',
      floorEnd: '21:00',
      sendDays: ALL_DAYS,
    };
    const violations: string[] = [];
    for (const zone of EXTRA_ZONES) {
      for (const at of INSTANTS) {
        const decision = resolveSendTime({
          target: new Date(at),
          timezone: zone,
          tenantTimezone: 'UTC',
          config,
        });
        const instant = decision.eligible ? decision.at : decision.nextEligibleAt;
        const minutes = localMinutes(instant, zone);
        if (minutes < 480 || minutes >= 1260) {
          violations.push(`${zone} @ ${at} -> ${describeResult(instant, zone)}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the historical Samoa date skip (30 Dec 2011 never existed) does not throw', () => {
    const decision = resolveSendTime({
      target: new Date('2011-12-28T12:00:00Z'),
      timezone: 'Pacific/Apia',
      tenantTimezone: 'UTC',
      config: { floorStart: '08:00', floorEnd: '21:00', sendDays: [5] },
    });
    const instant = decision.eligible ? decision.at : decision.nextEligibleAt;
    const local = DateTime.fromJSDate(instant, { zone: 'Pacific/Apia' });
    expect(local.weekday % 7, 'must land on a Friday').toBe(5);
  });
});

describe('QA/sched — the 8-iteration weekday loop (hypothesis 9, SAFE)', () => {
  it('never reaches its throw for any legal send_days set, across zones and instants', () => {
    // `campaigns_send_days_valid` guarantees a non-empty subset of 0..6, so every
    // one of the 127 legal configurations is exercised here.
    const subsets: number[][] = [];
    for (let mask = 1; mask < 128; mask++) {
      subsets.push(ALL_DAYS.filter((d) => (mask & (1 << d)) !== 0));
    }

    const zones = ['UTC', 'Pacific/Apia', 'Australia/Lord_Howe', 'America/Santiago', 'Africa/Cairo'];
    const instants = ['2011-12-28T12:00:00Z', '2026-03-08T06:30:00Z', '2026-10-04T15:00:00Z'];

    const failures: string[] = [];
    for (const sendDays of subsets) {
      for (const zone of zones) {
        for (const at of instants) {
          try {
            const decision = resolveSendTime({
              target: new Date(at),
              timezone: zone,
              tenantTimezone: 'UTC',
              config: { floorStart: '08:00', floorEnd: '21:00', sendDays },
            });
            const instant = decision.eligible ? decision.at : decision.nextEligibleAt;
            const weekday = DateTime.fromJSDate(instant, { zone }).weekday % 7;
            if (!sendDays.includes(weekday)) {
              failures.push(`[${sendDays.join(',')}] ${zone} @ ${at} -> weekday ${weekday}`);
            }
          } catch (error) {
            failures.push(
              `[${sendDays.join(',')}] ${zone} @ ${at} THREW: ${(error as Error).message}`,
            );
          }
        }
      }
    }
    expect(failures, failures.slice(0, 10).join('\n')).toEqual([]);
  });

  it('the empty send_days set throws rather than looping forever', () => {
    expect(() =>
      resolveSendTime({
        target: new Date('2026-06-15T12:00:00Z'),
        timezone: 'UTC',
        tenantTimezone: 'UTC',
        config: { floorStart: '08:00', floorEnd: '21:00', sendDays: [] },
      }),
    ).toThrow(/no permitted send days/i);
  });
});
