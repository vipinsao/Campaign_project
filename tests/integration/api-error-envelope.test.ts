/**
 * The error envelope, and specifically: `details` REACHES THE CLIENT.
 *
 * The shape is `{ error: { code, message, details? } }`. `code` and `message` are
 * the easy half — every framework produces those. `details` is the half that gets
 * lost, and losing it is not a cosmetic regression.
 *
 * The failure this suite pins: the server knows exactly which of forty audience
 * rules is malformed, or which four things must be fixed before a campaign can be
 * activated, and the client renders "Save failed". The diagnosis was produced
 * correctly and then discarded one layer before anybody could read it. The operator
 * files a ticket, an engineer reproduces it locally, and the answer was in the
 * response body the whole time.
 *
 * The natural way to introduce that bug is a well-meaning `catch` that logs and
 * re-wraps. So this suite asserts on the wire format rather than on the internals:
 * it reads `response.json()` and checks the field is there, populated, and specific.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedTenant, seedContact, seedCampaign, seedCampaignMessage } from '../support/fixtures.ts';
import { FakeClock, type Db } from '@campaign/core';
import { buildDeps, createApp, hashPassword, type App } from '@campaign/api';

const CLOCK = new FakeClock('2026-06-15T12:00:00Z');
const SECRET = new TextEncoder().encode('error-envelope-suite-secret');
const KEY = Buffer.alloc(32, 0x11);

function boot(overrides: Parameters<typeof buildDeps>[0] = {}): App {
  return createApp(
    buildDeps({
      db: testDb(),
      clock: CLOCK,
      jwtSecret: SECRET,
      encryptionKey: KEY,
      publicBaseUrl: 'http://api.test',
      rateLimit: { limit: 10_000, windowMs: 60_000, publicLimit: 10_000, loginLimit: 10_000 },
      env: { ...process.env, LOG_LEVEL: 'silent' },
      ...overrides,
    }),
  );
}

type Envelope = { error: { code: string; message: string; details?: unknown } };

async function envelopeOf(response: Response): Promise<Envelope> {
  return (await response.json()) as Envelope;
}

async function seedOperator(db: Pool, tenantId: string, password = 'correct horse'): Promise<string> {
  const hash = await hashPassword(password);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, role)
     VALUES ($1,$2,$3,'owner') RETURNING id`,
    [tenantId, `op-${Math.random().toString(36).slice(2, 8)}@example.com`, hash],
  );
  return rows[0]!.id;
}

async function tokenFor(app: App, db: Pool, tenantId: string): Promise<string> {
  const password = 'correct horse battery staple';
  const hash = await hashPassword(password);
  const email = `op-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await db.query(
    `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1,$2,$3,'owner')`,
    [tenantId, email, hash],
  );
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, tenantId }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { token: string };
  return body.token;
}

let app: App;
let tenantId: string;
let token: string;

beforeAll(async () => {
  await resetDb();
});
afterAll(closeTestDb);

beforeEach(async () => {
  await resetDb();
  app = boot();
  tenantId = await seedTenant(testDb());
  token = await tokenFor(app, testDb(), tenantId);
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('the error envelope keeps its shape', () => {
  it('always has error.code and error.message', async () => {
    const response = await app.request('/campaigns/not-a-uuid-at-all', { headers: auth() });
    const body = await envelopeOf(response);

    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe('string');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it('reports a route that does not exist as an envelope, not as HTML', async () => {
    const response = await app.request('/no/such/route');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await envelopeOf(response);
    expect(body.error.code).toBe('not_found');
    expect(body.error.details).toMatchObject({ path: '/no/such/route' });
  });
});

describe('details survives to the client', () => {
  it('carries every zod issue, with a dotted path per field', async () => {
    const response = await app.request('/campaigns', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ name: '', category: 'not-a-category' }),
    });

    expect(response.status).toBe(422);
    const body = await envelopeOf(response);
    expect(body.error.code).toBe('validation_failed');

    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(body.error.details, 'details must reach the client').toBeDefined();

    const details = body.error.details as { issues: { path: string; message: string }[] };
    expect(Array.isArray(details.issues)).toBe(true);
    expect(details.issues.length).toBeGreaterThan(0);

    // Specific enough to point a form field at. A client that only reads
    // code/message would render "validation failed" and leave the operator to
    // guess which of the fields they just filled in was wrong.
    const paths = details.issues.map((i) => i.path);
    expect(paths).toContain('category');
    for (const issue of details.issues) {
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it('carries EVERY activation failure at once, not just the first', async () => {
    // A marketing email with no unsubscribe link, an unknown merge field, and a
    // campaign whose only message is on a channel it does not send. Three separate
    // problems; an operator who has to discover them one round trip at a time gives
    // up around the third and mails the campaign from their laptop instead.
    const { campaignId } = await seedCampaign(testDb(), tenantId, {
      category: 'promotional',
      status: 'draft',
    });
    await seedCampaignMessage(testDb(), tenantId, campaignId, {
      channel: 'sms',
      body: 'Hi {{contact.frist_name}}, no way out of this one.',
      subject: null,
    });

    const response = await app.request(`/campaigns/${campaignId}/activate`, {
      method: 'POST',
      headers: auth(),
    });

    expect(response.status).toBe(422);
    const body = await envelopeOf(response);
    expect(body.error.code).toBe('campaign_not_activatable');
    expect(body.error.details).toBeDefined();

    const details = body.error.details as { failures: { code: string; message: string }[] };
    expect(details.failures.length).toBeGreaterThanOrEqual(2);

    const joined = details.failures.map((f) => f.message).join('\n');
    expect(joined).toMatch(/frist_name/);
    expect(joined).toMatch(/unsubscribe_url|preferences_url/);
    // The message text is a sentence a human can act on, not a code.
    for (const failure of details.failures) {
      expect(failure.message.length).toBeGreaterThan(20);
    }
  });

  it('names WHICH audience rule is wrong, not merely that one is', async () => {
    const response = await app.request('/audience/estimate', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        audience: { all: [{ field: 'not_a_real_field', op: 'eq', value: 'x' }] },
      }),
    });

    expect(response.status).toBe(422);
    const body = await envelopeOf(response);
    expect(body.error.code).toBe('audience_uncompilable');
    expect(body.error.details).toBeDefined();

    // `path` is what turns "your segment is broken" into "rule all[0] is broken",
    // which in a forty-rule segment is the whole difference.
    const details = body.error.details as { path: string };
    expect(typeof details.path).toBe('string');
    expect(details.path.length).toBeGreaterThan(0);
    expect(body.error.message).toContain('not_a_real_field');
  });

  it('names the resource and id on a 404', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const response = await app.request(`/campaigns/${missing}`, { headers: auth() });
    expect(response.status).toBe(404);

    const body = await envelopeOf(response);
    expect(body.error.details).toMatchObject({ resource: 'Campaign', id: missing });
  });

  it('names the contacts a test send would have reached', async () => {
    const contactId = await seedContact(testDb(), tenantId, { email: 'real.customer@example.com' });
    const { campaignId } = await seedCampaign(testDb(), tenantId, { status: 'active' });
    await seedCampaignMessage(testDb(), tenantId, campaignId, {});

    const response = await app.request(`/campaigns/${campaignId}/test-send`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ to: 'real.customer@example.com' }),
    });

    expect(response.status).toBe(409);
    const body = await envelopeOf(response);
    expect(body.error.code).toBe('test_send_would_reach_a_contact');

    const details = body.error.details as { to: string; matchedContactIds: string[] };
    expect(details.matchedContactIds).toContain(contactId);
    expect(details.to).toBe('real.customer@example.com');
  });

  it('carries the numbers a client needs to back off from a 429', async () => {
    const limited = boot({
      rateLimit: { limit: 10_000, windowMs: 60_000, publicLimit: 10_000, loginLimit: 1 },
    });

    await limited.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', password: 'nope' }),
    });
    const response = await limited.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', password: 'nope' }),
    });

    expect(response.status).toBe(429);
    const body = await envelopeOf(response);
    expect(body.error.details).toMatchObject({ bucket: 'login', limit: 1 });
    expect((body.error.details as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(response.headers.get('retry-after')).not.toBeNull();
  });
});

describe('details is withheld exactly where it should be', () => {
  it('says nothing specific about an unexpected server error', async () => {
    // The other half of the contract. `details` is for diagnoses the server chose
    // to publish; an unhandled exception's message can carry a connection string
    // or a fragment of a row, so the generic arm publishes none of it and the
    // request id ties the response back to the log line that has the stack.
    const exploding = {
      query: () => Promise.reject(new Error('connect ECONNREFUSED postgres://u:hunter2@db/prod')),
    } as unknown as Db;

    const broken = boot({ db: exploding });
    const response = await broken.request('/campaigns', { headers: auth() });

    expect(response.status).toBe(500);
    const body = await envelopeOf(response);
    expect(body.error.code).toBe('internal_error');
    expect(body.error.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(response.headers.get('x-request-id')).not.toBeNull();
  });

  it('does not say whether a login failed on the address or on the password', async () => {
    const password = 'correct horse battery staple';
    await seedOperator(testDb(), tenantId, password);

    const wrongPassword = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' }),
    });
    const noSuchUser = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'also-nobody@example.com', password: 'wrong' }),
    });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    const a = await envelopeOf(wrongPassword);
    const b = await envelopeOf(noSuchUser);
    expect(a.error.message).toBe(b.error.message);
    expect(a.error.details).toBeUndefined();
  });
});
