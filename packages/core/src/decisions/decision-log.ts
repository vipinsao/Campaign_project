import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.ts';
import { type ReasonCode, reasonSentence } from '@campaign/shared';

/**
 * The decision log  (I14).
 *
 * Every enqueue and every skip writes a row. "Nothing happened" is never an
 * acceptable system state.
 *
 * The failure this prevents is not a crash — it is an operator with no way to
 * answer "why didn't this fire?" other than reading source code, and an engineer
 * who answers it by adding a log line and waiting for it to happen again. A
 * decision row costs one insert and turns that conversation into a query.
 */
export type DecisionStage = 'trigger' | 'audience' | 'enrollment' | 'schedule' | 'send';

export type DecisionInput = {
  readonly tenantId: string;
  readonly stage: DecisionStage;
  readonly decision: 'proceed' | 'skip';
  readonly reasonCode: ReasonCode;
  /** Overrides the canned sentence when there is something more specific to say. */
  readonly detail?: string | undefined;
  /** The evaluated facts, so the call can be reproduced without rerunning the world. */
  readonly inputs?: Record<string, unknown> | undefined;
  readonly campaignId?: string | undefined;
  readonly campaignMessageId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly orderId?: string | undefined;
  readonly messageQueueId?: string | undefined;
  /**
   * When the decision was made, from the caller's Clock. Omitting it falls back to
   * the column DEFAULT, which is correct for a real request but wrong under a
   * FakeClock - and the decision log is the timeline the demo replays.
   */
  readonly decidedAt?: Date | undefined;
};

export async function recordDecision(db: Db | PoolClient, input: DecisionInput): Promise<void> {
  await db.query(
    `INSERT INTO send_decisions
       (tenant_id, campaign_id, campaign_message_id, contact_id, order_id,
        message_queue_id, stage, decision, reason_code, reason_detail, inputs, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::timestamptz, now()))`,
    [
      input.tenantId,
      input.campaignId ?? null,
      input.campaignMessageId ?? null,
      input.contactId ?? null,
      input.orderId ?? null,
      input.messageQueueId ?? null,
      input.stage,
      input.decision,
      input.reasonCode,
      input.detail ?? reasonSentence(input.reasonCode),
      JSON.stringify(input.inputs ?? {}),
      input.decidedAt ?? null,
    ],
  );
}

/**
 * Bulk variant for the trigger path, which evaluates many campaigns per event and
 * would otherwise issue one round trip per considered-and-rejected campaign.
 */
export async function recordDecisions(
  db: Db | PoolClient,
  inputs: readonly DecisionInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  const values: unknown[] = [];
  const tuples = inputs.map((input, i) => {
    const b = i * 12;
    values.push(
      input.tenantId,
      input.campaignId ?? null,
      input.campaignMessageId ?? null,
      input.contactId ?? null,
      input.orderId ?? null,
      input.messageQueueId ?? null,
      input.stage,
      input.decision,
      input.reasonCode,
      input.detail ?? reasonSentence(input.reasonCode),
      JSON.stringify(input.inputs ?? {}),
      input.decidedAt ?? null,
    );
    return (
      `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},` +
      `$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},COALESCE($${b + 12}::timestamptz, now()))`
    );
  });
  await db.query(
    `INSERT INTO send_decisions
       (tenant_id, campaign_id, campaign_message_id, contact_id, order_id,
        message_queue_id, stage, decision, reason_code, reason_detail, inputs, decided_at)
     VALUES ${tuples.join(', ')}`,
    values,
  );
}
