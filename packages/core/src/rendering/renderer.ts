import type { CampaignCategory, Channel } from '@campaign/shared';
import { isMarketingCategory } from '@campaign/shared';

/**
 * Template rendering and validation  (I7).
 *
 * Three rules, each of which exists because of a specific way messaging systems
 * embarrass their owners:
 *
 *  1. AN UNKNOWN MERGE FIELD IS AN ERROR AT SAVE TIME, never a silent empty string
 *     at send time. `Hi {{contact.frist_name}}` should be caught by the operator
 *     pressing Save, not by ten thousand recipients reading "Hi ,".
 *
 *  2. MERGE VALUES ARE HTML-ESCAPED BY DEFAULT. They are contact-supplied data. A
 *     customer whose surname is a script tag is a template injection waiting to
 *     happen, and the fact that the value came from your own database is exactly
 *     what makes people forget to escape it.
 *
 *  3. A MARKETING TEMPLATE WITHOUT A RESOLVABLE OPT-OUT CANNOT BE SAVED. Not a
 *     warning, an error. The failure being prevented is an unsubscribe link that
 *     points at a route which does not exist: every recipient reaches a blank
 *     page, for the entire life of the system, and nothing detects it because
 *     nobody internally ever clicks one.
 */

export type MergeContext = {
  contact: Record<string, string | number | null | undefined>;
  order?: Record<string, string | number | null | undefined> | undefined;
  unsubscribe_url?: string | undefined;
  preferences_url?: string | undefined;
};

export type ValidationIssue = { readonly field?: string; readonly message: string };

export type ValidationResult = {
  readonly errors: ValidationIssue[];
  readonly warnings: ValidationIssue[];
  readonly links: string[];
  readonly mergeFields: string[];
  readonly smsSegments?: number;
  readonly renderedLength?: number;
};

/** The complete set of merge fields. Anything else is a typo, and is rejected. */
export const MERGE_FIELDS = [
  'contact.first_name',
  'contact.last_name',
  'contact.email',
  'contact.phone',
  'contact.locale',
  'order.number',
  'order.total',
  'order.currency',
  'order.carrier',
  'order.tracking_number',
  'order.tracking_url',
  'order.placed_at',
  'order.delivered_at',
  'unsubscribe_url',
  'preferences_url',
] as const;

export type MergeField = (typeof MERGE_FIELDS)[number];

const TOKEN = /\{\{\{?\s*([a-zA-Z0-9_.]+)\s*\}?\}\}/g;
const RAW_TOKEN = /\{\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}\}/g;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function lookup(context: MergeContext, path: string): string | undefined {
  if (path === 'unsubscribe_url') return context.unsubscribe_url;
  if (path === 'preferences_url') return context.preferences_url;

  const [root, key] = path.split('.');
  if (!root || !key) return undefined;
  const bag = root === 'contact' ? context.contact : root === 'order' ? context.order : undefined;
  const value = bag?.[key];
  return value === null || value === undefined ? undefined : String(value);
}

export function extractMergeFields(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(TOKEN)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

export function extractLinks(source: string): string[] {
  const links = new Set<string>();
  for (const m of source.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    if (m[1]) links.add(m[1]);
  }
  for (const m of source.matchAll(/\bhttps?:\/\/[^\s<>"')]+/gi)) {
    if (m[0]) links.add(m[0]);
  }
  return [...links];
}

/**
 * GSM-7 versus UCS-2 segment counting, computed on the RENDERED length.
 *
 * Counting the raw template is how a "155 character" SMS bills as three segments:
 * the template is short, and a twenty-two character merge token becomes whatever
 * the longest real first name in the database happens to be. A single non-GSM
 * character — a curly apostrophe pasted from a word processor is the usual
 * culprit — switches the entire message to UCS-2 and halves the segment size.
 */
const GSM7_BASE =
  '@£$¥èéùìòÇ\nØø\rÅå' +
  'Δ_ΦΓΛΩΠΨΣΘΞÆæßÉ' +
  ' !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** These cost two septets each, because they are sent as an escape plus a code. */
const GSM7_EXTENDED = '^{}\\[~]|€';

export function smsSegments(text: string): {
  segments: number;
  encoding: 'GSM-7' | 'UCS-2';
  units: number;
} {
  const costs: number[] = [];
  let gsm = true;

  for (const char of text) {
    if (GSM7_BASE.includes(char)) costs.push(1);
    else if (GSM7_EXTENDED.includes(char)) costs.push(2);
    else {
      gsm = false;
      break;
    }
  }

  if (!gsm) {
    // UCS-2 counts UTF-16 code units, because that is what the carrier counts:
    // an emoji outside the BMP is two units, not one character.
    // Iterating by CODE POINT is precisely what is wanted here: a carrier bills
    // UCS-2 in UTF-16 units, so a code point above the BMP costs two. Iterating by
    // grapheme cluster would under-count exactly the emoji this branch prices.
    costs.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code-point iteration is intended
    for (const ch of [...text]) costs.push((ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1);
    return { encoding: 'UCS-2', units: total(costs), segments: packSegments(costs, 70, 67) };
  }

  return { encoding: 'GSM-7', units: total(costs), segments: packSegments(costs, 160, 153) };
}

const total = (costs: readonly number[]): number => costs.reduce((a, b) => a + b, 0);

/**
 * Pack characters into segments without ever splitting a two-unit character.
 *
 * A GSM-7 extended character is an escape plus a code, and a non-BMP code point is
 * a surrogate pair. Neither half can be sent in a different segment, so a two-unit
 * character that does not fit in the remainder of a segment moves whole into the
 * next one, leaving a septet or a unit unused behind it.
 *
 * `Math.ceil(units / perSegment)` misses exactly this. 153 euro signs are 306
 * septets, which divides evenly into two 153-septet segments - but only 76 of them
 * fit in each, so the carrier sends three parts and bills for three. The same
 * arithmetic under-counts emoji by a segment at every multiple of 33.
 */
function packSegments(costs: readonly number[], single: number, multi: number): number {
  if (total(costs) <= single) return 1;
  let segments = 1;
  let used = 0;
  for (const cost of costs) {
    if (used + cost > multi) {
      segments += 1;
      used = 0;
    }
    used += cost;
  }
  return segments;
}

/**
 * A merge value, with NUL stripped.
 *
 * NUL is never legitimate message content, and it is the one byte that can collide
 * with the raw-block sentinel used by `render` below. Without this, a contact whose
 * first name was set to that sentinel took over a raw slot: the escaped pass wrote
 * it into the greeting, and the substitution loop then moved the unsubscribe URL
 * out of the href it was minted for and into the attacker's chosen position,
 * leaving the anchor pointing at a bare control character.
 */
function mergeValue(context: MergeContext, path: string): string {
  return (lookup(context, path) ?? '').replace(/\0/g, '');
}

export function render(template: string, context: MergeContext, opts: { escape: boolean }): string {
  // Raw blocks are extracted first so the escaping pass below cannot double-handle
  // them, and are substituted back afterwards.
  const raws = new Map<string, string>();
  let output = template.replace(RAW_TOKEN, (_m, path: string) => {
    const token = `\0RAW${raws.size}\0`;
    raws.set(token, mergeValue(context, path));
    return token;
  });

  output = output.replace(TOKEN, (_m, path: string) => {
    const value = mergeValue(context, path);
    return opts.escape ? escapeHtml(value) : value;
  });

  // A FUNCTION replacement, not a string one. `String.prototype.replace` reads
  // `$&`, `$'`, a backtick-dollar and `$$` out of a STRING replacement, so a
  // contact whose surname was `O$'Brien` appended the rest of the message body to
  // itself, and a price of `$$100` silently rendered as `$100`. A merge value is
  // data; the one place it must never be interpreted is on its way into a message.
  for (const [token, value] of raws) output = output.replace(token, () => value);
  return output;
}

/**
 * Validate at SAVE time.
 *
 * The whole point is that this runs when the operator presses Save, with a message
 * naming the offending field, rather than at send time when the only available
 * response is to fail the message.
 */
export function validateTemplate(
  template: {
    readonly channel: Channel;
    readonly subject?: string | null;
    readonly body: string;
    readonly html?: string | null;
  },
  category: CampaignCategory,
  opts: { readonly longestMergeValues?: Record<string, string> } = {},
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const sources = [template.subject ?? '', template.body, template.html ?? ''].join('\n');
  const fields = extractMergeFields(sources);

  for (const field of fields) {
    if (!(MERGE_FIELDS as readonly string[]).includes(field)) {
      errors.push({
        field,
        message:
          `Unknown merge field '${field}'. An unknown field renders as an empty ` +
          `string at send time, so it is rejected here instead. Known fields: ` +
          `${MERGE_FIELDS.join(', ')}.`,
      });
    }
  }

  // I7 — an error, never a warning.
  if (isMarketingCategory(category)) {
    const hasOptOut = fields.includes('unsubscribe_url') || fields.includes('preferences_url');
    if (!hasOptOut) {
      errors.push({
        message:
          `A '${category}' message must contain an unsubscribe_url or ` +
          `preferences_url merge field. Marketing mail without a working opt-out ` +
          `is not sendable.`,
      });
    }
  }

  if (template.channel === 'email' && !template.subject?.trim()) {
    errors.push({ field: 'subject', message: 'An email needs a subject line.' });
  }

  if (template.channel === 'sms') {
    if (template.html) warnings.push({ message: 'HTML is ignored on the SMS channel.' });

    // Segment count on the RENDERED length, with the longest realistic values.
    const worstCase = render(
      template.body,
      {
        contact: {
          first_name: opts.longestMergeValues?.['first_name'] ?? 'Konstantinos',
          last_name: opts.longestMergeValues?.['last_name'] ?? 'Papadopoulos',
        },
        order: { number: opts.longestMergeValues?.['order_number'] ?? 'ORD-000000000' },
        // A shortened link, because that is what actually goes out.
        unsubscribe_url: 'https://example.com/u/aaaaaaaaaaaa',
        preferences_url: 'https://example.com/u/aaaaaaaaaaaa',
      },
      { escape: false },
    );

    const { segments, encoding, units } = smsSegments(worstCase);
    if (segments > 1) {
      warnings.push({
        message:
          `With realistic merge values this renders to ${units} ${encoding} units ` +
          `and bills as ${segments} segments.`,
      });
    }

    return {
      errors,
      warnings,
      links: extractLinks(template.body),
      mergeFields: fields,
      smsSegments: segments,
      renderedLength: units,
    };
  }

  const links = extractLinks(`${template.body}\n${template.html ?? ''}`);
  return { errors, warnings, links, mergeFields: fields };
}

/**
 * Rewrite links for click tracking.
 *
 * The exclusion list is the interesting part. Rewriting a mailto: breaks reply
 * flows, rewriting a tel: breaks click-to-call, rewriting an in-page anchor breaks
 * nothing visibly but pollutes the click data, and rewriting THE UNSUBSCRIBE LINK
 * routes a legally required opt-out through a tracking redirect — which some
 * mailbox providers treat as a dark pattern, and which breaks one-click
 * List-Unsubscribe outright.
 */
export function rewriteLinks(
  html: string,
  makeTrackedUrl: (targetUrl: string) => string,
): { html: string; rewritten: string[] } {
  const rewritten: string[] = [];
  const output = html.replace(/href\s*=\s*["']([^"']+)["']/gi, (whole, url: string) => {
    if (!shouldRewrite(url)) return whole;
    rewritten.push(url);
    return `href="${makeTrackedUrl(url)}"`;
  });
  return { html: output, rewritten };
}

/**
 * Route names that are unambiguously an opt-out surface wherever they appear in a
 * path. These need no token-shape check: nothing legitimate in a marketing email
 * links to `/unsubscribe/...` and means "please track this click".
 */
const OPT_OUT_SEGMENTS = new Set([
  'unsubscribe',
  'unsub',
  'optout',
  'opt-out',
  'preferences',
  'preference-centre',
  'preference-center',
]);

/**
 * Does this path segment look like a token this system minted, rather than a word?
 *
 * `mintUnsubscribeToken()` emits 32 random bytes as base64url — 43 characters over
 * [A-Za-z0-9_-], which in practice always mixes character classes. A route
 * segment that is one unbroken run of letters is a page name (`/u/dashboard`),
 * not a token, and the difference decides whether a real marketing link keeps its
 * click tracking.
 */
function looksMinted(segment: string): boolean {
  if (segment.length < 8) return false;
  const classes =
    Number(/[a-z]/.test(segment)) +
    Number(/[A-Z]/.test(segment)) +
    Number(/[0-9]/.test(segment)) +
    Number(/[-_]/.test(segment));
  return classes >= 2;
}

/**
 * `strict` distinguishes the two directions this is asked in.
 *
 * For the URL's own path we require the token to look minted, because `/u/` is a
 * two-character route that collides with ordinary words (`/u/2`, `/u/dashboard`)
 * and a false positive here silently strips a real link out of click tracking —
 * and, through `hasClickableLink`, out of the click-rate denominator (I12).
 *
 * For a URL found nested inside a query string or fragment we do not: an absolute
 * URL sitting in a redirector parameter that points anywhere near an opt-out
 * route is refused outright. That direction is fail-safe — the cost of being
 * wrong is one untracked click, against routing a legally required opt-out
 * through a tracking redirect.
 */
function isOptOutPath(pathname: string, strict: boolean): boolean {
  const raw = pathname.split('/').filter(Boolean);
  const lower = raw.map((s) => s.toLowerCase());
  if (lower.some((s) => OPT_OUT_SEGMENTS.has(s))) return true;
  for (let i = 0; i < lower.length - 1; i++) {
    const next = raw[i + 1];
    if (lower[i] !== 'u' || next === undefined) continue;
    if (!strict || looksMinted(next)) return true;
  }
  return false;
}

/** Absolute URLs smuggled into a query string or fragment. */
function nestedUrls(parsed: URL): URL[] {
  const found: URL[] = [];
  for (const m of `${parsed.search}${parsed.hash}`.matchAll(/https?:\/\/[^\s&"'<>]+/gi)) {
    try {
      found.push(new URL(decodeURIComponent(m[0])));
    } catch {
      /* not a URL after decoding; nothing to exclude on */
    }
  }
  return found;
}

export function shouldRewrite(url: string): boolean {
  const u = url.trim();
  const lower = u.toLowerCase();
  if (lower.startsWith('mailto:') || lower.startsWith('tel:') || lower.startsWith('sms:')) {
    return false;
  }
  if (lower.startsWith('#')) return false;
  // An unrendered merge field. Tracking it would rewrite the token, not the link.
  if (lower.includes('unsubscribe_url') || lower.includes('preferences_url')) return false;
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;

  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    // Unparseable. Refusing to track is the safe half of the decision.
    return false;
  }

  if (isOptOutPath(parsed.pathname, true)) return false;
  if (nestedUrls(parsed).some((n) => isOptOutPath(n.pathname, false))) return false;
  return true;
}

/**
 * Whether a rendered message contains anything a recipient could actually click.
 *
 * This feeds `clickable_delivered`, so that a message containing no link never
 * lands in the denominator of a click rate  (I12).
 */
export function hasClickableLink(body: string, html?: string | null): boolean {
  return extractLinks(`${body}\n${html ?? ''}`).some(shouldRewrite);
}
