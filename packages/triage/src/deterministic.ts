import { createHash } from 'node:crypto';
import { type Db, query } from '@campaign/core';
import type { RecipientResolution } from '@campaign/shared';

/**
 * The deterministic side of the boundary  (V1, V9).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING IN THIS FILE CAN REACH A MODEL. That is not a convention, it is the
 * import list: there is no model client in scope here, and there is no code path
 * from `detectOptOut` to one.
 *
 * The failure being prevented is specific and it is legal, not aesthetic. If
 * opt-out detection is a model call, then every model outage, rate limit, budget
 * ceiling, timeout and hallucination is a customer who said STOP and kept
 * receiving messages. In the UK/EU that is a PECR/GDPR breach; in the US it is a
 * TCPA claim per message. A language model is an excellent reader of prose and a
 * completely unacceptable place to put a permission check, because a permission
 * check has to give the same answer twice and has to give it when the vendor is
 * down.
 *
 * The same argument covers identity: order numbers are unique per STORE, not per
 * tenant (see the UNIQUE constraint in migrations/0003_commerce.sql), so a lookup
 * can legitimately match two orders belonging to two different customers. A model
 * asked to "find the order" will always pick one. `extractOrderNumber` returns
 * `ambiguous` instead, and the caller is forced by the type to handle it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The carrier keyword set. STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT are the words
 * US carriers require to be honoured on SMS; the same list is applied to email
 * replies because a customer who replies "UNSUBSCRIBE" to an email means it just
 * as much as one who texts it.
 */
export const OPT_OUT_KEYWORDS: readonly string[] = [
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'REVOKE',
  'OPTOUT',
];

/**
 * Normalise for keyword comparison.
 *
 * Unicode first: a body pasted from a phone keyboard arrives with curly quotes,
 * non-breaking spaces and zero-width joiners, and a STOP with a zero-width space
 * wedged into it must not read as a different word from "STOP". NFKC folds the
 * compatibility forms, then the zero-width characters come out, then punctuation,
 * then case, then whitespace.
 */
function normaliseForKeyword(body: string): string {
  return body
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export type OptOutDetection =
  | { readonly optedOut: false }
  | { readonly optedOut: true; readonly keyword: string; readonly normalised: string };

/**
 * Keyword-first opt-out detection. Never calls the model.
 *
 * The match is on the WHOLE normalised message, not on "contains a keyword", and
 * that restraint is deliberate. "Please cancel my order #4471, but keep sending me
 * the newsletter" contains CANCEL; treating it as an opt-out would suppress an
 * address the customer never asked to suppress, and a suppression is very hard to
 * undo honestly — there is no un-suppress path in this system that a machine may
 * take (V9). Carriers apply the same rule for the same reason.
 *
 * Prose that merely gestures at leaving ("please stop emailing me so often") is
 * therefore NOT a deterministic opt-out. It goes to the model, comes back as a
 * classification with a confidence, and — because the classifier's only consent
 * capability is `addSuppression` — the worst the model can do is suppress someone
 * who half-asked for it. It can never do the reverse.
 *
 * "STOP ALL" collapses to "STOPALL" because the space is a keyboard artefact, not
 * a different intent.
 */
export function detectOptOut(body: string): OptOutDetection {
  const normalised = normaliseForKeyword(body);
  if (normalised.length === 0) return { optedOut: false };

  const collapsed = normalised.replace(/\s+/g, '');
  for (const keyword of OPT_OUT_KEYWORDS) {
    if (normalised === keyword || collapsed === keyword) {
      return { optedOut: true, keyword, normalised };
    }
  }
  return { optedOut: false };
}

/**
 * Content hash — the cache key (V8) and the duplicate-detection key.
 *
 * Line endings are folded and trailing whitespace trimmed, because the same reply
 * arriving via SMTP and via a webhook differs by exactly that and is not a
 * different reply. Case is NOT folded: "THIS IS UNACCEPTABLE" and "this is
 * unacceptable" are different inputs to a sentiment judgement, and a cache that
 * conflated them would serve the wrong answer for free, forever.
 */
export function contentHash(body: string): string {
  const canonical = body
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export type OrderMatch = {
  readonly id: string;
  readonly order_number: string;
  readonly store_id: string;
  readonly contact_id: string;
  readonly status: string;
};

/**
 * The shapes an order number is actually written in. Labelled forms only: a bare
 * run of digits in a reply is far more often a phone number, a postcode, a date or
 * a price than an order number, and a "helpful" bare-digit pattern turns every
 * such reply into a lookup against somebody's order.
 */
const ORDER_NUMBER_PATTERNS: readonly RegExp[] = [
  /#\s*([A-Z0-9][A-Z0-9-]{2,23})/gi,
  /\border\s*(?:number|num|no\.?|id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,23})/gi,
  /\b((?:ORD|SO|INV|CE)-[A-Z0-9-]{2,23})\b/gi,
];

/** The regex half, exposed so the extraction rules are testable without a database. */
export function orderNumberCandidates(body: string): string[] {
  const seen = new Set<string>();
  for (const pattern of ORDER_NUMBER_PATTERNS) {
    // Regexes are declared with /g and reused across calls, so lastIndex must be
    // reset. A shared stateful regex silently skips matches on every second call.
    pattern.lastIndex = 0;
    for (const match of body.matchAll(pattern)) {
      const captured = match[1];
      if (captured === undefined) continue;
      const trimmed = captured.replace(/-+$/, '').toUpperCase();
      if (trimmed.length >= 3) seen.add(trimmed);
    }
  }
  return [...seen];
}

/**
 * Regex candidates, then a database existence check  (V1).
 *
 * Two separate reasons this must not be a model's job:
 *
 *   1. A model asked "what is the order number?" always answers. It will read
 *      "my 2019 order" as an order number and it will read "#4471" as "4471" or
 *      "44711" depending on the day. An extracted string that does not exist in
 *      `orders` is not an order number, and only the database can say that.
 *
 *   2. `orders` is UNIQUE on (tenant_id, store_id, order_number). Two stores may
 *      both have order #1001, belonging to two different people. The return type
 *      forces the caller to decide what to do about that at COMPILE time; there
 *      is no arm of `RecipientResolution` that means "just take the first one".
 */
export async function extractOrderNumber(
  body: string,
  db: Db,
  tenantId: string,
): Promise<RecipientResolution<OrderMatch>> {
  const candidates = orderNumberCandidates(body);
  if (candidates.length === 0) return { kind: 'none' };

  const rows = await query<OrderMatch>(
    db,
    `SELECT id, order_number, store_id, contact_id, status
       FROM orders
      WHERE tenant_id = $1 AND upper(order_number) = ANY($2::text[])
      ORDER BY placed_at DESC`,
    [tenantId, candidates],
  );

  if (rows.length === 0) return { kind: 'none' };
  const only = rows[0];
  if (rows.length === 1 && only !== undefined) return { kind: 'single', match: only };
  return { kind: 'ambiguous', candidates: rows };
}

/**
 * Duplicate detection (V1). Two deliveries of the same body from the same address
 * are one reply — provider webhook redelivery is routine, and classifying the
 * redelivery costs a second model call for an answer that is already on disk.
 */
export async function findDuplicateReply(
  db: Db,
  opts: {
    readonly tenantId: string;
    readonly contentHash: string;
    readonly excludeReplyId?: string;
  },
): Promise<{ id: string } | undefined> {
  const rows = await query<{ id: string }>(
    db,
    `SELECT id FROM inbound_replies
      WHERE tenant_id = $1 AND content_hash = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)
      ORDER BY received_at ASC
      LIMIT 1`,
    [opts.tenantId, opts.contentHash, opts.excludeReplyId ?? null],
  );
  return rows[0];
}
