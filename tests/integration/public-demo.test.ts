/**
 * The public demo: a console with no login, and the three things that make that
 * safe to put on a CV.
 *
 *  1. `POST /auth/demo` hands out a session only when PUBLIC_DEMO is on, and is
 *     indistinguishable from an unknown route otherwise.
 *  2. Real people the storefront wrote into the demo tenant are not readable by
 *     the next anonymous visitor: emails, phones, IPs and user agents are masked
 *     on the way out, while the seed's reserved example data is left alone.
 *  3. The campaign the storefront sends is locked, so the open console cannot be
 *     used to rewrite or switch off what the checkout delivers.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedTenant, seedCampaign, seedCampaignMessage, seedContact } from '../support/fixtures.ts';
import { FakeClock } from '@campaign/core';
import {
  buildDeps,
  createApp,
  hashPassword,
  redactForPublicDemo,
  redactString,
  type App,
} from '@campaign/api';

const CLOCK = new FakeClock('2026-06-15T12:00:00Z');
const SECRET = new TextEncoder().encode('public-demo-suite-secret');
const KEY = Buffer.alloc(32, 0x55);
const TENANT_NAME = 'Public Demo Shop';

function boot(publicDemo: boolean, sendMode: 'mock' | 'live' = 'mock'): App {
  return createApp(
    buildDeps({
      db: testDb(),
      clock: CLOCK,
      jwtSecret: SECRET,
      encryptionKey: KEY,
      publicBaseUrl: 'http://api.test',
      sendMode,
      rateLimit: { limit: 10_000, windowMs: 60_000, publicLimit: 10_000, loginLimit: 10_000 },
      env: {
        ...process.env,
        LOG_LEVEL: 'silent',
        STOREFRONT_TENANT_NAME: TENANT_NAME,
        ...(publicDemo ? { PUBLIC_DEMO: 'true' } : { PUBLIC_DEMO: '' }),
      },
    }),
  );
}

async function seedDemoTenant(): Promise<{ tenantId: string; storefrontId: string }> {
  const db = testDb();
  const tenantId = await seedTenant(db, { name: TENANT_NAME });
  await db.query(
    `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1,'operator@example.com',$2,'owner')`,
    [tenantId, await hashPassword('not-used-by-the-demo')],
  );
  const { campaignId } = await seedCampaign(db, tenantId, {
    name: 'Order confirmation',
    category: 'transactional',
    triggerType: 'order_placed',
    status: 'active',
  });
  await db.query(`UPDATE campaigns SET is_storefront = true WHERE id = $1`, [campaignId]);
  await seedCampaignMessage(db, tenantId, campaignId, {
    channel: 'email',
    sequenceOrder: 1,
    subject: 'Order {{order.number}} confirmed',
    body: 'Thanks {{contact.first_name}}.',
  });
  return { tenantId, storefrontId: campaignId };
}

async function demoToken(app: App): Promise<string> {
  const response = await app.request('/auth/demo', { method: 'POST' });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

afterAll(closeTestDb);
beforeAll(resetDb);
beforeEach(resetDb);

describe('POST /auth/demo', () => {
  it('is a 404 like any unknown route when PUBLIC_DEMO is off', async () => {
    await seedDemoTenant();
    const response = await boot(false).request('/auth/demo', { method: 'POST' });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('opens a working operator session for the storefront tenant when it is on', async () => {
    const { tenantId } = await seedDemoTenant();
    const app = boot(true);
    const response = await app.request('/auth/demo', { method: 'POST' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      demo: boolean;
      user: { tenantId: string; role: string };
    };
    expect(body.demo).toBe(true);
    expect(body.user.tenantId).toBe(tenantId);
    expect(body.user.role).toBe('owner');

    const campaigns = await app.request('/campaigns', { headers: auth(body.token) });
    expect(campaigns.status).toBe(200);
  });

  it('says the demo is not seeded rather than failing obscurely', async () => {
    const response = await boot(true).request('/auth/demo', { method: 'POST' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'demo_not_seeded',
    );
  });
});

describe('what the next visitor can read', () => {
  it('masks real addresses, phones and consent evidence; leaves example data alone', async () => {
    const { tenantId } = await seedDemoTenant();
    const db = testDb();
    const real = await seedContact(db, tenantId, {
      email: 'someone.real@gmail.com',
      phone: '+919876543210',
    });
    await db.query(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source, evidence, occurred_at)
       VALUES ($1,$2,'email','opted_in','checkout',$3,$4)`,
      [
        tenantId,
        real,
        JSON.stringify({ ip: '81.2.69.160', userAgent: 'Mozilla/5.0 (iPhone)' }),
        CLOCK.now(),
      ],
    );
    const fake = await seedContact(db, tenantId, {
      email: 'fictional@example.com',
      phone: '+15005550006',
    });

    const app = boot(true);
    const token = await demoToken(app);

    const realText = await (
      await app.request(`/contacts/${real}`, { headers: auth(token) })
    ).text();
    expect(realText).not.toContain('someone.real@gmail.com');
    expect(realText).toContain('s•••@gmail.com');
    expect(realText).not.toContain('+919876543210');
    expect(realText).not.toContain('81.2.69.160');
    expect(realText).not.toContain('iPhone');

    const fakeText = await (
      await app.request(`/contacts/${fake}`, { headers: auth(token) })
    ).text();
    expect(fakeText).toContain('fictional@example.com');
    expect(fakeText).toContain('+15005550006');
  });

  it('returns raw data when PUBLIC_DEMO is off', async () => {
    const { tenantId } = await seedDemoTenant();
    const db = testDb();
    const real = await seedContact(db, tenantId, { email: 'someone.real@gmail.com' });
    const app = boot(false);
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'operator@example.com', password: 'not-used-by-the-demo' }),
    });
    const { token } = (await login.json()) as { token: string };
    const text = await (await app.request(`/contacts/${real}`, { headers: auth(token) })).text();
    expect(text).toContain('someone.real@gmail.com');
  });

  it('masks inside free text and nested values, idempotently', () => {
    const once = redactString('Thanks — sent to ada.l@outlook.com and +447700900123.');
    expect(once).toBe('Thanks — sent to a•••@outlook.com and +44•••••••123.');
    expect(redactString(once)).toBe(once);
    expect(
      redactForPublicDemo({ list: [{ email: 'x@yahoo.co.in', ip_address: '10.0.0.1' }] }),
    ).toEqual({ list: [{ email: 'x•••@yahoo.co.in', ip_address: 'hidden in the public demo' }] });
  });
});

describe('the mock outbox on a live public demo', () => {
  it('is served, because the worker still sends the seeded campaigns through the mock', async () => {
    await seedDemoTenant();
    const app = boot(true, 'live');
    const body = (await (
      await app.request('/mock-outbox', { headers: auth(await demoToken(app)) })
    ).json()) as { available: boolean };
    expect(body.available).toBe(true);
  });

  it('is still refused on a live deployment that is not a public demo', async () => {
    await seedDemoTenant();
    const app = boot(false, 'live');
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'operator@example.com', password: 'not-used-by-the-demo' }),
    });
    const { token } = (await login.json()) as { token: string };
    const body = (await (await app.request('/mock-outbox', { headers: auth(token) })).json()) as {
      available: boolean;
    };
    expect(body.available).toBe(false);
  });
});

describe('the storefront campaign is locked', () => {
  it('refuses edits, pause, archive, message changes and flow changes with 409', async () => {
    const { storefrontId } = await seedDemoTenant();
    const app = boot(true);
    const token = await demoToken(app);
    const h = auth(token);

    const messages = (await (
      await app.request(`/campaigns/${storefrontId}/messages`, { headers: h })
    ).json()) as { messages: { id: string }[] };
    const messageId = messages.messages[0]!.id;

    const attempts: [string, string, unknown][] = [
      ['PATCH', `/campaigns/${storefrontId}`, { name: 'Renamed' }],
      ['POST', `/campaigns/${storefrontId}/pause`, {}],
      ['DELETE', `/campaigns/${storefrontId}`, undefined],
      [
        'POST',
        `/campaigns/${storefrontId}/messages`,
        { channel: 'email', sequenceOrder: 2, subjectTemplate: 'x', bodyTemplate: 'Advert' },
      ],
      ['PATCH', `/campaigns/${storefrontId}/messages/${messageId}`, { bodyTemplate: 'Advert' }],
      ['DELETE', `/campaigns/${storefrontId}/messages/${messageId}`, undefined],
      ['PUT', `/campaigns/${storefrontId}/flow`, { flow: { nodes: [], edges: [] } }],
    ];
    for (const [method, path, body] of attempts) {
      const response = await app.request(path, {
        method,
        headers: h,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, `${method} ${path}`).toBe(409);
      const error = ((await response.json()) as { error: { code: string } }).error;
      expect(error.code, `${method} ${path}`).toBe('storefront_campaign_locked');
    }
  });

  it('can be duplicated, and the copy is an ordinary, editable campaign', async () => {
    const { storefrontId } = await seedDemoTenant();
    const app = boot(true);
    const h = auth(await demoToken(app));

    const created = await app.request(`/campaigns/${storefrontId}/duplicate`, {
      method: 'POST',
      headers: h,
      body: '{}',
    });
    expect(created.status).toBe(201);
    const copy = (await created.json()) as { campaign: { id: string; isStorefront: boolean } };
    expect(copy.campaign.isStorefront).toBe(false);

    const renamed = await app.request(`/campaigns/${copy.campaign.id}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ name: 'My experiment' }),
    });
    expect(renamed.status).toBe(200);
  });
});
