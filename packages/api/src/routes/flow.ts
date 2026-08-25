import { Hono } from 'hono';
import {
  lineariseFlow,
  planMessageSync,
  query,
  queryOne,
  validateFlow,
  validateTemplate,
  withTransaction,
  type FlowGraph,
  type LinearisedMessage,
} from '@campaign/core';
import type { CampaignCategory } from '@campaign/shared';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { tenantOf } from '../middleware/context.ts';
import { badRequest, notFound } from '../errors.ts';

/**
 * The journey canvas endpoints.
 *
 * `PUT /campaigns/:id/flow` is validate → linearise → sync, in one transaction.
 * The sync is a diff by `node_id`: a message whose node has been removed is
 * DISABLED, never deleted, because queued rows reference `campaign_message_id`.
 * Deleting them would cascade away messages already scheduled to send, and the
 * operator's action that caused it would have been dragging a box on a canvas.
 */
export function flowRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/campaigns/:id/flow', async (c) => {
    const tenantId = tenantOf(c);
    const campaign = await queryOne<{ id: string; flow_definition: FlowGraph | null }>(
      deps.db,
      `SELECT id, flow_definition FROM campaigns WHERE id = $1 AND tenant_id = $2`,
      [c.req.param('id'), tenantId],
    );
    if (!campaign) throw notFound('campaign', c.req.param('id'));

    const graph = campaign.flow_definition ?? { nodes: [], edges: [] };
    return c.json({
      flow: graph,
      validation: validateFlow(graph),
      // What the graph would compile to, so the editor can show the operator the
      // ordered sequence next to the canvas without a second round trip.
      preview: graph.nodes.length > 0 ? lineariseFlow(graph) : [],
    });
  });

  /** Stateless validation, for the editor to call on every change. */
  app.post('/flow/validate', async (c) => {
    const body = await c.req.json<{ flow?: FlowGraph }>().catch(() => ({ flow: undefined }));
    if (!body.flow || !Array.isArray(body.flow.nodes) || !Array.isArray(body.flow.edges)) {
      throw badRequest('flow_invalid', 'Expected { flow: { nodes: [], edges: [] } }.');
    }
    const validation = validateFlow(body.flow);
    return c.json({ validation, preview: validation.valid ? lineariseFlow(body.flow) : [] });
  });

  app.put('/campaigns/:id/flow', async (c) => {
    const tenantId = tenantOf(c);
    const campaignId = c.req.param('id');

    const campaign = await queryOne<{ id: string; category: CampaignCategory }>(
      deps.db,
      `SELECT id, category FROM campaigns WHERE id = $1 AND tenant_id = $2`,
      [campaignId, tenantId],
    );
    if (!campaign) throw notFound('campaign', campaignId);

    const body = await c.req.json<{ flow?: FlowGraph }>().catch(() => ({ flow: undefined }));
    if (!body.flow) throw badRequest('flow_invalid', 'Expected { flow: { nodes, edges } }.');

    const validation = validateFlow(body.flow);
    if (!validation.valid) {
      // Every issue, not the first: an operator fixing one error at a time and
      // resubmitting learns about the next one only after another round trip.
      throw badRequest('flow_invalid', 'The journey has errors that must be fixed first.', {
        issues: validation.issues,
      });
    }

    const linearised = lineariseFlow(body.flow);

    // The templates have to pass the same save-time validation the messages editor
    // applies (I7), or the canvas becomes a way to smuggle a marketing message
    // with no opt-out past the check.
    const templateIssues = linearised.flatMap((message) => {
      const result = validateTemplate(
        {
          channel: message.channel,
          subject: message.subjectTemplate,
          body: message.bodyTemplate,
          html: message.htmlTemplate,
        },
        campaign.category,
      );
      return result.errors.map((e) => ({
        nodeId: message.nodeId,
        severity: 'error' as const,
        message: e.message,
      }));
    });

    if (templateIssues.length > 0) {
      throw badRequest('flow_invalid', 'One or more messages failed template validation.', {
        issues: templateIssues,
      });
    }

    const result = await withTransaction(deps.db, async (tx) => {
      const existing = await query<{ id: string; node_id: string | null }>(
        tx,
        `SELECT id, node_id FROM campaign_messages WHERE campaign_id = $1`,
        [campaignId],
      );
      const plan = planMessageSync(linearised, existing);

      // Sequence numbers are UNIQUE per campaign, so a straight update would
      // collide with a row still holding the number being moved into. Parking
      // them negative first sidesteps that without dropping the constraint.
      await tx.query(
        `UPDATE campaign_messages SET sequence_order = -sequence_order
          WHERE campaign_id = $1 AND sequence_order > 0`,
        [campaignId],
      );

      for (const message of plan.update) {
        await tx.query(
          `UPDATE campaign_messages
              SET channel = $3, sequence_order = $4, delay_minutes = $5, send_condition = $6,
                  branch_path = $7, subject_template = $8, body_template = $9,
                  html_template = $10, is_enabled = true, updated_at = now()
            WHERE campaign_id = $1 AND node_id = $2`,
          [campaignId, ...messageColumns(message)],
        );
      }

      for (const message of plan.create) {
        await tx.query(
          `INSERT INTO campaign_messages
             (tenant_id, campaign_id, node_id, channel, sequence_order, delay_minutes,
              send_condition, branch_path, subject_template, body_template, html_template)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [tenantId, campaignId, ...messageColumns(message)],
        );
      }

      if (plan.disable.length > 0) {
        await tx.query(
          `UPDATE campaign_messages SET is_enabled = false, updated_at = now()
            WHERE id = ANY($1::uuid[])`,
          [plan.disable],
        );
      }

      // Anything still negative belonged to no node in the new graph.
      await tx.query(
        `UPDATE campaign_messages
            SET sequence_order = -sequence_order, is_enabled = false
          WHERE campaign_id = $1 AND sequence_order < 0`,
        [campaignId],
      );

      await tx.query(
        `UPDATE campaigns SET flow_definition = $2, updated_at = now() WHERE id = $1`,
        [campaignId, JSON.stringify(body.flow)],
      );

      return {
        created: plan.create.length,
        updated: plan.update.length,
        disabled: plan.disable.length,
      };
    });

    return c.json({ validation, synced: result, messages: linearised });
  });

  return app;
}

/** The column order shared by the insert and the update above. */
function messageColumns(m: LinearisedMessage): unknown[] {
  return [
    m.nodeId,
    m.channel,
    m.sequenceOrder,
    m.delayMinutes,
    m.sendCondition,
    m.branchPath,
    m.subjectTemplate,
    m.bodyTemplate,
    m.htmlTemplate,
  ];
}
