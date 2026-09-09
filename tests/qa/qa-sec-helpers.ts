/**
 * Shared scaffolding for the adversarial HTTP-layer review (qa-sec-*).
 *
 * Nothing here asserts; it only builds the two hostile tenants every file in this
 * group needs. Boot is the REAL createApp with the REAL middleware chain, exactly
 * as tests/integration/api-*.test.ts does it — a finding proven against a stubbed
 * app is not a finding.
 */
import type { Pool } from 'pg';
import { FakeClock } from '@campaign/core';
import { buildDeps, createApp, hashPassword, type App } from '@campaign/api';
import { testDb } from '../support/db.ts';
import {
  seedTenant,
  seedContact,
  seedCampaign,
  seedCampaignMessage,
  seedEnrollment,
} from '../support/fixtures.ts';

export const QA_CLOCK = new FakeClock('2026-06-15T12:00:00Z');
export const QA_SECRET = new TextEncoder().encode('qa-sec-suite-secret');
export const QA_ENC_KEY = Buffer.alloc(32, 0x37);

export function bootApp(overrides: Record<string, unknown> = {}): App {
  return createApp(
    buildDeps({
      db: testDb(),
      clock: QA_CLOCK,
      jwtSecret: QA_SECRET,
      encryptionKey: QA_ENC_KEY,
      publicBaseUrl: 'http://api.test',
      rateLimit: { limit: 100_000, windowMs: 60_000, publicLimit: 100_000, loginLimit: 100_000 },
      env: { ...process.env, LOG_LEVEL: 'silent' },
      ...overrides,
    }),
  );
}

export type World = {
  tenantId: string;
  userId: string;
  token: string;
  campaignId: string;
  versionId: string;
  campaignMessageId: string;
  contactId: string;
  contactEmail: string;
  orderId: string;
  storeId: string;
  enrollmentId: string;
  queuedMessageId: string;
  trackingId: string;
};

export async function loginToken(
  app: App,
  db: Pool,
  tenantId: string,
): Promise<{ token: string; userId: string }> {
  const password = 'correct horse battery staple';
  const email = `op-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1,$2,$3,'owner') RETURNING id`,
    [tenantId, email, await hashPassword(password)],
  );
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, tenantId }),
  });
  if (response.status !== 200)
    throw new Error(`login failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { token: string };
  return { token: body.token, userId: rows[0]!.id };
}

/** One tenant with one of everything an id-taking route could leak. */
export async function seedWorld(app: App, name: string): Promise<World> {
  const db = testDb();
  const tenantId = await seedTenant(db, { name });
  const { token, userId } = await loginToken(app, db, tenantId);

  const contactEmail = `customer-${name.toLowerCase()}@example.com`;
  const contactId = await seedContact(db, tenantId, { email: contactEmail, phone: null });

  const { rows: store } = await db.query<{ id: string }>(
    `INSERT INTO stores (tenant_id, name, code) VALUES ($1,$2,$3) RETURNING id`,
    [tenantId, `${name} store`, `store-${name.toLowerCase()}`],
  );
  const storeId = store[0]!.id;

  const { rows: order } = await db.query<{ id: string }>(
    `INSERT INTO orders (tenant_id, store_id, contact_id, order_number, status, total, placed_at)
     VALUES ($1,$2,$3,$4,'placed',10.00,'2026-06-01T00:00:00Z') RETURNING id`,
    [tenantId, storeId, contactId, `ORDER-${name}`],
  );
  const orderId = order[0]!.id;

  const { campaignId, versionId } = await seedCampaign(db, tenantId, {
    name: `${name} campaign`,
    status: 'active',
  });
  const campaignMessageId = await seedCampaignMessage(db, tenantId, campaignId, {
    nodeId: `node-${name.toLowerCase()}`,
  });
  const enrollmentId = await seedEnrollment(db, tenantId, campaignId, versionId, contactId);

  const { rows: queued } = await db.query<{ id: string; tracking_id: string }>(
    `INSERT INTO message_queue
       (tenant_id, enrollment_id, campaign_id, campaign_version_id, campaign_message_id,
        contact_id, channel, recipient_address, rendered_body, scheduled_at, status, sent_at,
        provider, provider_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,'email',$7,'body','2026-06-14T09:00:00Z','sent','2026-06-14T09:01:00Z',
             'mock',$8)
     RETURNING id, tracking_id::text AS tracking_id`,
    [
      tenantId,
      enrollmentId,
      campaignId,
      versionId,
      campaignMessageId,
      contactId,
      contactEmail,
      `pmid-${name.toLowerCase()}`,
    ],
  );

  await db.query(
    `INSERT INTO send_decisions (tenant_id, campaign_id, contact_id, order_id, stage, decision, reason_code)
     VALUES ($1,$2,$3,$4,'send','proceed','enqueued')`,
    [tenantId, campaignId, contactId, orderId],
  );

  return {
    tenantId,
    userId,
    token,
    campaignId,
    versionId,
    campaignMessageId,
    contactId,
    contactEmail,
    orderId,
    storeId,
    enrollmentId,
    queuedMessageId: queued[0]!.id,
    trackingId: queued[0]!.tracking_id,
  };
}

export function authHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra };
}
