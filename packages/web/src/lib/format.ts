/**
 * Formatting, and one rule: this module never invents a value.
 *
 * `DASH` is exported rather than typed as a literal in twenty components so that
 * "we do not know this" has exactly one representation on screen, and so that
 * grepping for it finds every place the UI admits ignorance. Every function here
 * returns `DASH` for null/undefined rather than `0`, `''` or `'N/A'`.
 */
export const DASH = '—';

export function int(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toLocaleString();
}

export function money(amount: string | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return DASH;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return DASH;
  try {
    return numeric.toLocaleString(undefined, { style: 'currency', currency: currency ?? 'USD' });
  } catch {
    return `${amount} ${currency ?? ''}`.trim();
  }
}

export function timestamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function shortTimestamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function dayKey(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** "in 4h 12m" / "3d ago" / DASH. Never "just now" for something that has no time. */
export function relative(iso: string | null | undefined, now: number = Date.now()): string {
  if (iso === null || iso === undefined) return DASH;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return DASH;
  const deltaSeconds = Math.round((then - now) / 1000);
  const magnitude = Math.abs(deltaSeconds);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 3600],
    ['hour', 86400],
    ['day', 2592000],
    ['month', 31536000],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
  let previous = 1;
  for (const [unit, limit] of units) {
    if (magnitude < limit) return formatter.format(Math.round(deltaSeconds / previous), unit);
    previous = limit;
  }
  return formatter.format(Math.round(deltaSeconds / 31536000), 'year');
}

export function minutes(total: number | null | undefined): string {
  if (total === null || total === undefined) return DASH;
  if (total === 0) return 'immediately';
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  return [days > 0 ? `${String(days)}d` : '', hours > 0 ? `${String(hours)}h` : '', mins > 0 ? `${String(mins)}m` : '']
    .filter(Boolean)
    .join(' ');
}

export function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function initials(first: string | null, last: string | null, fallback: string): string {
  const letters = `${first?.[0] ?? ''}${last?.[0] ?? ''}`.trim();
  return letters.length > 0 ? letters.toUpperCase() : fallback.slice(0, 2).toUpperCase();
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function dayName(index: number): string {
  return DAY_NAMES[index] ?? String(index);
}

export function sendDaysLabel(days: readonly number[] | null | undefined): string {
  if (days === null || days === undefined || days.length === 0) return DASH;
  if (days.length === 7) return 'Every day';
  return [...days]
    .sort((a, b) => a - b)
    .map(dayName)
    .join(', ');
}
