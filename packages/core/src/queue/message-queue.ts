import type { PoolClient } from 'pg';
import { type Db, query, queryOne, withTransaction } from '../db/pool.ts';
import type { Clock } from '../clock.ts';
import type { Channel, QueueStatus } from '@campaign/shared';

/**
 * The message queue  (I3, I4).
 *
 * PostgreSQL is the queue. There is no Redis and no broker, and that is a decision
 * rather than an omission — see docs/ADR-001-postgres-queue.md, which also names the
 * throughput at which it stops being the right answer. The property that buys the
 * most here is that an enqueue can share a transaction with the business write that
 * caused it, which a separate broker cannot do without an outbox table and a relay.
 */

export type QueueRow = {
  id: string;
  tenant_id: string;
  enrollment_id: string;
  campaign_id: string;
  campaign_version_id: string;
  campaign_message_id: string;
  contact_id: string;
  order_id: string | null;
  anchor_id: string | null;
  channel: Channel;
  recipient_address: string;
  rendered_subject: string | null;
  rendered_body: string;
  rendered_html: string | null;
  tracking_id: string;
  scheduled_at: Date;
  status: QueueStatus;
  claimed_at: Date | null;
  claimed_by: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  deferrals: number;
  provider: string | null;
  provider_message_id: string | null;
  provider_error_code: string | null;
  provider_error_message: string | null;
  error_class: 'terminal' | 'transient' | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  dedup_key: string;
};

export type EnqueueInput = {
  readonly tenantId: string;
  readonly enrollmentId: string;
  readonly campaignId: string;
  readonly campaignVersionId: string;
  readonly campaignMessageId: string;
  readonly contactId: string;
  readonly orderId?: string | null;
  readonly anchorId?: string | null;
  readonly channel: Channel;
  readonly recipientAddress: string;
  readonly renderedSubject?: string | null;
  readonly renderedBody: string;
  readonly renderedHtml?: string | null;
  /** `null` parks the row at 'infinity' awaiting a delivery anchor. */
  readonly scheduledAt: Date | null;
};

/** Rows parked awaiting an order delivery use this sentinel rather than a nullable
 *  column, so `scheduled_at` stays NOT NULL and the claim query stays index-only. */
export const ANCHOR_PARKED = 'infinity';

/**
 * Enqueue. Deduplication is the DATABASE's job  (I4).
 *
 * `ON CONFLICT DO NOTHING` against a UNIQUE index on a GENERATED dedup_key. There
 * is deliberately no "check whether it exists, then insert" here: between the check
 * and the insert, a concurrent trigger, a webhook redelivery and a retried API call
 * can all pass the same check, and all three then insert. The check-then-insert
 * pattern does not reduce duplicates, it just makes them rarer and therefore harder
 * to reproduce.
 *
 * Returning no row is a NORMAL, EXPECTED outcome — it means the message was already
 * queued — and callers record a `duplicate_suppressed` decision rather than raising.
 */
export async function enqueue(
  db: Db | PoolClient,
  input: EnqueueInput,
): Promise<{ id: string; dedupKey: string } | undefined> {
  const scheduledAt = input.scheduledAt === null ? ANCHOR_PARKED : input.scheduledAt;
  return queryOne<{ id: string; dedup_key: string }>(
    db,
    `INSERT INTO message_queue
       (tenant_id, enrollment_id, campaign_id, campaign_version_id, campaign_message_id,
        contact_id, order_id, anchor_id, channel, recipient_address,
        rendered_subject, rendered_body, rendered_html, scheduled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (tenant_id, dedup_key) DO NOTHING
     RETURNING id, dedup_key`,
    [
      input.tenantId,
      input.enrollmentId,
      input.campaignId,
      input.campaignVersionId,
      input.campaignMessageId,
      input.contactId,
      input.orderId ?? null,
      input.anchorId ?? null,
      input.channel,
      input.recipientAddress,
      input.renderedSubject ?? null,
      input.renderedBody,
      input.renderedHtml ?? null,
      scheduledAt,
    ],
  ).then((row) => (row ? { id: row.id, dedupKey: row.dedup_key } : undefined));
}

/**
 * Claim a batch  (I3).
 *
 * `FOR UPDATE SKIP LOCKED` inside a transaction. Two properties matter:
 *
 *  - EXACTLY ONCE under concurrency. Rows locked by another worker are skipped
 *    rather than waited on, so N workers make progress on disjoint sets instead of
 *    serialising behind each other. The alternative some systems use — read a batch,
 *    then compare-and-swap each row — has a window between the read and the swap in
 *    which two workers both believe they own the row.
 *  - CRASH SAFETY. The `claimed_at`/`claimed_by` stamp is what lets `reclaimStale`
 *    recover rows whose worker died mid-send, instead of leaving them stuck in
 *    `processing` forever, which is how a queue quietly stops delivering.
 */
export async function claimBatch(
  db: Db,
  opts: { readonly workerId: string; readonly batchSize: number; readonly clock: Clock },
): Promise<QueueRow[]> {
  const now = opts.clock.now();
  return withTransaction(db, async (tx) =>
    query<QueueRow>(
      tx,
      `WITH claimed AS (
         SELECT id FROM message_queue
          WHERE status = 'pending'
            AND scheduled_at <= $1
            AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY scheduled_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE message_queue m
          SET status     = 'processing',
              claimed_at = $1,
              claimed_by = $3,
              attempts   = m.attempts + 1,
              updated_at = $1
         FROM claimed
        WHERE m.id = claimed.id
       RETURNING m.*`,
      [now, opts.batchSize, opts.workerId],
    ),
  );
}

/**
 * Reclaim rows stranded in `processing`  (I3).
 *
 * A worker that is OOM-killed between claiming a row and sending it leaves that row
 * locked in `processing` with no owner. Nothing else will ever pick it up, and the
 * symptom is a queue that appears to be draining while a growing tail of messages
 * silently never sends.
 */
export async function reclaimStale(
  db: Db,
  opts: { readonly staleMinutes: number; readonly maxAttempts: number; readonly clock: Clock },
): Promise<{ reclaimed: number; exhausted: number }> {
  const now = opts.clock.now();
  const cutoff = new Date(now.getTime() - opts.staleMinutes * 60_000);

  const reclaimed = await query<{ id: string }>(
    db,
    `UPDATE message_queue
        SET status          = 'pending',
            claimed_at      = NULL,
            claimed_by      = NULL,
            next_attempt_at = $1::timestamptz
                              + (interval '1 minute' * least(power(2, attempts), 60)),
            updated_at      = $1
      WHERE status = 'processing'
        AND claimed_at < $2
        AND attempts < $3
      RETURNING id`,
    [now, cutoff, opts.maxAttempts],
  );

  const exhausted = await query<{ id: string }>(
    db,
    `UPDATE message_queue
        SET status      = 'failed',
            error_class = 'transient',
            provider_error_code = COALESCE(provider_error_code, 'stale_claim_exhausted'),
            claimed_at  = NULL,
            claimed_by  = NULL,
            updated_at  = $1
      WHERE status = 'processing'
        AND claimed_at < $2
        AND attempts >= $3
      RETURNING id`,
    [now, cutoff, opts.maxAttempts],
  );

  return { reclaimed: reclaimed.length, exhausted: exhausted.length };
}

/**
 * Defer a claimed row  (the fix for "quiet hours ate my retries").
 *
 * A deferral is NOT an attempt. `claimBatch` increments `attempts` optimistically,
 * because at claim time it cannot know whether the row is about to be sent or held
 * back. When a retryable gate — quiet hours, a frequency cap, a paused campaign —
 * says "not now", that increment has to be undone.
 *
 * Without this, a message correctly held back for three consecutive nights burns
 * three of its five attempts and is then reclaimed as permanently failed. Counting
 * "we correctly chose not to send yet" as "we tried and it broke" turns a guard
 * that is working into an outage, and the resulting metric blames the provider.
 */
export async function deferClaimed(
  db: Db | PoolClient,
  opts: { readonly id: string; readonly until: Date; readonly clock: Clock },
): Promise<void> {
  await db.query(
    `UPDATE message_queue
        SET status           = 'pending',
            claimed_at       = NULL,
            claimed_by       = NULL,
            attempts         = GREATEST(attempts - 1, 0),
            deferrals        = deferrals + 1,
            last_deferred_at = $3,
            scheduled_at     = $2,
            next_attempt_at  = NULL,
            updated_at       = $3
      WHERE id = $1`,
    [opts.id, opts.until, opts.clock.now()],
  );
}

export async function markSent(
  db: Db | PoolClient,
  opts: {
    readonly id: string;
    readonly provider: string;
    readonly providerMessageId: string;
    readonly clock: Clock;
  },
): Promise<void> {
  // Note the status written here is 'sent', never 'delivered' (I9). Delivery is a
  // fact only the provider can report, and inferring it on the line after the send
  // is how a delivery-rate metric reads 100% forever.
  await db.query(
    `UPDATE message_queue
        SET status = 'sent', sent_at = $4, provider = $2, provider_message_id = $3,
            claimed_at = NULL, claimed_by = NULL, updated_at = $4
      WHERE id = $1`,
    [opts.id, opts.provider, opts.providerMessageId, opts.clock.now()],
  );
}

export async function markFailed(
  db: Db | PoolClient,
  opts: {
    readonly id: string;
    readonly provider: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly errorClass: 'terminal' | 'transient';
    readonly clock: Clock;
  },
): Promise<void> {
  await db.query(
    `UPDATE message_queue
        SET status = 'failed', provider = $2, provider_error_code = $3,
            provider_error_message = $4, error_class = $5,
            claimed_at = NULL, claimed_by = NULL, updated_at = $6
      WHERE id = $1`,
    [opts.id, opts.provider, opts.errorCode, opts.errorMessage, opts.errorClass, opts.clock.now()],
  );
}

/** Transient failure: back to pending with a backoff. Terminal never lands here (I8). */
export async function scheduleRetry(
  db: Db | PoolClient,
  opts: {
    readonly id: string;
    readonly provider: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly delayMs: number;
    readonly clock: Clock;
  },
): Promise<void> {
  const now = opts.clock.now();
  await db.query(
    `UPDATE message_queue
        SET status = 'pending', claimed_at = NULL, claimed_by = NULL,
            provider = $2, provider_error_code = $3, provider_error_message = $4,
            error_class = 'transient', next_attempt_at = $5, updated_at = $6
      WHERE id = $1`,
    [opts.id, opts.provider, opts.errorCode, opts.errorMessage, new Date(now.getTime() + opts.delayMs), now],
  );
}

/** Terminal gate failure: the message will never be sent. */
export async function markCancelled(
  db: Db | PoolClient,
  opts: { readonly id: string; readonly reasonCode: string; readonly clock: Clock },
): Promise<void> {
  await db.query(
    `UPDATE message_queue
        SET status = 'cancelled', claimed_at = NULL, claimed_by = NULL,
            provider_error_code = $2, updated_at = $3
      WHERE id = $1`,
    [opts.id, opts.reasonCode, opts.clock.now()],
  );
}

/**
 * Cancel everything still queued for a contact on a channel  (I6).
 *
 * This is what makes an opt-out take effect immediately rather than "for messages
 * queued from now on". A customer who says stop and then receives the three
 * messages already sitting in the queue has, correctly, not been listened to.
 */
export async function cancelQueuedForContact(
  db: Db | PoolClient,
  opts: {
    readonly tenantId: string;
    readonly contactId: string;
    readonly channel: Channel;
    readonly reasonCode: string;
    readonly clock: Clock;
  },
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    db,
    `UPDATE message_queue
        SET status = 'cancelled', provider_error_code = $4, updated_at = $5
      WHERE tenant_id = $1 AND contact_id = $2 AND channel = $3
        AND status IN ('pending','processing')
      RETURNING id`,
    [opts.tenantId, opts.contactId, opts.channel, opts.reasonCode, opts.clock.now()],
  );
  return rows.map((r) => r.id);
}
