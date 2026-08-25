import { Hono } from 'hono';
import { query, queryOne } from '@campaign/core';
import type { RecipientResolution } from '@campaign/shared';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { tenantOf } from '../middleware/context.ts';
import { badRequest, notFound } from '../errors.ts';
import { pagination } from './campaigns.ts';

/**
 * Order lookup  (I13) — the endpoint that is allowed to say "I don't know".
 *
 * Order numbers are unique PER STORE, not per tenant. `migrations/0003` says so in
 * its UNIQUE constraint: (tenant_id, store_id, order_number). A support agent
 * pasting "10423" into a search box, or a webhook carrying an order number and no
 * store, is therefore asking a question that can legitimately have two answers.
 *
 * The `storeId` parameter is OPTIONAL, and that is deliberate rather than lax:
 * making it required would hide the ambiguity instead of resolving it, because the
 * callers that cannot supply a store are exactly the callers that need this
 * endpoint. Its absence is what makes `kind: 'ambiguous'` reachable at all.
 *
 * There is NO `LIMIT 1` in this file, and there must never be one. Taking the most
 * recent match sends one customer's order details — their address, their items,
 * their total — to a different customer. That is not a slightly-wrong result; it is
 * a data breach that looks like a working feature, which is why the return type is
 * a union with an explicit `ambiguous` arm rather than `Order | null`. The
 * compiler makes every caller decide.
 */

type OrderSummary = {
  readonly id: string;
  readonly orderNumber: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly storeCode: string;
  readonly status: string;
  readonly total: string;
  readonly currency: string;
  readonly placedAt: string;
  readonly contactId: string;
  /** Masked, because an ambiguous lookup shows candidates from several customers. */
  readonly contactEmailHint: string | null;
};

type OrderRow = {
  readonly id: string;
  readonly order_number: string;
  readonly store_id: string;
  readonly store_name: string;
  readonly store_code: string;
  readonly status: string;
  readonly total: string;
  readonly currency: string;
  readonly placed_at: Date;
  readonly contact_id: string;
  readonly email: string | null;
};

/**
 * `a***@example.com`.
 *
 * An ambiguous result lists candidates that belong to DIFFERENT customers, and the
 * point of the disambiguation screen is for an agent to pick the right one — not
 * to read two strangers' addresses off the same page. The hint is enough to
 * recognise an address you already know and not enough to learn one you do not.
 */
function maskEmail(email: string | null): string | null {
  if (email === null) return null;
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function toSummary(row: OrderRow): OrderSummary {
  return {
    id: row.id,
    orderNumber: row.order_number,
    storeId: row.store_id,
    storeName: row.store_name,
    storeCode: row.store_code,
    status: row.status,
    total: row.total,
    currency: row.currency,
    placedAt: row.placed_at.toISOString(),
    contactId: row.contact_id,
    contactEmailHint: maskEmail(row.email),
  };
}

export function orderRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/orders/lookup', async (c) => {
    const tenantId = tenantOf(c);
    const number = c.req.query('number')?.trim();
    const storeId = c.req.query('storeId')?.trim();

    if (number === undefined || number.length === 0) {
      throw badRequest('missing_order_number', 'Pass ?number=<order number> to look up an order.');
    }

    const rows = await query<OrderRow>(
      deps.db,
      `SELECT o.id, o.order_number, o.store_id, s.name AS store_name, s.code AS store_code,
              o.status, o.total::text AS total, o.currency, o.placed_at, o.contact_id,
              ct.email::text AS email
         FROM orders o
         JOIN stores   s  ON s.id  = o.store_id
         JOIN contacts ct ON ct.id = o.contact_id
        WHERE o.tenant_id = $1
          AND o.order_number = $2
          AND ($3::uuid IS NULL OR o.store_id = $3::uuid)
        ORDER BY o.placed_at DESC, o.id`,
      [tenantId, number, storeId !== undefined && storeId.length > 0 ? storeId : null],
    );

    const resolution: RecipientResolution<OrderSummary> =
      rows.length === 0
        ? { kind: 'none' }
        : rows.length === 1 && rows[0] !== undefined
          ? { kind: 'single', match: toSummary(rows[0]) }
          : { kind: 'ambiguous', candidates: rows.map(toSummary) };

    if (resolution.kind === 'ambiguous') {
      // 300 Multiple Choices. A 200 with a shape the caller has to inspect is how
      // an integrator writes `response.candidates[0]` and reintroduces the bug this
      // endpoint exists to prevent; a non-2xx makes ignoring it deliberate.
      return c.json(
        {
          ...resolution,
          message:
            `Order number '${number}' exists in ${resolution.candidates.length} stores. ` +
            'Repeat the request with ?storeId= to say which one. No order was chosen.',
          disambiguateBy: 'storeId',
        },
        300,
      );
    }

    return c.json(resolution);
  });

  /**
   * The order's whole story: its own timeline, every message it caused, and every
   * decision taken about it — including the skips.
   *
   * "Why didn't this customer get the review request?" is the question this system
   * exists to answer, and answering it by reading application logs is the thing it
   * exists to replace.
   */
  app.get('/orders/:id/journey', async (c) => {
    const tenantId = tenantOf(c);
    const orderId = c.req.param('id');

    const order = await queryOne<OrderRow & { delivered_at: Date | null; shipped_at: Date | null }>(
      deps.db,
      `SELECT o.id, o.order_number, o.store_id, s.name AS store_name, s.code AS store_code,
              o.status, o.total::text AS total, o.currency, o.placed_at, o.shipped_at,
              o.delivered_at, o.contact_id, ct.email::text AS email
         FROM orders o
         JOIN stores   s  ON s.id  = o.store_id
         JOIN contacts ct ON ct.id = o.contact_id
        WHERE o.tenant_id = $1 AND o.id = $2`,
      [tenantId, orderId],
    );
    if (order === undefined) throw notFound('Order', orderId);

    const enrollments = await query<Record<string, unknown>>(
      deps.db,
      `SELECT e.id, e.campaign_id, c.name AS campaign_name, e.status, e.stop_reason,
              e.enrolled_at, e.completed_at, e.stopped_at
         FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id
        WHERE e.tenant_id = $1 AND e.anchor_id = $2
        ORDER BY e.enrolled_at`,
      [tenantId, orderId],
    );

    const messages = await query<Record<string, unknown>>(
      deps.db,
      `SELECT q.id, q.campaign_id, q.campaign_message_id, q.channel, q.status,
              q.recipient_address, q.scheduled_at, q.sent_at, q.delivered_at,
              q.provider, q.provider_error_code, q.attempts, q.deferrals
         FROM message_queue q
        WHERE q.tenant_id = $1 AND (q.order_id = $2 OR q.anchor_id = $2)
        ORDER BY q.scheduled_at`,
      [tenantId, orderId],
    );

    const decisions = await query<Record<string, unknown>>(
      deps.db,
      `SELECT id::text AS id, stage, decision, reason_code, reason_detail, inputs, decided_at,
              campaign_id, campaign_message_id, message_queue_id
         FROM send_decisions
        WHERE tenant_id = $1 AND order_id = $2
        ORDER BY decided_at`,
      [tenantId, orderId],
    );

    return c.json({
      order: {
        ...toSummary(order),
        shippedAt: order.shipped_at?.toISOString() ?? null,
        deliveredAt: order.delivered_at?.toISOString() ?? null,
      },
      enrollments,
      messages,
      decisions,
    });
  });

  app.get('/orders', async (c) => {
    const tenantId = tenantOf(c);
    const { limit, offset } = pagination(c.req.query('limit'), c.req.query('offset'));
    const contactId = c.req.query('contactId');
    const rows = await query<OrderRow>(
      deps.db,
      `SELECT o.id, o.order_number, o.store_id, s.name AS store_name, s.code AS store_code,
              o.status, o.total::text AS total, o.currency, o.placed_at, o.contact_id,
              ct.email::text AS email
         FROM orders o
         JOIN stores   s  ON s.id  = o.store_id
         JOIN contacts ct ON ct.id = o.contact_id
        WHERE o.tenant_id = $1 AND ($2::uuid IS NULL OR o.contact_id = $2::uuid)
        ORDER BY o.placed_at DESC
        LIMIT $3 OFFSET $4`,
      [tenantId, contactId ?? null, limit, offset],
    );
    return c.json({ orders: rows.map(toSummary), page: { limit, offset } });
  });

  return app;
}
