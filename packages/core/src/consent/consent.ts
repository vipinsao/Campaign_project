import type { PoolClient } from 'pg';
import { type Db, query, queryOne } from '../db/pool.ts';
import type { Clock } from '../clock.ts';
import {
  type Channel,
  type CampaignCategory,
  type ConsentSource,
  type ConsentState,
  type SuppressionReason,
  SUPPRESSION_REASON_CODE,
  type ReasonCode,
} from '@campaign/shared';

/**
 * Consent and suppression  (I6).
 *
 * Two separate mechanisms, deliberately, because they answer different questions:
 *
 *   contact_consents  — "what did this PERSON tell us, when, and how do we know?"
 *                       An append-only ledger. The database refuses UPDATE and
 *                       DELETE on it.
 *   suppressions      — "is this ADDRESS off limits right now?"
 *                       Address-level, because contacts get merged, re-imported and
 *                       duplicated, and every one of those is a chance to resurrect
 *                       an address that asked never to be contacted again.
 *
 * A boolean `opted_in` column on the contact row is neither of these. It cannot say
 * when, it cannot say why, it cannot survive a merge, and an UPDATE to it destroys
 * the only evidence the previous state ever existed.
 */

export type ConsentDecision =
  { allowed: true } | { allowed: false; reasonCode: ReasonCode; detail: string };

/**
 * Resolve current consent for a channel and campaign category.
 *
 * Category precedence was undefined in the build spec and is load-bearing, so it is
 * decided here and recorded in docs/DECISIONS.md: MOST RECENT INTENT WINS, treating
 * wildcard rows and category-specific rows as one timeline. A preference centre that
 * offers "drop one category instead of all mail" is only honest if the later,
 * narrower choice actually takes effect; resolving wildcard-always-wins would make
 * the per-category toggles decorative.
 *
 * The resolution lives in a SQL function (`consent_state`) rather than here so that
 * the send-time gate and the analytics queries cannot drift apart.
 */
export async function consentState(
  db: Db | PoolClient,
  opts: {
    readonly tenantId: string;
    readonly contactId: string;
    readonly channel: Channel;
    readonly category: CampaignCategory;
  },
): Promise<ConsentState | undefined> {
  const row = await queryOne<{ state: ConsentState | null }>(
    db,
    `SELECT consent_state($1,$2,$3,$4) AS state`,
    [opts.tenantId, opts.contactId, opts.channel, opts.category],
  );
  return row?.state ?? undefined;
}

/** Append a consent row. There is no update path, by design. */
export async function recordConsent(
  db: Db | PoolClient,
  opts: {
    readonly tenantId: string;
    readonly contactId: string;
    readonly channel: Channel;
    readonly category?: CampaignCategory | null;
    readonly state: ConsentState;
    readonly source: ConsentSource;
    readonly evidence?: Record<string, unknown>;
    readonly clock: Clock;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO contact_consents
       (tenant_id, contact_id, channel, category, state, source, evidence, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      opts.tenantId,
      opts.contactId,
      opts.channel,
      opts.category ?? null,
      opts.state,
      opts.source,
      JSON.stringify(opts.evidence ?? {}),
      opts.clock.now(),
    ],
  );
}

export async function addSuppression(
  db: Db | PoolClient,
  opts: {
    readonly tenantId: string;
    readonly channel: Channel;
    readonly address: string;
    readonly reason: SuppressionReason;
    readonly expiresAt?: Date | null;
    readonly evidence?: Record<string, unknown>;
    readonly clock: Clock;
  },
): Promise<void> {
  // A second STOP from an already-suppressed address is not an error, and must not
  // overwrite an ACTIVE suppression — the first reason is the one carrying the
  // evidence of why the address was suppressed.
  //
  // But a bare `ON CONFLICT DO NOTHING` was wrong, and wrong in the worst
  // direction. Suppressions are keyed on (tenant, channel, address), and a soft
  // bounce writes a row with an expiry. Once that row lapses it is invisible to the
  // send gate but STILL OCCUPIES THE KEY — so the next hard bounce, unsubscribe or
  // spam complaint for that address hit the conflict clause and were silently
  // discarded. The address then kept receiving mail, permanently, with no error
  // anywhere. A QA test caught a hard-bounced address being handed back to the
  // provider.
  //
  // Two cases now take the write, and both are stated as predicates rather than
  // left to a comment:
  //   - the existing row has LAPSED, so it is not protecting anybody;
  //   - the new suppression is PERMANENT and the existing one was temporary, so
  //     the stronger protection wins regardless of arrival order.
  // An active permanent suppression still wins over anything later, which is the
  // original intent.
  await db.query(
    `INSERT INTO suppressions (tenant_id, channel, address, reason, expires_at, evidence)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, channel, address) DO UPDATE
        SET reason     = EXCLUDED.reason,
            expires_at = EXCLUDED.expires_at,
            evidence   = EXCLUDED.evidence,
            created_at = $7::timestamptz
      WHERE (suppressions.expires_at IS NOT NULL AND suppressions.expires_at <= $7::timestamptz)
         OR (EXCLUDED.expires_at IS NULL AND suppressions.expires_at IS NOT NULL)`,
    [
      opts.tenantId,
      opts.channel,
      opts.address,
      opts.reason,
      opts.expiresAt ?? null,
      JSON.stringify(opts.evidence ?? {}),
      opts.clock.now(),
    ],
  );
}

/**
 * Is this address suppressed right now?
 *
 * Expiry is evaluated HERE rather than trusted to the nightly expiry job. A
 * suppression whose expiry is only applied by a daily sweep is honoured for up to
 * twenty-four hours past the moment it should have lapsed — and, worse, the reverse
 * is also true if the job fails: an expired suppression keeps blocking mail and
 * nothing surfaces it.
 */
export async function activeSuppression(
  db: Db | PoolClient,
  opts: {
    readonly tenantId: string;
    readonly channel: Channel;
    readonly address: string;
    readonly clock: Clock;
  },
): Promise<{ reason: SuppressionReason; created_at: Date } | undefined> {
  return queryOne<{ reason: SuppressionReason; created_at: Date }>(
    db,
    `SELECT reason, created_at FROM suppressions
      WHERE tenant_id = $1 AND channel = $2 AND address = $3
        AND (expires_at IS NULL OR expires_at > $4)`,
    [opts.tenantId, opts.channel, opts.address, opts.clock.now()],
  );
}

export function suppressionReasonCode(reason: SuppressionReason): ReasonCode {
  return SUPPRESSION_REASON_CODE[reason];
}

/** Is the contact inside a self-service "pause for 30 days" window? */
export async function activePause(
  db: Db | PoolClient,
  opts: {
    readonly contactId: string;
    readonly channel: Channel;
    readonly clock: Clock;
  },
): Promise<{ upper: Date } | undefined> {
  const row = await queryOne<{ upper: Date }>(
    db,
    `SELECT upper(period) AS upper FROM consent_pauses
      WHERE contact_id = $1 AND channel = $2 AND period @> $3::timestamptz
      LIMIT 1`,
    [opts.contactId, opts.channel, opts.clock.now()],
  );
  return row;
}

/**
 * Opt a contact out, everywhere it needs to take effect at once.
 *
 * Three writes, one transaction, because doing any two of them without the third
 * produces a system that has half-listened: a ledger entry with mail still queued,
 * or a suppression with no evidence of who asked for it.
 */
export async function optOut(
  db: PoolClient,
  opts: {
    readonly tenantId: string;
    readonly contactId: string;
    readonly channel: Channel;
    readonly address: string;
    readonly category?: CampaignCategory | null;
    readonly source: ConsentSource;
    readonly reason: SuppressionReason;
    readonly evidence?: Record<string, unknown>;
    readonly clock: Clock;
  },
): Promise<{ cancelledMessageIds: string[] }> {
  await recordConsent(db, {
    tenantId: opts.tenantId,
    contactId: opts.contactId,
    channel: opts.channel,
    category: opts.category ?? null,
    state: 'opted_out',
    source: opts.source,
    evidence: opts.evidence ?? {},
    clock: opts.clock,
  });

  // A category-scoped opt-out narrows a preference; it does not suppress the
  // address for everything, so it must not write a suppression row.
  if (!opts.category) {
    await addSuppression(db, {
      tenantId: opts.tenantId,
      channel: opts.channel,
      address: opts.address,
      reason: opts.reason,
      evidence: opts.evidence ?? {},
      clock: opts.clock,
    });
  }

  // Cancel what is queued — but only what this opt-out actually covers.
  //
  // Two bugs used to live in this one statement. It filtered on
  // (tenant, contact, channel) and nothing else, so:
  //
  //   - a CATEGORY-scoped opt-out ("stop sending me promotions") cancelled every
  //     queued message on the channel, including ones in categories the contact
  //     had said nothing about; and
  //   - any opt-out cancelled queued TRANSACTIONAL messages, which the send-time
  //     gate deliberately exempts from consent. Clicking "unsubscribe" in a
  //     marketing email killed the order receipt already queued for you. That is
  //     both wrong and the opposite of what the recipient asked for.
  //
  // Transactional messages are therefore never cancelled here: they do not ride on
  // marketing consent, so withdrawing marketing consent cannot withdraw them. An
  // operator who genuinely wants to stop one cancels the queue row directly.
  const cancelled = await query<{ id: string }>(
    db,
    `UPDATE message_queue q
        SET status = 'cancelled',
            provider_error_code = $4,
            updated_at = $5
      WHERE q.tenant_id = $1 AND q.contact_id = $2 AND q.channel = $3
        AND q.status IN ('pending','processing')
        AND EXISTS (
              SELECT 1 FROM campaigns c
               WHERE c.id = q.campaign_id
                 AND c.category <> 'transactional'
                 AND ($6::text IS NULL OR c.category = $6::text)
            )
      RETURNING q.id`,
    [
      opts.tenantId,
      opts.contactId,
      opts.channel,
      // A category-scoped opt-out writes no suppression row, so reporting a
      // suppression reason on the cancelled message would name something that does
      // not exist. Report the consent decision instead.
      opts.category ? 'consent_opted_out' : suppressionReasonCode(opts.reason),
      opts.clock.now(),
      opts.category ?? null,
    ],
  );

  return { cancelledMessageIds: cancelled.map((r) => r.id) };
}
