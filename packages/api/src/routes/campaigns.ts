import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  enqueue,
  query,
  queryOne,
  recordConsent,
  recordDecision,
  withTransaction,
} from '@campaign/core';
import { AudienceDefinition, CampaignCategory, Channel, TriggerType } from '@campaign/shared';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { operatorOf, tenantOf } from '../middleware/context.ts';
import { badRequest, conflict, notFound, unprocessable } from '../errors.ts';
import {
  campaignJson,
  loadCampaign,
  loadCampaignMessages,
  messageJson,
  snapshotCampaign,
  validateForActivation,
  CAMPAIGN_COLUMNS,
  type CampaignMessageRow,
  type CampaignRow,
} from '../services/campaigns.ts';
import { renderCampaignMessage } from '../services/preview.ts';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const CampaignBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).nullish(),
  category: CampaignCategory,
  triggerType: TriggerType,
  triggerConfig: z.record(z.string(), z.unknown()).optional(),
  channels: z.array(Channel).min(1).optional(),
  audience: AudienceDefinition.optional(),
  sendWindowStart: z.string().regex(TIME).nullish(),
  sendWindowEnd: z.string().regex(TIME).nullish(),
  sendDays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  oneTimePerContact: z.boolean().optional(),
});

const CampaignPatch = CampaignBody.partial();

const MessageBody = z.object({
  channel: Channel,
  sequenceOrder: z.number().int().min(1),
  delayAnchor: z.enum(['trigger', 'previous', 'delivery']).optional(),
  delayMinutes: z.number().int().min(0).optional(),
  sendCondition: z
    .enum([
      'always',
      'opened_previous',
      'not_opened_previous',
      'clicked_previous',
      'not_clicked_previous',
      'replied',
      'not_replied',
    ])
    .optional(),
  subjectTemplate: z.string().max(500).nullish(),
  htmlTemplate: z.string().max(500_000).nullish(),
  bodyTemplate: z.string().min(1).max(500_000),
  previewText: z.string().max(500).nullish(),
  nodeId: z.string().max(120).nullish(),
  branchPath: z.enum(['yes', 'no']).nullish(),
  isEnabled: z.boolean().optional(),
});

const MessagePatch = MessageBody.partial();

const TestSendBody = z.object({
  to: z.string().min(3).max(320),
  channel: Channel.optional(),
  campaignMessageId: z.uuid().optional(),
  /** A real contact to draw merge values from, so the test shows real copy. */
  contactId: z.uuid().optional(),
  orderId: z.uuid().optional(),
});

const PreviewBody = z.object({
  campaignMessageId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  orderId: z.uuid().optional(),
});

/**
 * The tag that marks a contact as an internal test recipient.
 *
 * It exists because of a genuine tension in `/test-send`: the endpoint must refuse
 * to mail a real customer, and it must also be usable more than once — but the
 * queue row it creates needs a `contact_id`, so the second test send would find
 * the contact the first one created and refuse itself. Tagging the row
 * distinguishes "an address this system created to test with" from "an address
 * belonging to somebody who bought something", which is the distinction the
 * refusal is actually about.
 */
const TEST_RECIPIENT_TAG = '__test_recipient';

export function campaignRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ── list / create ─────────────────────────────────────────────────────────
  app.get('/campaigns', async (c) => {
    const tenantId = tenantOf(c);
    const status = c.req.query('status');
    const { limit, offset } = pagination(c.req.query('limit'), c.req.query('offset'));

    const rows = await query<CampaignRow>(
      deps.db,
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns
        WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2::text)
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [tenantId, status ?? null, limit, offset],
    );
    const total = await queryOne<{ n: string }>(
      deps.db,
      `SELECT count(*)::text AS n FROM campaigns
        WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2::text)`,
      [tenantId, status ?? null],
    );

    return c.json({
      campaigns: rows.map(campaignJson),
      page: { limit, offset, total: Number(total?.n ?? '0') },
    });
  });

  app.post('/campaigns', async (c) => {
    const tenantId = tenantOf(c);
    const operator = operatorOf(c);
    const body = CampaignBody.parse(await c.req.json<unknown>());

    const row = await queryOne<CampaignRow>(
      deps.db,
      `INSERT INTO campaigns
         (tenant_id, name, description, category, trigger_type, trigger_config, channels,
          audience, send_window_start, send_window_end, send_days, one_time_per_contact, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::time,$10::time,$11,$12,$13)
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [
        tenantId,
        body.name,
        body.description ?? null,
        body.category,
        body.triggerType,
        JSON.stringify(body.triggerConfig ?? {}),
        body.channels ?? ['email'],
        JSON.stringify(body.audience ?? {}),
        body.sendWindowStart ?? null,
        body.sendWindowEnd ?? null,
        body.sendDays ?? [0, 1, 2, 3, 4, 5, 6],
        body.oneTimePerContact ?? false,
        operator.userId,
      ],
    );
    if (row === undefined) throw new Error('campaign insert returned no row');
    return c.json({ campaign: campaignJson(row) }, 201);
  });

  // ── read / update / archive ───────────────────────────────────────────────
  app.get('/campaigns/:id', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const messages = await loadCampaignMessages(deps.db, campaign.id);
    return c.json({ campaign: campaignJson(campaign), messages: messages.map(messageJson) });
  });

  app.patch('/campaigns/:id', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const body = CampaignPatch.parse(await c.req.json<unknown>());

    const row = await queryOne<CampaignRow>(
      deps.db,
      `UPDATE campaigns SET
          name        = COALESCE($3, name),
          description = CASE WHEN $4::boolean THEN $5 ELSE description END,
          category    = COALESCE($6, category),
          trigger_type   = COALESCE($7, trigger_type),
          trigger_config = COALESCE($8::jsonb, trigger_config),
          channels    = COALESCE($9::text[], channels),
          audience    = COALESCE($10::jsonb, audience),
          send_window_start = CASE WHEN $11::boolean THEN $12::time ELSE send_window_start END,
          send_window_end   = CASE WHEN $11::boolean THEN $13::time ELSE send_window_end END,
          send_days   = COALESCE($14::int[], send_days),
          one_time_per_contact = COALESCE($15, one_time_per_contact),
          updated_at  = $16
        WHERE tenant_id = $1 AND id = $2
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [
        tenantId,
        campaign.id,
        body.name ?? null,
        'description' in body,
        body.description ?? null,
        body.category ?? null,
        body.triggerType ?? null,
        body.triggerConfig === undefined ? null : JSON.stringify(body.triggerConfig),
        body.channels ?? null,
        body.audience === undefined ? null : JSON.stringify(body.audience),
        'sendWindowStart' in body || 'sendWindowEnd' in body,
        body.sendWindowStart ?? null,
        body.sendWindowEnd ?? null,
        body.sendDays ?? null,
        body.oneTimePerContact ?? null,
        deps.clock.now(),
      ],
    );
    if (row === undefined) throw notFound('Campaign', campaign.id);
    return c.json({ campaign: campaignJson(row) });
  });

  /**
   * Archive, never delete.
   *
   * The campaign is referenced by `message_queue`, `message_events` and
   * `send_decisions`, all of which cascade. Deleting a campaign would therefore
   * silently erase the record of every message it ever sent and every decision it
   * ever made — including the opt-out evidence for people who unsubscribed from
   * it. Archiving keeps the history and takes the campaign out of every list.
   */
  app.delete('/campaigns/:id', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const row = await queryOne<CampaignRow>(
      deps.db,
      `UPDATE campaigns SET status = 'archived', updated_at = $3
        WHERE tenant_id = $1 AND id = $2 RETURNING ${CAMPAIGN_COLUMNS}`,
      [tenantId, campaign.id, deps.clock.now()],
    );
    if (row === undefined) throw notFound('Campaign', campaign.id);
    return c.json({ campaign: campaignJson(row) });
  });

  // ── activate / pause / duplicate ──────────────────────────────────────────
  app.post('/campaigns/:id/activate', async (c) => {
    const tenantId = tenantOf(c);
    const operator = operatorOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const messages = await loadCampaignMessages(deps.db, campaign.id);

    const failures = validateForActivation(campaign, messages);
    if (failures.length > 0) {
      // Every failure, in `details`. An operator who has to fix one rejection per
      // round trip stops after the third and mails the campaign from their laptop.
      throw unprocessable(
        'campaign_not_activatable',
        `This campaign cannot be activated: ${failures.length} problem(s) must be fixed first.`,
        { failures },
      );
    }

    const result = await withTransaction(deps.db, async (tx) => {
      const version = await snapshotCampaign(tx, {
        tenantId,
        campaignId: campaign.id,
        activatedBy: operator.userId,
        reason: 'activate',
      });
      const row = await queryOne<CampaignRow>(
        tx,
        `UPDATE campaigns SET status = 'active', active_version_id = $3, updated_at = $4
          WHERE tenant_id = $1 AND id = $2 RETURNING ${CAMPAIGN_COLUMNS}`,
        [tenantId, campaign.id, version.id, deps.clock.now()],
      );
      if (row === undefined) throw notFound('Campaign', campaign.id);
      return { row, version };
    });

    return c.json({
      campaign: campaignJson(result.row),
      version: { id: result.version.id, version: result.version.version },
    });
  });

  /**
   * Pause holds; it does not cancel.
   *
   * The `campaignStillActive` gate treats a paused campaign as RETRYABLE, so
   * messages already in the queue are deferred rather than destroyed. An operator
   * who pauses to fix a typo and resumes an hour later must not discover that
   * pausing threw away everything in flight.
   */
  app.post('/campaigns/:id/pause', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    if (campaign.status === 'archived') {
      throw conflict('campaign_archived', 'An archived campaign cannot be paused.', {
        campaignId: campaign.id,
        status: campaign.status,
      });
    }
    const row = await queryOne<CampaignRow>(
      deps.db,
      `UPDATE campaigns SET status = 'paused', updated_at = $3
        WHERE tenant_id = $1 AND id = $2 RETURNING ${CAMPAIGN_COLUMNS}`,
      [tenantId, campaign.id, deps.clock.now()],
    );
    if (row === undefined) throw notFound('Campaign', campaign.id);

    const held = await queryOne<{ n: string }>(
      deps.db,
      `SELECT count(*)::text AS n FROM message_queue
        WHERE tenant_id = $1 AND campaign_id = $2 AND status IN ('pending','processing')`,
      [tenantId, campaign.id],
    );
    return c.json({
      campaign: campaignJson(row),
      heldMessages: Number(held?.n ?? '0'),
      note: 'Queued messages are held, not cancelled. Resuming releases them.',
    });
  });

  /**
   * Duplicate copies the definition and nothing else.
   *
   * The copy starts as a DRAFT with no version, no enrolments and no history. A
   * duplicate that inherited `status = 'active'` would begin enrolling contacts
   * the instant it was created, which is never what "duplicate" means to the
   * person who clicked it.
   */
  app.post('/campaigns/:id/duplicate', async (c) => {
    const tenantId = tenantOf(c);
    const operator = operatorOf(c);
    const source = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const body = z
      .object({ name: z.string().min(1).max(200).optional() })
      .parse(await c.req.json<unknown>().catch(() => ({})));

    const created = await withTransaction(deps.db, async (tx) => {
      const row = await queryOne<CampaignRow>(
        tx,
        `INSERT INTO campaigns
           (tenant_id, name, description, category, trigger_type, trigger_config, channels,
            status, audience, send_window_start, send_window_end, send_days,
            one_time_per_contact, flow_definition, created_by)
         SELECT tenant_id, $3, description, category, trigger_type, trigger_config, channels,
                'draft', audience, send_window_start, send_window_end, send_days,
                one_time_per_contact, flow_definition, $4
           FROM campaigns WHERE tenant_id = $1 AND id = $2
         RETURNING ${CAMPAIGN_COLUMNS}`,
        [tenantId, source.id, body.name ?? `${source.name} (copy)`, operator.userId],
      );
      if (row === undefined) throw notFound('Campaign', source.id);

      await tx.query(
        `INSERT INTO campaign_messages
           (tenant_id, campaign_id, channel, sequence_order, delay_anchor, delay_minutes,
            send_condition, subject_template, html_template, body_template, preview_text,
            node_id, branch_path, is_enabled)
         SELECT tenant_id, $2, channel, sequence_order, delay_anchor, delay_minutes,
                send_condition, subject_template, html_template, body_template, preview_text,
                node_id, branch_path, is_enabled
           FROM campaign_messages WHERE campaign_id = $1`,
        [source.id, row.id],
      );
      await tx.query(
        `INSERT INTO campaign_stop_conditions (tenant_id, campaign_id, condition_type, config, is_active)
         SELECT tenant_id, $2, condition_type, config, is_active
           FROM campaign_stop_conditions WHERE campaign_id = $1`,
        [source.id, row.id],
      );
      // Goals are copied WITHOUT their measurements. A duplicated campaign that
      // inherited the original's measured open rate would show a result before it
      // had sent anything, and `campaign_goals` distinguishes "not measured yet"
      // from "measured, and it is zero" precisely so that cannot happen.
      await tx.query(
        `INSERT INTO campaign_goals (tenant_id, campaign_id, metric, label, target_value, unit)
         SELECT tenant_id, $2, metric, label, target_value, unit
           FROM campaign_goals WHERE campaign_id = $1`,
        [source.id, row.id],
      );
      return row;
    });

    const messages = await loadCampaignMessages(deps.db, created.id);
    return c.json({ campaign: campaignJson(created), messages: messages.map(messageJson) }, 201);
  });

  // ── preview ───────────────────────────────────────────────────────────────
  app.post('/campaigns/:id/preview', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const body = PreviewBody.parse(await c.req.json<unknown>().catch(() => ({})));
    const messages = await loadCampaignMessages(deps.db, campaign.id);
    const message = pickMessage(messages, body.campaignMessageId, undefined);
    const preview = await renderCampaignMessage(deps, deps.db, {
      tenantId,
      campaign,
      message,
      contactId: body.contactId ?? null,
      orderId: body.orderId ?? null,
    });

    return c.json({ campaignMessageId: message.id, channel: message.channel, preview });
  });

  // ── test send ─────────────────────────────────────────────────────────────
  /**
   * A test that mails a real customer is not a test.
   *
   * The refusal below is the point of this endpoint. Somebody typing their own
   * address into a test-send box and fat-fingering a character that lands on a
   * customer's address has sent an unfinished draft to a stranger, and there is no
   * recall. Checking the address against the tenant's contacts costs one indexed
   * query and makes that particular mistake impossible.
   *
   * What this endpoint does NOT do is send. It enqueues, and the worker sends —
   * through `deliverClaimed`, the single send path, with the full gate chain in
   * front of it. An endpoint that called a provider directly would be a second
   * send path with no gates, which is invariant I1, and tests/unit/architecture
   * .test.ts fails the build if one appears.
   */
  app.post('/campaigns/:id/test-send', async (c) => {
    const tenantId = tenantOf(c);
    const operator = operatorOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const body = TestSendBody.parse(await c.req.json<unknown>());
    const messages = await loadCampaignMessages(deps.db, campaign.id);
    const message = pickMessage(messages, body.campaignMessageId, body.channel);
    const to = body.to.trim();

    const collisions = await query<{ id: string; tags: string[] }>(
      deps.db,
      `SELECT id, tags FROM contacts
        WHERE tenant_id = $1 AND (email = $2::citext OR phone = $2)`,
      [tenantId, to],
    );
    const real = collisions.filter((row) => !row.tags.includes(TEST_RECIPIENT_TAG));
    if (real.length > 0) {
      throw conflict(
        'test_send_would_reach_a_contact',
        `${to} belongs to a contact in this tenant. A test send to a real customer is not a test.`,
        { to, matchedContactIds: real.map((r) => r.id) },
      );
    }

    const result = await withTransaction(deps.db, async (tx) => {
      const existing = collisions[0];
      const testContact =
        existing ??
        (await queryOne<{ id: string }>(
          tx,
          `INSERT INTO contacts (tenant_id, email, phone, tags, first_name)
           VALUES ($1, $2, $3, ARRAY[$4]::text[], 'Test')
           RETURNING id`,
          [
            tenantId,
            message.channel === 'email' ? to : null,
            message.channel === 'sms' ? to : null,
            TEST_RECIPIENT_TAG,
          ],
        ));
      if (testContact === undefined) throw new Error('test recipient could not be created');

      // The operator asking for a test send IS the consent for it; recording that
      // as `source: 'operator'` keeps the ledger honest about where it came from
      // rather than inventing a signup that never happened.
      await recordConsent(tx, {
        tenantId,
        contactId: testContact.id,
        channel: message.channel,
        category: campaign.category,
        state: 'opted_in',
        source: 'operator',
        evidence: { reason: 'test_send', requestedBy: operator.userId },
        clock: deps.clock,
      });

      const versionId =
        campaign.active_version_id ??
        (
          await snapshotCampaign(tx, {
            tenantId,
            campaignId: campaign.id,
            activatedBy: operator.userId,
            reason: 'test_send',
          })
        ).id;

      // A fresh anchor per test send. `message_queue.dedup_key` is generated from
      // (campaign, message, contact, anchor), so without a new anchor the second
      // test send of the same message would be silently deduplicated against the
      // first — which is I4 working exactly as designed and being exactly wrong
      // for this one caller.
      const anchorId = randomUUID();
      const enrollment = await queryOne<{ id: string }>(
        tx,
        `INSERT INTO enrollments
           (tenant_id, campaign_id, campaign_version_id, contact_id, anchor_type, anchor_id)
         VALUES ($1,$2,$3,$4,'manual',$5) RETURNING id`,
        [tenantId, campaign.id, versionId, testContact.id, anchorId],
      );
      if (enrollment === undefined) throw new Error('test enrolment could not be created');

      const rendered = await renderCampaignMessage(deps, tx, {
        tenantId,
        campaign,
        message,
        contactId: body.contactId ?? testContact.id,
        orderId: body.orderId ?? null,
      });

      const queued = await enqueue(tx, {
        tenantId,
        enrollmentId: enrollment.id,
        campaignId: campaign.id,
        campaignVersionId: versionId,
        campaignMessageId: message.id,
        contactId: testContact.id,
        anchorId,
        channel: message.channel,
        recipientAddress: to,
        renderedSubject: rendered.subject,
        renderedBody: rendered.body,
        renderedHtml: rendered.html,
        scheduledAt: deps.clock.now(),
      });

      await recordDecision(tx, {
        tenantId,
        stage: 'enrollment',
        decision: 'proceed',
        reasonCode: 'enqueued',
        detail: `Test send of message ${message.sequence_order} to ${to}, requested by an operator.`,
        campaignId: campaign.id,
        campaignMessageId: message.id,
        contactId: testContact.id,
        ...(queued === undefined ? {} : { messageQueueId: queued.id }),
        inputs: { testSend: true, requestedBy: operator.userId, to },
      });

      return { queued, rendered, contactId: testContact.id };
    });

    // Stated rather than hidden. The gate chain is not bypassed for test sends, so
    // a draft or paused campaign's test message will be held or cancelled at send
    // time — and an operator who is not told that concludes the feature is broken.
    const warnings =
      campaign.status === 'active'
        ? []
        : [
            `The campaign is '${campaign.status}'. The send-time gate holds or cancels ` +
              'messages for campaigns that are not active, so this test will not be delivered ' +
              'until the campaign is activated.',
          ];

    return c.json(
      {
        queuedMessageId: result.queued?.id ?? null,
        to,
        campaignMessageId: message.id,
        testContactId: result.contactId,
        rendered: {
          subject: result.rendered.subject,
          body: result.rendered.body,
          html: result.rendered.html,
        },
        warnings,
      },
      202,
    );
  });

  // ── campaign messages CRUD ────────────────────────────────────────────────
  app.get('/campaigns/:id/messages', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const messages = await loadCampaignMessages(deps.db, campaign.id);
    return c.json({ messages: messages.map(messageJson) });
  });

  app.post('/campaigns/:id/messages', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const body = MessageBody.parse(await c.req.json<unknown>());

    const row = await queryOne<Record<string, unknown>>(
      deps.db,
      `INSERT INTO campaign_messages
         (tenant_id, campaign_id, channel, sequence_order, delay_anchor, delay_minutes,
          send_condition, subject_template, html_template, body_template, preview_text,
          node_id, branch_path, is_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        tenantId,
        campaign.id,
        body.channel,
        body.sequenceOrder,
        body.delayAnchor ?? 'trigger',
        body.delayMinutes ?? 0,
        body.sendCondition ?? 'always',
        body.subjectTemplate ?? null,
        body.htmlTemplate ?? null,
        body.bodyTemplate,
        body.previewText ?? null,
        body.nodeId ?? null,
        body.branchPath ?? null,
        body.isEnabled ?? true,
      ],
    );
    if (row === undefined) throw new Error('campaign_messages insert returned no row');

    const messages = await loadCampaignMessages(deps.db, campaign.id);
    const created = messages.find((m) => m.id === row['id']);
    if (created === undefined) throw notFound('Campaign message');
    return c.json({ message: messageJson(created) }, 201);
  });

  app.patch('/campaigns/:id/messages/:messageId', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const body = MessagePatch.parse(await c.req.json<unknown>());
    const messageId = c.req.param('messageId');

    await deps.db.query(
      `UPDATE campaign_messages SET
         channel        = COALESCE($4, channel),
         sequence_order = COALESCE($5, sequence_order),
         delay_anchor   = COALESCE($6, delay_anchor),
         delay_minutes  = COALESCE($7, delay_minutes),
         send_condition = COALESCE($8, send_condition),
         subject_template = CASE WHEN $9::boolean  THEN $10 ELSE subject_template END,
         html_template    = CASE WHEN $11::boolean THEN $12 ELSE html_template END,
         body_template  = COALESCE($13, body_template),
         preview_text   = CASE WHEN $14::boolean THEN $15 ELSE preview_text END,
         node_id        = CASE WHEN $16::boolean THEN $17 ELSE node_id END,
         branch_path    = CASE WHEN $18::boolean THEN $19 ELSE branch_path END,
         is_enabled     = COALESCE($20, is_enabled),
         updated_at     = $21
       WHERE tenant_id = $1 AND campaign_id = $2 AND id = $3`,
      [
        tenantId,
        campaign.id,
        messageId,
        body.channel ?? null,
        body.sequenceOrder ?? null,
        body.delayAnchor ?? null,
        body.delayMinutes ?? null,
        body.sendCondition ?? null,
        'subjectTemplate' in body,
        body.subjectTemplate ?? null,
        'htmlTemplate' in body,
        body.htmlTemplate ?? null,
        body.bodyTemplate ?? null,
        'previewText' in body,
        body.previewText ?? null,
        'nodeId' in body,
        body.nodeId ?? null,
        'branchPath' in body,
        body.branchPath ?? null,
        body.isEnabled ?? null,
        deps.clock.now(),
      ],
    );

    const messages = await loadCampaignMessages(deps.db, campaign.id);
    const updated = messages.find((m) => m.id === messageId);
    if (updated === undefined) throw notFound('Campaign message', messageId);
    return c.json({ message: messageJson(updated) });
  });

  app.delete('/campaigns/:id/messages/:messageId', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await loadCampaign(deps.db, tenantId, c.req.param('id'));
    const messageId = c.req.param('messageId');

    // Queued rows reference this message, so a delete would cascade and take the
    // record of what was sent with it. Disabling keeps both the history and the
    // operator's intent.
    const queued = await queryOne<{ n: string }>(
      deps.db,
      `SELECT count(*)::text AS n FROM message_queue
        WHERE tenant_id = $1 AND campaign_message_id = $2`,
      [tenantId, messageId],
    );
    if (Number(queued?.n ?? '0') > 0) {
      const row = await queryOne<{ id: string }>(
        deps.db,
        `UPDATE campaign_messages SET is_enabled = false, updated_at = $4
          WHERE tenant_id = $1 AND campaign_id = $2 AND id = $3 RETURNING id`,
        [tenantId, campaign.id, messageId, deps.clock.now()],
      );
      if (row === undefined) throw notFound('Campaign message', messageId);
      return c.json({
        deleted: false,
        disabled: true,
        note: 'This message has already produced queued or sent rows, so it was disabled rather than deleted; deleting it would erase the record of what was sent.',
      });
    }

    const row = await queryOne<{ id: string }>(
      deps.db,
      `DELETE FROM campaign_messages
        WHERE tenant_id = $1 AND campaign_id = $2 AND id = $3 RETURNING id`,
      [tenantId, campaign.id, messageId],
    );
    if (row === undefined) throw notFound('Campaign message', messageId);
    return c.json({ deleted: true, disabled: false });
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pickMessage(
  messages: readonly CampaignMessageRow[],
  requested: string | undefined,
  channel: string | undefined,
): CampaignMessageRow {
  if (requested !== undefined) {
    const found = messages.find((m) => m.id === requested);
    if (found === undefined) throw notFound('Campaign message', requested);
    return found;
  }
  const candidates = messages.filter(
    (m) => m.is_enabled && (channel === undefined || m.channel === channel),
  );
  const first = candidates[0];
  if (first === undefined) {
    throw badRequest(
      'no_message_to_render',
      'This campaign has no enabled message to render. Add one, or name a campaignMessageId.',
      { channel: channel ?? null },
    );
  }
  return first;
}

export function pagination(
  limitRaw: string | undefined,
  offsetRaw: string | undefined,
): { limit: number; offset: number } {
  // Capped rather than trusted. An unbounded `limit` is a denial-of-service
  // primitive that any authenticated client can reach for by accident.
  const limit = Math.min(Math.max(Number(limitRaw ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(offsetRaw ?? 0) || 0, 0);
  return { limit, offset };
}

export async function tenantNameOf(deps: ApiDeps, tenantId: string): Promise<string> {
  const row = await queryOne<{ name: string }>(deps.db, `SELECT name FROM tenants WHERE id = $1`, [
    tenantId,
  ]);
  return row?.name ?? '';
}
