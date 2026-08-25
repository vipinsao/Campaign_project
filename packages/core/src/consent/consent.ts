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
  | { allowed: true }
  | { allowed: false; reasonCode: ReasonCode; detail: string };

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
  },
): Promise<void> {
  // A second STOP from an already-suppressed address is not an error, and must not
  // overwrite the original reason — the first reason is the one with the evidence.
  await db.query(
    `INSERT INTO suppressions (tenant_id, channel, address, reason, expires_at, evidence)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, channel, address) DO NOTHING`,
    [
      opts.tenantId,
      opts.channel,
      opts.address,
      opts.reason,
      opts.expiresAt ?? null,
      JSON.stringify(opts.evidence ?? {}),
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
    });
  }

  const cancelled = await query<{ id: string }>(
    db,
    `UPDATE message_queue
        SET status = 'cancelled',
            provider_error_code = $4,
            updated_at = $5
      WHERE tenant_id = $1 AND contact_id = $2 AND channel = $3
        AND status IN ('pending','processing')
      RETURNING id`,
    [
      opts.tenantId,
      opts.contactId,
      opts.channel,
      suppressionReasonCode(opts.reason),
      opts.clock.now(),
    ],
  );

  return { cancelledMessageIds: cancelled.map((r) => r.id) };
}
