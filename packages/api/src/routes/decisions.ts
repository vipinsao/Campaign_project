import { Hono } from 'hono';
import { query } from '@campaign/core';
import { REASON_CODES } from '@campaign/shared';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { tenantOf } from '../middleware/context.ts';
import { badRequest } from '../errors.ts';
import { pagination } from './campaigns.ts';

/**
 * The decision log  (I14). This endpoint IS the feature.
 *
 * "Why didn't Jane get the review request?" answered as
 * `suppressed_sms_stop — Address is suppressed: STOP reply received` with the
 * evaluated inputs attached, rather than as a shrug and an invitation to read the
 * source or wait for it to happen again with a log line added.
 *
 * Every row carries a reason code from a CLOSED vocabulary. `'error'` is not a
 * reason code and neither is `'failed'`; a new skip path gets a new entry in
 * REASON_CODES, which is deliberate friction, because the alternative is a
 * decision log full of free text nobody can group by.
 */
export function decisionRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/decisions', async (c) => {
    const tenantId = tenantOf(c);
    const { limit, offset } = pagination(c.req.query('limit'), c.req.query('offset'));
    const contactId = c.req.query('contactId');
    const orderId = c.req.query('orderId');
    const campaignId = c.req.query('campaignId');
    const reasonCode = c.req.query('reasonCode');
    const decision = c.req.query('decision');

    if (
      contactId === undefined &&
      orderId === undefined &&
      campaignId === undefined &&
      reasonCode === undefined
    ) {
      // An unfiltered scan of this table is never the question anybody actually
      // has, and it is the single largest table in the schema. Requiring one
      // dimension keeps the query on an index instead of a sequential scan that
      // takes the database down at exactly the moment someone is investigating.
      throw badRequest(
        'decisions_filter_required',
        'Pass at least one of contactId, orderId, campaignId or reasonCode.',
        { accepted: ['contactId', 'orderId', 'campaignId', 'reasonCode'] },
      );
    }

    const rows = await query<Record<string, unknown>>(
      deps.db,
      `SELECT d.id::text AS id, d.stage, d.decision, d.reason_code, d.reason_detail,
              d.inputs, d.decided_at, d.campaign_id, d.campaign_message_id,
              d.contact_id, d.order_id, d.message_queue_id
         FROM send_decisions d
        WHERE d.tenant_id = $1
          AND ($2::uuid IS NULL OR d.contact_id  = $2::uuid)
          AND ($3::uuid IS NULL OR d.order_id    = $3::uuid)
          AND ($4::uuid IS NULL OR d.campaign_id = $4::uuid)
          AND ($5::text IS NULL OR d.reason_code = $5::text)
          AND ($6::text IS NULL OR d.decision    = $6::text)
        ORDER BY d.decided_at DESC, d.id DESC
        LIMIT $7 OFFSET $8`,
      [
        tenantId,
        contactId ?? null,
        orderId ?? null,
        campaignId ?? null,
        reasonCode ?? null,
        decision ?? null,
        limit,
        offset,
      ],
    );

    // The canned sentence for every code that appears, so a client can render the
    // log without maintaining its own copy of the vocabulary — a copy that would
    // drift the first time a code was added on the server.
    const glossary: Record<string, string> = {};
    for (const row of rows) {
      const code = row['reason_code'];
      if (typeof code !== 'string') continue;
      const sentence = (REASON_CODES as Record<string, string | undefined>)[code];
      if (sentence !== undefined) glossary[code] = sentence;
    }

    return c.json({ decisions: rows, glossary, page: { limit, offset } });
  });

  return app;
}
