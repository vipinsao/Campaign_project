import { Hono } from 'hono';
import { query, queryOne, recordDecision } from '@campaign/core';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { operatorOf, tenantOf } from '../middleware/context.ts';
import { conflict, notFound } from '../errors.ts';
import { pagination } from './campaigns.ts';

/**
 * The queue, as an operator sees it.
 *
 * `deferrals` and `attempts` are both exposed and they are NOT the same number.
 * A message held back three nights by recipient-local quiet hours has three
 * deferrals and zero attempts; a message the provider rejected three times has
 * three attempts. Collapsing them into "retries" on the screen is how a guard that
 * is working correctly gets reported as an outage, and how an operator "fixes" it
 * by widening the quiet-hours window.
 */
export function queueRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/queue', async (c) => {
    const tenantId = tenantOf(c);
    const { limit, offset } = pagination(c.req.query('limit'), c.req.query('offset'));
    const status = c.req.query('status');
    const campaignId = c.req.query('campaignId');
    const contactId = c.req.query('contactId');
    const channel = c.req.query('channel');

    const rows = await query<Record<string, unknown>>(
      deps.db,
      `SELECT q.id, q.campaign_id, q.campaign_message_id, q.contact_id, q.enrollment_id,
              q.channel, q.status, q.recipient_address, q.rendered_subject,
              q.scheduled_at, q.sent_at, q.delivered_at, q.attempts, q.deferrals,
              q.next_attempt_at, q.provider, q.provider_error_code, q.provider_error_message,
              q.error_class, q.tracking_id, q.created_at,
              c.name AS campaign_name
         FROM message_queue q
         JOIN campaigns c ON c.id = q.campaign_id
        WHERE q.tenant_id = $1
          AND ($2::text IS NULL OR q.status = $2::text)
          AND ($3::uuid IS NULL OR q.campaign_id = $3::uuid)
          AND ($4::uuid IS NULL OR q.contact_id  = $4::uuid)
          AND ($5::text IS NULL OR q.channel = $5::text)
        ORDER BY q.scheduled_at DESC, q.id
        LIMIT $6 OFFSET $7`,
      [tenantId, status ?? null, campaignId ?? null, contactId ?? null, channel ?? null, limit, offset],
    );

    const counts = await query<{ status: string; n: string }>(
      deps.db,
      `SELECT status, count(*)::text AS n FROM message_queue
        WHERE tenant_id = $1 GROUP BY status`,
      [tenantId],
    );

    return c.json({
      messages: rows,
      countsByStatus: Object.fromEntries(counts.map((r) => [r.status, Number(r.n)])),
      page: { limit, offset },
    });
  });

  /**
   * Cancel one queued message.
   *
   * Only `pending` and `processing` rows can be cancelled, and the guard is in the
   * WHERE clause rather than in a prior SELECT. A row that a worker claimed between
   * the check and the update is a row that is being sent right now; cancelling it
   * after the fact would leave the queue saying "cancelled" about a message that
   * is already in somebody's inbox — which makes the queue lie about what was sent,
   * and the queue is the thing analytics and support both read.
   */
  app.post('/queue/:id/cancel', async (c) => {
    const tenantId = tenantOf(c);
    const operator = operatorOf(c);
    const id = c.req.param('id');

    const existing = await queryOne<{ id: string; status: string; campaign_id: string; contact_id: string }>(
      deps.db,
      `SELECT id, status, campaign_id, contact_id FROM message_queue
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (existing === undefined) throw notFound('Queued message', id);

    const cancelled = await queryOne<{ id: string }>(
      deps.db,
      `UPDATE message_queue
          SET status = 'cancelled', provider_error_code = 'operator_cancelled', updated_at = $3
        WHERE tenant_id = $1 AND id = $2 AND status IN ('pending','processing')
      RETURNING id`,
      [tenantId, id, deps.clock.now()],
    );

    if (cancelled === undefined) {
      throw conflict(
        'message_not_cancellable',
        `This message is '${existing.status}' and can no longer be cancelled.`,
        { messageId: id, status: existing.status },
      );
    }

    // Cancellation is a decision, and decisions are logged. Otherwise "why did this
    // customer not get the second email?" has no answer beyond an operator's memory.
    await recordDecision(deps.db, {
      tenantId,
      stage: 'send',
      decision: 'skip',
      reasonCode: 'enrollment_stopped',
      detail: 'An operator cancelled this queued message.',
      campaignId: existing.campaign_id,
      contactId: existing.contact_id,
      messageQueueId: id,
      inputs: { cancelledBy: operator.userId, previousStatus: existing.status },
    });

    return c.json({ cancelled: true, messageId: id });
  });

  return app;
}
