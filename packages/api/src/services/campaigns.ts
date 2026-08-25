import type { PoolClient } from 'pg';
import type { Db } from '@campaign/core';
import { compileAudience, query, queryOne, validateTemplate } from '@campaign/core';
import { AudienceDefinition } from '@campaign/shared';
import type { CampaignCategory, CampaignStatus, Channel, TriggerType } from '@campaign/shared';
import { notFound } from '../errors.ts';

/**
 * Campaign reads and the activation snapshot.
 *
 * Every function here takes `tenantId` as its first real argument, and every query
 * has `tenant_id = $1` in its WHERE clause. There is no "current tenant" to
 * forget: the argument is required by the signature, so a handler that fails to
 * scope its read does not compile.
 */

export type CampaignRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: CampaignCategory;
  readonly trigger_type: TriggerType;
  readonly trigger_config: Record<string, unknown>;
  readonly channels: Channel[];
  readonly status: CampaignStatus;
  readonly audience: Record<string, unknown>;
  readonly send_window_start: string | null;
  readonly send_window_end: string | null;
  readonly send_days: number[];
  readonly one_time_per_contact: boolean;
  readonly active_version_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
};

export type CampaignMessageRow = {
  readonly id: string;
  readonly campaign_id: string;
  readonly channel: Channel;
  readonly sequence_order: number;
  readonly delay_anchor: 'trigger' | 'previous' | 'delivery';
  readonly delay_minutes: number;
  readonly send_condition: string;
  readonly subject_template: string | null;
  readonly html_template: string | null;
  readonly body_template: string;
  readonly preview_text: string | null;
  readonly node_id: string | null;
  readonly branch_path: 'yes' | 'no' | null;
  readonly is_enabled: boolean;
};

export const CAMPAIGN_COLUMNS = `
  id, tenant_id, name, description, category, trigger_type, trigger_config, channels,
  status, audience,
  to_char(send_window_start, 'HH24:MI') AS send_window_start,
  to_char(send_window_end,   'HH24:MI') AS send_window_end,
  send_days, one_time_per_contact, active_version_id, created_at, updated_at`;

export async function loadCampaign(
  db: Db | PoolClient,
  tenantId: string,
  campaignId: string,
): Promise<CampaignRow> {
  const row = await queryOne<CampaignRow>(
    db,
    `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE tenant_id = $1 AND id = $2`,
    [tenantId, campaignId],
  );
  // A campaign that belongs to another tenant is reported as absent, never as
  // forbidden. See the note on `notFound` in errors.ts.
  if (row === undefined) throw notFound('Campaign', campaignId);
  return row;
}

export function loadCampaignMessages(
  db: Db | PoolClient,
  campaignId: string,
): Promise<CampaignMessageRow[]> {
  return query<CampaignMessageRow>(
    db,
    `SELECT id, campaign_id, channel, sequence_order, delay_anchor, delay_minutes,
            send_condition, subject_template, html_template, body_template, preview_text,
            node_id, branch_path, is_enabled
       FROM campaign_messages WHERE campaign_id = $1 ORDER BY sequence_order`,
    [campaignId],
  );
}

export function campaignJson(row: CampaignRow): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    category: row.category,
    triggerType: row.trigger_type,
    triggerConfig: row.trigger_config,
    channels: row.channels,
    status: row.status,
    audience: row.audience,
    sendWindowStart: row.send_window_start,
    sendWindowEnd: row.send_window_end,
    sendDays: row.send_days,
    oneTimePerContact: row.one_time_per_contact,
    activeVersionId: row.active_version_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function messageJson(row: CampaignMessageRow): Record<string, unknown> {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    channel: row.channel,
    sequenceOrder: row.sequence_order,
    delayAnchor: row.delay_anchor,
    delayMinutes: row.delay_minutes,
    sendCondition: row.send_condition,
    subjectTemplate: row.subject_template,
    htmlTemplate: row.html_template,
    bodyTemplate: row.body_template,
    previewText: row.preview_text,
    nodeId: row.node_id,
    branchPath: row.branch_path,
    isEnabled: row.is_enabled,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Activation validation
// ─────────────────────────────────────────────────────────────────────────────

export type ActivationFailure = {
  readonly code: string;
  readonly message: string;
  readonly campaignMessageId?: string;
  readonly field?: string;
};

/**
 * What has to be true before a campaign may go active.
 *
 * ALL failures are collected rather than the first one thrown. An operator fixing
 * a campaign one rejection at a time, with a round trip between each, gives up
 * around the third — and this list is exactly the list a reviewer would want to
 * see at once. The whole set lands in `error.details.failures`, which is the field
 * the error envelope exists to protect.
 *
 * The unsubscribe check (I7) is here rather than at save time deliberately. A
 * draft is allowed to be incomplete; activation is the moment the campaign becomes
 * capable of mailing somebody, and that is the moment the legal obligation
 * attaches.
 */
export function validateForActivation(
  campaign: CampaignRow,
  messages: readonly CampaignMessageRow[],
): readonly ActivationFailure[] {
  const failures: ActivationFailure[] = [];
  const enabled = messages.filter((m) => m.is_enabled);

  if (enabled.length === 0) {
    failures.push({
      code: 'no_enabled_messages',
      message: 'A campaign with no enabled messages would enrol contacts and send nothing.',
    });
  }

  const audience = AudienceDefinition.safeParse(campaign.audience);
  if (!audience.success) {
    failures.push({
      code: 'audience_invalid',
      message:
        'The audience definition does not parse. An unrecognised key compiles to ' +
        `"match everyone", so it is rejected here instead: ${audience.error.issues
          .map((i) => i.message)
          .join('; ')}`,
    });
  } else {
    try {
      // Compiling with a fixed instant is enough to prove the rules resolve; the
      // clock only affects relative-date bounds, not whether the SQL builds.
      compileAudience(audience.data, { now: () => campaign.updated_at });
    } catch (error) {
      failures.push({
        code: 'audience_uncompilable',
        message: error instanceof Error ? error.message : 'The audience could not be compiled.',
      });
    }
  }

  const anchored = campaign.trigger_type.startsWith('order_');

  for (const message of enabled) {
    if (!campaign.channels.includes(message.channel)) {
      failures.push({
        code: 'message_channel_not_enabled',
        campaignMessageId: message.id,
        message: `Message ${message.sequence_order} is ${message.channel}, which this campaign does not send on.`,
      });
    }

    /**
     * The template check is `validateTemplate` from packages/core — the same
     * function the editor and the send path call. It carries I7 (a marketing
     * template with no resolvable opt-out is an ERROR, not a warning), the
     * unknown-merge-field rejection, and the "an email needs a subject" rule.
     * Re-implementing any of those here would give activation a second opinion,
     * and a second opinion about whether a campaign is sendable is worth less than
     * no opinion at all.
     */
    const result = validateTemplate(
      {
        channel: message.channel,
        subject: message.subject_template,
        body: message.body_template,
        html: message.html_template,
      },
      campaign.category,
    );
    for (const issue of result.errors) {
      failures.push({
        code: 'template_invalid',
        campaignMessageId: message.id,
        ...(issue.field === undefined ? {} : { field: issue.field }),
        message: `Message ${message.sequence_order}: ${issue.message}`,
      });
    }

    // An `order.*` field on a campaign with no order anchor is not a template
    // error — the field is real — but it can never resolve, so it renders empty to
    // everybody. Caught here rather than in core, because whether an anchor exists
    // is a property of the campaign's trigger, not of the template.
    if (!anchored) {
      for (const field of result.mergeFields.filter((f) => f.startsWith('order.'))) {
        failures.push({
          code: 'order_field_without_anchor',
          campaignMessageId: message.id,
          field,
          message:
            `Message ${message.sequence_order} uses {{${field}}}, but this campaign is ` +
            `triggered by '${campaign.trigger_type}' and has no order to resolve it from. ` +
            'It would render empty for every recipient.',
        });
      }
    }
  }

  return failures;
}

// ─────────────────────────────────────────────────────────────────────────────
// Version snapshots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Freeze the campaign as it stands.
 *
 * The snapshot is the answer to "what did this recipient actually receive?" asked
 * three weeks after the operator rewrote the copy. `message_queue` rows reference
 * the version that produced them, so editing a live campaign cannot retroactively
 * change what analytics report was sent — and `campaign_versions` carries an
 * append-only trigger, so it cannot be tidied up later either.
 */
export async function snapshotCampaign(
  tx: PoolClient,
  opts: {
    readonly tenantId: string;
    readonly campaignId: string;
    readonly activatedBy: string | null;
    readonly reason: string;
  },
): Promise<{ id: string; version: number }> {
  const campaign = await loadCampaign(tx, opts.tenantId, opts.campaignId);
  const messages = await loadCampaignMessages(tx, opts.campaignId);
  const stops = await query<Record<string, unknown>>(
    tx,
    `SELECT condition_type, config, is_active FROM campaign_stop_conditions WHERE campaign_id = $1`,
    [opts.campaignId],
  );
  const goals = await query<Record<string, unknown>>(
    tx,
    `SELECT metric, label, target_value, unit FROM campaign_goals WHERE campaign_id = $1`,
    [opts.campaignId],
  );

  const next = await queryOne<{ version: number }>(
    tx,
    `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM campaign_versions WHERE campaign_id = $1`,
    [opts.campaignId],
  );
  const version = next?.version ?? 1;

  const inserted = await queryOne<{ id: string }>(
    tx,
    `INSERT INTO campaign_versions (tenant_id, campaign_id, version, snapshot, activated_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [
      opts.tenantId,
      opts.campaignId,
      version,
      JSON.stringify({
        reason: opts.reason,
        campaign: campaignJson(campaign),
        messages: messages.map(messageJson),
        stopConditions: stops,
        goals,
      }),
      opts.activatedBy,
    ],
  );
  if (inserted === undefined) throw new Error('campaign_versions insert returned no row');
  return { id: inserted.id, version };
}
