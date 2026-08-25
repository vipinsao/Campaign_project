/**
 * Test fixtures.
 *
 * These build real rows through the real constraints. Nothing here bypasses a
 * CHECK, a trigger or a foreign key — if a fixture cannot be built, that is a
 * finding about the schema rather than an inconvenience to work around.
 */
import type { Pool } from 'pg';
import { testDb } from './db.ts';

export type Seeded = {
  tenantId: string;
  storeId: string;
  campaignId: string;
  campaignVersionId: string;
  campaignMessageId: string;
  contactId: string;
  enrollmentId: string;
};

export async function seedTenant(
  db: Pool = testDb(),
  opts: {
    name?: string;
    timezone?: string;
    quietStart?: string;
    quietEnd?: string;
    freqCapCount?: number;
    freqCapWindow?: string;
  } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO tenants (name, default_timezone, quiet_hours_start, quiet_hours_end,
                          freq_cap_count, freq_cap_window)
     VALUES ($1,$2,$3,$4,$5,$6::interval) RETURNING id`,
    [
      opts.name ?? 'Test Tenant',
      opts.timezone ?? 'UTC',
      opts.quietStart ?? '00:00',
      opts.quietEnd ?? '23:59',
      opts.freqCapCount ?? 1000,
      opts.freqCapWindow ?? '7 days',
    ],
  );
  return rows[0]!.id;
}

export async function seedContact(
  db: Pool,
  tenantId: string,
  opts: { email?: string | null; phone?: string | null; timezone?: string | null; tags?: string[] } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, email, phone, timezone, tags)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [
      tenantId,
      opts.email === undefined ? `c${Math.random().toString(36).slice(2, 10)}@example.com` : opts.email,
      opts.phone ?? null,
      opts.timezone ?? null,
      opts.tags ?? [],
    ],
  );
  return rows[0]!.id;
}

export async function seedCampaign(
  db: Pool,
  tenantId: string,
  opts: {
    name?: string;
    category?: string;
    triggerType?: string;
    status?: string;
    sendDays?: number[];
    windowStart?: string | null;
    windowEnd?: string | null;
  } = {},
): Promise<{ campaignId: string; versionId: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO campaigns (tenant_id, name, category, trigger_type, status,
                            send_days, send_window_start, send_window_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      tenantId,
      opts.name ?? 'Test Campaign',
      opts.category ?? 'lifecycle',
      opts.triggerType ?? 'manual',
      opts.status ?? 'active',
      opts.sendDays ?? [0, 1, 2, 3, 4, 5, 6],
      opts.windowStart ?? null,
      opts.windowEnd ?? null,
    ],
  );
  const campaignId = rows[0]!.id;

  const { rows: v } = await db.query<{ id: string }>(
    `INSERT INTO campaign_versions (tenant_id, campaign_id, version, snapshot)
     VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
    [tenantId, campaignId],
  );
  const versionId = v[0]!.id;
  await db.query(`UPDATE campaigns SET active_version_id = $2 WHERE id = $1`, [campaignId, versionId]);
  return { campaignId, versionId };
}

export async function seedCampaignMessage(
  db: Pool,
  tenantId: string,
  campaignId: string,
  opts: {
    channel?: 'email' | 'sms';
    sequenceOrder?: number;
    sendCondition?: string;
    subject?: string | null;
    body?: string;
    nodeId?: string | null;
  } = {},
): Promise<string> {
  const channel = opts.channel ?? 'email';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO campaign_messages
       (tenant_id, campaign_id, channel, sequence_order, send_condition,
        subject_template, body_template, node_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      tenantId,
      campaignId,
      channel,
      opts.sequenceOrder ?? 1,
      opts.sendCondition ?? 'always',
      opts.subject === undefined ? (channel === 'email' ? 'Test subject' : null) : opts.subject,
      opts.body ?? 'Hello {{contact.first_name}}. {{unsubscribe_url}}',
      opts.nodeId ?? null,
    ],
  );
  return rows[0]!.id;
}

export async function seedEnrollment(
  db: Pool,
  tenantId: string,
  campaignId: string,
  versionId: string,
  contactId: string,
  opts: { anchorType?: string; anchorId?: string | null; status?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO enrollments (tenant_id, campaign_id, campaign_version_id, contact_id,
                              anchor_type, anchor_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      tenantId,
      campaignId,
      versionId,
      contactId,
      opts.anchorType ?? 'manual',
      opts.anchorId ?? null,
      opts.status ?? 'active',
    ],
  );
  return rows[0]!.id;
}

/** A tenant with one active campaign, one message, one contact and one enrolment. */
export async function seedAll(
  db: Pool = testDb(),
  opts: {
    tenant?: Parameters<typeof seedTenant>[1];
    campaign?: Parameters<typeof seedCampaign>[2];
    message?: Parameters<typeof seedCampaignMessage>[3];
    contact?: Parameters<typeof seedContact>[2];
  } = {},
): Promise<Seeded> {
  const tenantId = await seedTenant(db, opts.tenant ?? {});
  const { rows: s } = await db.query<{ id: string }>(
    `INSERT INTO stores (tenant_id, name, code) VALUES ($1,'Main','main') RETURNING id`,
    [tenantId],
  );
  const contactId = await seedContact(db, tenantId, opts.contact ?? {});
  const { campaignId, versionId } = await seedCampaign(db, tenantId, opts.campaign ?? {});
  const campaignMessageId = await seedCampaignMessage(db, tenantId, campaignId, opts.message ?? {});
  const enrollmentId = await seedEnrollment(db, tenantId, campaignId, versionId, contactId);

  return {
    tenantId,
    storeId: s[0]!.id,
    campaignId,
    campaignVersionId: versionId,
    campaignMessageId,
    contactId,
    enrollmentId,
  };
}

/**
 * Opt a contact in, so the consent gate is not the thing failing a delivery test.
 *
 * `occurredAt` defaults to a fixed instant in the distant past rather than to the
 * database's now(). Consent resolves by most-recent-intent, so a fixture stamped
 * with the real wall clock would silently outrank an opt-out recorded by a test's
 * FakeClock — and the test would fail for a reason that has nothing to do with the
 * behaviour under test. Fixtures must not read a clock the test does not control.
 */
export async function optIn(
  db: Pool,
  tenantId: string,
  contactId: string,
  channel: 'email' | 'sms' = 'email',
  occurredAt = '2020-01-01T00:00:00Z',
): Promise<void> {
  await db.query(
    `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source, occurred_at)
     VALUES ($1,$2,$3,'opted_in','signup',$4::timestamptz)`,
    [tenantId, contactId, channel, occurredAt],
  );
}
