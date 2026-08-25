/**
 * A token for tenant A cannot read tenant B's anything.
 *
 * The failure this exists to prevent is the one that ends a B2B product. It does
 * not look like a breach while it is happening: every request returns 200, the
 * shapes are right, the UI renders. It is only visible from the other side, when a
 * customer sees a campaign name they do not recognise.
 *
 * It is also structurally easy to introduce, because the mistake is an OMISSION.
 * A handler that forgets `AND tenant_id = $1` still compiles, still passes a
 * single-tenant test suite, and still works perfectly in every demo. The only
 * thing that catches it is a test that stands up two tenants and asks one for the
 * other's rows — which is why this file tries several routes rather than one, and
 * covers reads, writes and list endpoints separately. A tenant leak on `GET
 * /campaigns/:id` and a tenant leak on `GET /campaigns` are different bugs with
 * different fixes.
 *
 * Cross-tenant access is reported as 404 rather than 403, deliberately: a 403
 * confirms the id exists, which turns any authenticated account into an oracle for
 * enumerating another tenant's ids.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import {
  seedTenant,
  seedContact,
  seedCampaign,
  seedCampaignMessage,
  seedEnrollment,
} from '../support/fixtures.ts';
import { FakeClock } from '@campaign/core';
import { buildDeps, createApp, hashPassword, issueApiKey, type App } from '@campaign/api';

const CLOCK = new FakeClock('2026-06-15T12:00:00Z');
const SECRET = new TextEncoder().encode('tenant-scoping-suite-secret');
const KEY = Buffer.alloc(32, 0x22);

function boot(): App {
  return createApp(
    buildDeps({
      db: testDb(),
      clock: CLOCK,
      jwtSecret: SECRET,
      encryptionKey: KEY,
      publicBaseUrl: 'http://api.test',
      rateLimit: { limit: 10_000, windowMs: 60_000, publicLimit: 10_000, loginLimit: 10_000 },
      env: { ...process.env, LOG_LEVEL: 'silent' },
    }),
  );
}

type Tenant = {
  tenantId: string;
  token: string;
  campaignId: string;
  contactId: string;
  orderId: string;
  queuedMessageId: string;
  storeId: string;
};

async function tokenFor(app: App, db: Pool, tenantId: string): Promise<string> {
  const password = 'correct horse battery staple';
  const email = `op-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await db.query(
    `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1,$2,$3,'owner')`,
    [tenantId, email, await hashPassword(password)],
  );
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, tenantId }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

/** A whole tenant with one of everything, so every route has something to leak. */
async function seedWorld(app: App, name: string): Promise<Tenant> {
  const db = testDb();
  const tenantId = await seedTenant(db, { name });
  const token = await tokenFor(app, db, tenantId);
  const contactId = await seedContact(db, tenantId, {
    email: `customer-${name.toLowerCase()}@example.com`,
  });

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
  const campaignMessageId = await seedCampaignMessage(db, tenantId, campaignId, {});
  const enrollmentId = await seedEnrollment(db, tenantId, campaignId, versionId, contactId);

  const { rows: queued } = await db.query<{ id: string }>(
    `INSERT INTO message_queue
       (tenant_id, enrollment_id, campaign_id, campaign_version_id, campaign_message_id,
        contact_id, channel, recipient_address, rendered_body, scheduled_at)
     VALUES ($1,$2,$3,$4,$5,$6,'email',$7,'body','2026-06-16T09:00:00Z') RETURNING id`,
    [
      tenantId,
      enrollmentId,
      campaignId,
      versionId,
      campaignMessageId,
      contactId,
      `customer-${name.toLowerCase()}@example.com`,
    ],
  );

  await db.query(
    `INSERT INTO send_decisions (tenant_id, campaign_id, contact_id, order_id, stage, decision, reason_code)
     VALUES ($1,$2,$3,$4,'send','proceed','enqueued')`,
    [tenantId, campaignId, contactId, orderId],
  );

  return {
    tenantId,
    token,
    campaignId,
    contactId,
    orderId,
    storeId,
    queuedMessageId: queued[0]!.id,
  };
}

let app: App;
let a: Tenant;
let b: Tenant;

afterAll(closeTestDb);
beforeAll(resetDb);

beforeEach(async () => {
  await resetDb();
  app = boot();
  a = await seedWorld(app, 'Alpha');
  b = await seedWorld(app, 'Beta');
});

function asA(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${a.token}`, 'content-type': 'application/json', ...extra };
}

describe("tenant A's token cannot READ tenant B's rows", () => {
  it('refuses every single-row read across the boundary', async () => {
    const routes = [
      `/campaigns/${b.campaignId}`,
      `/campaigns/${b.campaignId}/messages`,
      `/campaigns/${b.campaignId}/stats`,
      `/campaigns/${b.campaignId}/funnel`,
      `/campaigns/${b.campaignId}/messages/stats`,
      `/campaigns/${b.campaignId}/enrollments`,
      `/contacts/${b.contactId}`,
      `/contacts/${b.contactId}/consent`,
      `/orders/${b.orderId}/journey`,
    ];

    for (const route of routes) {
      const response = await app.request(route, { headers: asA() });
      expect(response.status, `${route} must not be readable by another tenant`).toBe(404);

      // 404, not 403. A 403 would confirm the id exists.
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    }
  });

  it("keeps B's own token working on the same rows, so 404 is scoping and not breakage", async () => {
    for (const route of [
      `/campaigns/${b.campaignId}`,
      `/campaigns/${b.campaignId}/stats`,
      `/campaigns/${b.campaignId}/funnel`,
      `/campaigns/${b.campaignId}/messages/stats`,
      `/campaigns/${b.campaignId}/enrollments`,
      `/contacts/${b.contactId}`,
      `/contacts/${b.contactId}/consent`,
      `/orders/${b.orderId}/journey`,
    ]) {
      const response = await app.request(route, {
        headers: { authorization: `Bearer ${b.token}` },
      });
      expect(response.status, `${route} should be readable by its own tenant`).toBe(200);
    }
  });
});

describe("tenant A's token cannot WRITE tenant B's rows", () => {
  it('refuses cross-tenant mutations', async () => {
    const writes: [string, RequestInit][] = [
      [`/campaigns/${b.campaignId}`, { method: 'PATCH', body: JSON.stringify({ name: 'stolen' }) }],
      [`/campaigns/${b.campaignId}`, { method: 'DELETE' }],
      [`/campaigns/${b.campaignId}/activate`, { method: 'POST' }],
      [`/campaigns/${b.campaignId}/pause`, { method: 'POST' }],
      [`/campaigns/${b.campaignId}/duplicate`, { method: 'POST', body: '{}' }],
      [
        `/campaigns/${b.campaignId}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ channel: 'email', sequenceOrder: 9, bodyTemplate: 'x' }),
        },
      ],
      [`/queue/${b.queuedMessageId}/cancel`, { method: 'POST' }],
      [
        `/contacts/${b.contactId}/consent`,
        { method: 'POST', body: JSON.stringify({ channel: 'email', state: 'opted_out' }) },
      ],
    ];

    for (const [route, init] of writes) {
      const response = await app.request(route, { ...init, headers: asA() });
      expect(response.status, `${route} must not be writable by another tenant`).toBe(404);
    }

    // And nothing actually changed on B's side.
    const { rows } = await testDb().query<{ name: string; status: string }>(
      `SELECT name, status FROM campaigns WHERE id = $1`,
      [b.campaignId],
    );
    expect(rows[0]!.name).toBe('Beta campaign');
    expect(rows[0]!.status).toBe('active');

    const { rows: queued } = await testDb().query<{ status: string }>(
      `SELECT status FROM message_queue WHERE id = $1`,
      [b.queuedMessageId],
    );
    expect(queued[0]!.status).toBe('pending');
  });
});

describe("list endpoints return only the caller's tenant", () => {
  it('lists campaigns, queue rows, decisions and suppressions for A only', async () => {
    const campaigns = (await (await app.request('/campaigns', { headers: asA() })).json()) as {
      campaigns: { id: string; tenantId: string }[];
    };
    expect(campaigns.campaigns.map((c) => c.id)).toEqual([a.campaignId]);
    expect(campaigns.campaigns.every((c) => c.tenantId === a.tenantId)).toBe(true);

    const queue = (await (await app.request('/queue', { headers: asA() })).json()) as {
      messages: { id: string }[];
    };
    expect(queue.messages.map((m) => m.id)).toEqual([a.queuedMessageId]);

    // A decision filter naming B's campaign returns nothing rather than B's rows:
    // the filter is applied INSIDE the tenant scope, never instead of it.
    const decisions = (await (
      await app.request(`/decisions?campaignId=${b.campaignId}`, { headers: asA() })
    ).json()) as { decisions: unknown[] };
    expect(decisions.decisions).toEqual([]);

    const own = (await (
      await app.request(`/decisions?campaignId=${a.campaignId}`, { headers: asA() })
    ).json()) as { decisions: unknown[] };
    expect(own.decisions.length).toBe(1);
  });

  it("does not find B's order by number, even with B's store id", async () => {
    // The tenant is not one filter among several: adding ?storeId= must not be a
    // way around it.
    const response = await app.request(`/orders/lookup?number=ORDER-Beta&storeId=${b.storeId}`, {
      headers: asA(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'none' });
  });

  it('estimates an audience over A’s contacts only', async () => {
    const response = await app.request('/audience/estimate', {
      method: 'POST',
      headers: asA(),
      body: JSON.stringify({ audience: {} }),
    });
    const body = (await response.json()) as { count: number; sample: { id: string }[] };

    // An empty audience matches everyone — everyone IN THIS TENANT.
    expect(body.count).toBe(1);
    expect(body.sample.map((s) => s.id)).toEqual([a.contactId]);
  });

  it("refuses to evaluate a match against another tenant's contact", async () => {
    const response = await app.request('/audience/matches', {
      method: 'POST',
      headers: asA(),
      body: JSON.stringify({ audience: {}, contactId: b.contactId }),
    });
    const body = (await response.json()) as { matched: boolean; failedRule: string };
    expect(body.matched).toBe(false);
    expect(body.failedRule).toContain('does not exist in this tenant');
  });
});

describe('the tenant comes from the credential and nowhere else', () => {
  it('ignores a tenant id supplied in a header or a query string', async () => {
    for (const request of [
      app.request(`/campaigns/${b.campaignId}`, {
        headers: asA({ 'x-tenant-id': b.tenantId }),
      }),
      app.request(`/campaigns/${b.campaignId}?tenantId=${b.tenantId}`, { headers: asA() }),
    ]) {
      const response = await request;
      expect(response.status).toBe(404);
    }
  });

  it('scopes an ingest API key to the tenant that key names', async () => {
    const keyForA = issueApiKey(a.tenantId, SECRET);

    // The body names B's contact; the key names A. The key wins, and the event is
    // rejected rather than silently attributed to A or accepted for B.
    const response = await app.request('/events', {
      method: 'POST',
      headers: { 'x-api-key': keyForA, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'converted', contactId: b.contactId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accepted: number; rejected: number };
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_events WHERE contact_id = $1`,
      [b.contactId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('rejects a token signed with a different secret outright', async () => {
    const forged = createApp(
      buildDeps({
        db: testDb(),
        clock: CLOCK,
        jwtSecret: new TextEncoder().encode('a completely different secret'),
        encryptionKey: KEY,
        publicBaseUrl: 'http://api.test',
        env: { ...process.env, LOG_LEVEL: 'silent' },
      }),
    );
    const response = await forged.request('/campaigns', { headers: asA() });
    expect(response.status).toBe(401);
  });
});
