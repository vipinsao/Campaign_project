import { Hono } from 'hono';
import { z } from 'zod';
import { activePause, consentState, query, queryOne, recordConsent } from '@campaign/core';
import { CampaignCategory, Channel } from '@campaign/shared';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { operatorOf, tenantOf } from '../middleware/context.ts';
import { notFound } from '../errors.ts';

const ConsentBody = z.object({
  channel: Channel,
  category: CampaignCategory.nullish(),
  state: z.enum(['opted_in', 'opted_out']),
  /** Where this came from. An operator recording somebody else's intent has to
   *  say so, because the ledger is evidence and 'signup' would be a lie. */
  source: z
    .enum(['signup', 'checkout', 'preference_center', 'import', 'operator', 'api'])
    .optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});

type ContactRow = {
  readonly id: string;
  readonly external_id: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly timezone: string | null;
  readonly locale: string;
  readonly tags: string[];
  readonly attributes: Record<string, unknown>;
  readonly first_order_at: Date | null;
  readonly last_order_at: Date | null;
  readonly order_count: number;
  readonly lifetime_value: string;
  readonly created_at: Date;
};

export function contactRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/contacts/:id', async (c) => {
    const tenantId = tenantOf(c);
    const contactId = c.req.param('id');
    const contact = await loadContact(deps, tenantId, contactId);

    const counts = await queryOne<{ queued: string; sent: string; cancelled: string }>(
      deps.db,
      `SELECT count(*) FILTER (WHERE status IN ('pending','processing'))::text AS queued,
              count(*) FILTER (WHERE sent_at IS NOT NULL)::text                 AS sent,
              count(*) FILTER (WHERE status = 'cancelled')::text                AS cancelled
         FROM message_queue WHERE tenant_id = $1 AND contact_id = $2`,
      [tenantId, contactId],
    );

    return c.json({
      contact: contactJson(contact),
      messages: {
        queued: Number(counts?.queued ?? '0'),
        sent: Number(counts?.sent ?? '0'),
        cancelled: Number(counts?.cancelled ?? '0'),
      },
    });
  });

  /**
   * The consent picture for one contact: the LEDGER, the resolved state, the
   * address-level suppressions and any pause.
   *
   * All four, because they answer different questions and a UI that shows only the
   * resolved state cannot explain itself. "Opted in" with mail still not going out
   * is the support ticket; the suppression row three lines down is the answer.
   */
  app.get('/contacts/:id/consent', async (c) => {
    const tenantId = tenantOf(c);
    const contactId = c.req.param('id');
    const contact = await loadContact(deps, tenantId, contactId);

    const ledger = await query<Record<string, unknown>>(
      deps.db,
      `SELECT id, channel, category, state, source, evidence, occurred_at
         FROM contact_consents
        WHERE tenant_id = $1 AND contact_id = $2
        ORDER BY occurred_at DESC, id DESC`,
      [tenantId, contactId],
    );

    const resolved: Record<string, Record<string, string | null>> = {};
    for (const channel of Channel.options) {
      const byCategory: Record<string, string | null> = {};
      for (const category of CampaignCategory.options) {
        byCategory[category] =
          (await consentState(deps.db, { tenantId, contactId, channel, category })) ?? null;
      }
      resolved[channel] = byCategory;
    }

    const addresses = [contact.email, contact.phone].filter((a): a is string => a !== null);
    const suppressions =
      addresses.length === 0
        ? []
        : await query<Record<string, unknown>>(
            deps.db,
            `SELECT channel, address, reason, expires_at, evidence, created_at
               FROM suppressions WHERE tenant_id = $1 AND address = ANY($2::text[])`,
            [tenantId, addresses],
          );

    const pauses = await Promise.all(
      Channel.options.map(async (channel) => ({
        channel,
        until:
          (await activePause(deps.db, { contactId, channel, clock: deps.clock }))?.upper.toISOString() ??
          null,
      })),
    );

    return c.json({
      contactId,
      // The ledger is append-only and is the audit trail. `resolved` is derived
      // from it by the same SQL function the send-time gate calls, so the screen
      // and the gate cannot disagree.
      ledger,
      resolved,
      suppressions,
      pauses,
    });
  });

  app.post('/contacts/:id/consent', async (c) => {
    const tenantId = tenantOf(c);
    const operator = operatorOf(c);
    const contactId = c.req.param('id');
    await loadContact(deps, tenantId, contactId);
    const body = ConsentBody.parse(await c.req.json<unknown>());

    // Append, never update. `contact_consents` carries a trigger that refuses
    // UPDATE and DELETE outright, so a correction is a new row and the previous
    // state survives — which is the entire point of a ledger.
    await recordConsent(deps.db, {
      tenantId,
      contactId,
      channel: body.channel,
      category: body.category ?? null,
      state: body.state,
      source: body.source ?? 'operator',
      evidence: { ...(body.evidence ?? {}), recordedBy: operator.userId },
      clock: deps.clock,
    });

    const state = await consentState(deps.db, {
      tenantId,
      contactId,
      channel: body.channel,
      category: body.category ?? 'promotional',
    });
    return c.json({ contactId, channel: body.channel, resolved: state ?? null }, 201);
  });

  return app;
}

async function loadContact(deps: ApiDeps, tenantId: string, contactId: string): Promise<ContactRow> {
  const row = await queryOne<ContactRow>(
    deps.db,
    `SELECT id, external_id, email::text AS email, phone, first_name, last_name, timezone,
            locale, tags, attributes, first_order_at, last_order_at, order_count,
            lifetime_value::text AS lifetime_value, created_at
       FROM contacts WHERE tenant_id = $1 AND id = $2`,
    [tenantId, contactId],
  );
  if (row === undefined) throw notFound('Contact', contactId);
  return row;
}

function contactJson(row: ContactRow): Record<string, unknown> {
  return {
    id: row.id,
    externalId: row.external_id,
    email: row.email,
    phone: row.phone,
    firstName: row.first_name,
    lastName: row.last_name,
    timezone: row.timezone,
    locale: row.locale,
    tags: row.tags,
    attributes: row.attributes,
    firstOrderAt: row.first_order_at?.toISOString() ?? null,
    lastOrderAt: row.last_order_at?.toISOString() ?? null,
    orderCount: row.order_count,
    lifetimeValue: row.lifetime_value,
    createdAt: row.created_at.toISOString(),
  };
}
