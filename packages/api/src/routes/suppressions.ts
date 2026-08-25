import { Hono } from 'hono';
import { z } from 'zod';
import { addSuppression, query, queryOne, recordConsent, withTransaction } from '@campaign/core';
import { Channel, SuppressionReason } from '@campaign/shared';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { operatorOf, tenantOf } from '../middleware/context.ts';
import { badRequest, notFound } from '../errors.ts';
import { pagination } from './campaigns.ts';

const AddBody = z.object({
  channel: Channel,
  address: z.string().min(1).max(320),
  reason: SuppressionReason.optional(),
  /** ISO instant, or omitted for a permanent suppression. */
  expiresAt: z.iso.datetime().nullish(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The suppression list.
 *
 * Address level, never contact level — see migrations/0002. Contacts get merged,
 * re-imported and duplicated, and every one of those operations is a chance to
 * resurrect an address that asked never to be contacted again. Suppressing the
 * address survives all of it.
 */
export function suppressionRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/suppressions', async (c) => {
    const tenantId = tenantOf(c);
    const { limit, offset } = pagination(c.req.query('limit'), c.req.query('offset'));
    const channel = c.req.query('channel');
    const address = c.req.query('address');
    const reason = c.req.query('reason');

    const rows = await query<Record<string, unknown>>(
      deps.db,
      `SELECT id, channel, address, reason, expires_at, evidence, created_at,
              (expires_at IS NULL OR expires_at > $5) AS is_active
         FROM suppressions
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR channel = $2::text)
          AND ($3::text IS NULL OR address = $3::text)
          AND ($4::text IS NULL OR reason  = $4::text)
        ORDER BY created_at DESC
        LIMIT $6 OFFSET $7`,
      [tenantId, channel ?? null, address ?? null, reason ?? null, deps.clock.now(), limit, offset],
    );

    // `is_active` is computed in the SELECT rather than filtered by a WHERE, so the
    // list shows expired rows as expired instead of hiding them. An operator
    // looking for "why is this address blocked" needs to see that it was, and is
    // not any more; a filtered list makes that look like it never happened.
    return c.json({ suppressions: rows, page: { limit, offset } });
  });

  app.post('/suppressions', async (c) => {
    const tenantId = tenantOf(c);
    const operator = operatorOf(c);
    const body = AddBody.parse(await c.req.json<unknown>());

    await addSuppression(deps.db, {
      tenantId,
      channel: body.channel,
      address: body.address,
      reason: body.reason ?? 'manual',
      expiresAt:
        body.expiresAt === undefined || body.expiresAt === null ? null : new Date(body.expiresAt),
      evidence: { ...(body.evidence ?? {}), addedBy: operator.userId },
    });

    const row = await queryOne<Record<string, unknown>>(
      deps.db,
      `SELECT id, channel, address, reason, expires_at, evidence, created_at
         FROM suppressions WHERE tenant_id = $1 AND channel = $2 AND address = $3`,
      [tenantId, body.channel, body.address],
    );
    if (row === undefined) throw notFound('Suppression');

    // A second STOP from an already-suppressed address is not an error and must
    // not overwrite the original reason — the first reason is the one with the
    // evidence behind it. `addSuppression` does ON CONFLICT DO NOTHING; this
    // response tells the caller which of the two happened.
    return c.json(
      { suppression: row, createdNow: row['reason'] === (body.reason ?? 'manual') },
      201,
    );
  });

  /**
   * Removing a suppression is a RESUBSCRIBE, and it writes to the ledger.
   *
   * Deleting the row alone would let mail start flowing again with no record of
   * who authorised it. `contact_consents` is the audit trail and `suppressions` is
   * an operational cache over it, so lifting the block without appending the
   * evidence leaves the system unable to answer the one question that matters when
   * the complaint arrives: who turned this back on, and on what basis?
   */
  app.delete('/suppressions', async (c) => {
    const tenantId = tenantOf(c);
    const operator = operatorOf(c);
    const channel = c.req.query('channel');
    const address = c.req.query('address');

    if (channel === undefined || address === undefined) {
      throw badRequest(
        'missing_suppression_key',
        'Pass ?channel= and ?address=. A suppression is identified by the address, not by a row id.',
        { channel: channel ?? null, address: address ?? null },
      );
    }
    const parsedChannel = Channel.safeParse(channel);
    if (!parsedChannel.success) {
      throw badRequest('unknown_channel', `'${channel}' is not a channel.`, {
        channel,
        known: Channel.options,
      });
    }

    const removed = await withTransaction(deps.db, async (tx) => {
      const deleted = await queryOne<{ id: string; reason: string }>(
        tx,
        `DELETE FROM suppressions
          WHERE tenant_id = $1 AND channel = $2 AND address = $3
        RETURNING id, reason`,
        [tenantId, parsedChannel.data, address],
      );
      if (deleted === undefined) return undefined;

      const contact = await queryOne<{ id: string }>(
        tx,
        `SELECT id FROM contacts
          WHERE tenant_id = $1 AND (email = $2::citext OR phone = $2) LIMIT 1`,
        [tenantId, address],
      );
      if (contact !== undefined) {
        await recordConsent(tx, {
          tenantId,
          contactId: contact.id,
          channel: parsedChannel.data,
          category: null,
          state: 'opted_in',
          source: 'operator',
          evidence: {
            action: 'suppression_removed',
            previousReason: deleted.reason,
            removedBy: operator.userId,
            address,
          },
          clock: deps.clock,
        });
      }
      return deleted;
    });

    if (removed === undefined) throw notFound('Suppression');
    return c.json({ removed: true, address, channel: parsedChannel.data });
  });

  return app;
}
