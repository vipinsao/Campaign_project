import { Hono } from 'hono';
import { z } from 'zod';
import { query, queryOne } from '@campaign/core';
import { Channel, EventType } from '@campaign/shared';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { tenantOf } from '../middleware/context.ts';
import { badRequest, conflict } from '../errors.ts';

const EventBody = z.object({
  type: EventType,
  contactId: z.uuid().optional(),
  /** Alternative to contactId, for integrators that only know the address. */
  email: z.string().max(320).optional(),
  phone: z.string().max(20).optional(),
  campaignId: z.uuid().optional(),
  messageQueueId: z.uuid().optional(),
  channel: Channel.optional(),
  occurredAt: z.iso.datetime().optional(),
  /**
   * The caller's own id for this event.
   *
   * Optional, and the response says whether it was used. Without one, a storefront
   * that retries a failed POST records the conversion twice, and `attributed_revenue`
   * is then permanently wrong with no evidence of how — the rollup is rebuilt from
   * this table, so a duplicate here is not a display bug, it is the number.
   */
  idempotencyKey: z.string().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const Batch = z.object({ events: z.array(EventBody).min(1).max(500) });

/**
 * Server-to-server event ingest.
 *
 * Authenticated by API key rather than by an operator session, because the caller
 * is a storefront hook with no browser and nobody to renew a token. The key names
 * its tenant and is verified against the server secret — see issueApiKey — so the
 * tenant of an ingested event is never taken from the body. A `tenantId` field in
 * a request body is a tenant any caller can claim.
 */
export function eventRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/events', async (c) => {
    const tenantId = tenantOf(c);
    const raw = await c.req.json<unknown>();
    const parsed = Array.isArray(raw)
      ? Batch.parse({ events: raw })
      : typeof raw === 'object' && raw !== null && 'events' in raw
        ? Batch.parse(raw)
        : Batch.parse({ events: [raw] });

    const results: {
      index: number;
      accepted: boolean;
      duplicate: boolean;
      contactId: string | null;
      reason?: string;
    }[] = [];

    for (const [index, event] of parsed.events.entries()) {
      const contactId = await resolveContact(deps, tenantId, event);
      if (contactId === undefined) {
        // Reported per event rather than failing the batch. One unrecognised
        // address in a batch of five hundred must not discard the other 499, and
        // the caller needs to know which one so it can be fixed rather than
        // retried forever.
        results.push({
          index,
          accepted: false,
          duplicate: false,
          contactId: null,
          reason: 'no_contact_matched',
        });
        continue;
      }

      const inserted = await queryOne<{ id: string }>(
        deps.db,
        `INSERT INTO message_events
           (tenant_id, message_queue_id, campaign_id, contact_id, event_type, channel,
            occurred_at, idempotency_key, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id::text AS id`,
        [
          tenantId,
          event.messageQueueId ?? null,
          event.campaignId ?? null,
          contactId,
          event.type,
          event.channel ?? null,
          event.occurredAt === undefined ? deps.clock.now() : new Date(event.occurredAt),
          event.idempotencyKey ?? null,
          JSON.stringify(event.metadata ?? {}),
        ],
      );

      results.push({
        index,
        accepted: inserted !== undefined,
        duplicate: inserted === undefined,
        contactId,
      });
    }

    const rejected = results.filter((r) => !r.accepted && !r.duplicate);
    // 207-style reporting in a 200: every event's fate is in the body. A blanket
    // 400 for a batch where one address was unknown makes the caller replay the
    // whole batch, and the 499 good events are then all duplicates.
    return c.json({
      accepted: results.filter((r) => r.accepted).length,
      duplicates: results.filter((r) => r.duplicate).length,
      rejected: rejected.length,
      results,
    });
  });

  return app;
}

async function resolveContact(
  deps: ApiDeps,
  tenantId: string,
  event: z.infer<typeof EventBody>,
): Promise<string | undefined> {
  if (event.contactId !== undefined) {
    const row = await queryOne<{ id: string }>(
      deps.db,
      `SELECT id FROM contacts WHERE tenant_id = $1 AND id = $2`,
      [tenantId, event.contactId],
    );
    return row?.id;
  }

  const address = event.email ?? event.phone;
  if (address === undefined) {
    throw badRequest(
      'no_contact_identifier',
      'Each event needs contactId, email or phone so it can be attributed to somebody.',
      { accepted: ['contactId', 'email', 'phone'] },
    );
  }

  // `contacts` is uniquely indexed on (tenant, email) and (tenant, phone), so this
  // cannot be ambiguous — unlike the order-number lookup in orders.ts, where the
  // uniqueness key includes the store and ambiguity is a real outcome.
  const rows = await query<{ id: string }>(
    deps.db,
    `SELECT id FROM contacts WHERE tenant_id = $1 AND (email = $2::citext OR phone = $2)`,
    [tenantId, address],
  );
  if (rows.length > 1) {
    throw conflict(
      'ambiguous_contact',
      `'${address}' matched ${rows.length} contacts. No event was recorded.`,
      { address, candidateIds: rows.map((r) => r.id) },
    );
  }
  return rows[0]?.id;
}
