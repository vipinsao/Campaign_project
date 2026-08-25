/**
 * The happy paths, end to end through the real app.
 *
 * These are not "does the framework work" tests. Each one pins a behaviour that a
 * refactor could plausibly break without breaking anything that looks related:
 * that activation takes an immutable snapshot rather than just flipping a status,
 * that pausing holds messages instead of cancelling them, that duplicating a live
 * campaign produces a draft rather than a second live campaign, that the audience
 * estimate hands back the SQL it actually ran, and that an order-number lookup can
 * still say "I don't know".
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedTenant, seedContact } from '../support/fixtures.ts';
import { FakeClock } from '@campaign/core';
import { buildDeps, createApp, hashPassword, issueApiKey, type App } from '@campaign/api';

const CLOCK = new FakeClock('2026-06-15T12:00:00Z');
const SECRET = new TextEncoder().encode('api-routes-suite-secret');
const KEY = Buffer.alloc(32, 0x33);

const MARKETING_BODY =
  'Hi {{contact.first_name}}, thanks for shopping with us. ' + 'Unsubscribe: {{unsubscribe_url}}';

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

let app: App;
let tenantId: string;
let token: string;

afterAll(closeTestDb);
beforeAll(resetDb);

beforeEach(async () => {
  await resetDb();
  app = boot();
  tenantId = await seedTenant(testDb(), { name: 'Northwind Coffee' });
  token = await tokenFor(app, testDb(), tenantId);
});

function headers(): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected JSON, got ${response.status}: ${text.slice(0, 400)}`);
  }
}

async function createCampaign(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await app.request('/campaigns', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      name: 'Post-purchase follow-up',
      category: 'lifecycle',
      triggerType: 'manual',
      channels: ['email'],
      ...overrides,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = await json<{ campaign: { id: string } }>(response);
  return body.campaign.id;
}

async function addMessage(
  campaignId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await app.request(`/campaigns/${campaignId}/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      channel: 'email',
      sequenceOrder: 1,
      subjectTemplate: 'Thanks, {{contact.first_name}}',
      bodyTemplate: MARKETING_BODY,
      ...overrides,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await json<{ message: { id: string } }>(response)).message.id;
}

describe('campaign CRUD', () => {
  it('creates, reads, lists, patches and archives', async () => {
    const campaignId = await createCampaign();

    const read = await json<{ campaign: Record<string, unknown>; messages: unknown[] }>(
      await app.request(`/campaigns/${campaignId}`, { headers: headers() }),
    );
    expect(read.campaign['name']).toBe('Post-purchase follow-up');
    expect(read.campaign['status']).toBe('draft');
    expect(read.campaign['tenantId']).toBe(tenantId);
    expect(read.messages).toEqual([]);

    const list = await json<{ campaigns: { id: string }[]; page: { total: number } }>(
      await app.request('/campaigns', { headers: headers() }),
    );
    expect(list.campaigns.map((c) => c.id)).toContain(campaignId);
    expect(list.page.total).toBe(1);

    const patched = await json<{ campaign: Record<string, unknown> }>(
      await app.request(`/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ name: 'Renamed', description: 'Now with a description' }),
      }),
    );
    expect(patched.campaign['name']).toBe('Renamed');
    expect(patched.campaign['description']).toBe('Now with a description');
    // A patch that names two fields must not reset the ones it did not mention.
    expect(patched.campaign['category']).toBe('lifecycle');

    const archived = await json<{ campaign: Record<string, unknown> }>(
      await app.request(`/campaigns/${campaignId}`, { method: 'DELETE', headers: headers() }),
    );
    // Archived, not deleted: message_queue, message_events and send_decisions all
    // cascade from campaigns, so a DELETE would erase the record of everything the
    // campaign ever sent.
    expect(archived.campaign['status']).toBe('archived');
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('creates, lists, patches and removes campaign messages', async () => {
    const campaignId = await createCampaign();
    const messageId = await addMessage(campaignId);

    const listed = await json<{ messages: { id: string; sequenceOrder: number }[] }>(
      await app.request(`/campaigns/${campaignId}/messages`, { headers: headers() }),
    );
    expect(listed.messages).toHaveLength(1);
    expect(listed.messages[0]!.id).toBe(messageId);

    const patched = await json<{ message: Record<string, unknown> }>(
      await app.request(`/campaigns/${campaignId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ delayMinutes: 4320, sendCondition: 'not_opened_previous' }),
      }),
    );
    expect(patched.message['delayMinutes']).toBe(4320);
    expect(patched.message['sendCondition']).toBe('not_opened_previous');

    const deleted = await json<{ deleted: boolean }>(
      await app.request(`/campaigns/${campaignId}/messages/${messageId}`, {
        method: 'DELETE',
        headers: headers(),
      }),
    );
    expect(deleted.deleted).toBe(true);
  });
});

describe('activation', () => {
  it('snapshots a campaign_versions row and points the campaign at it', async () => {
    const campaignId = await createCampaign();
    await addMessage(campaignId);

    const activated = await json<{
      campaign: Record<string, unknown>;
      version: { id: string; version: number };
    }>(
      await app.request(`/campaigns/${campaignId}/activate`, {
        method: 'POST',
        headers: headers(),
      }),
    );

    expect(activated.campaign['status']).toBe('active');
    expect(activated.version.version).toBe(1);
    expect(activated.campaign['activeVersionId']).toBe(activated.version.id);

    const { rows } = await testDb().query<{ snapshot: { messages: unknown[]; reason: string } }>(
      `SELECT snapshot FROM campaign_versions WHERE id = $1`,
      [activated.version.id],
    );
    // The snapshot is the answer to "what did this recipient actually receive?"
    // asked after the operator rewrote the copy, so it has to contain the copy.
    expect(rows[0]!.snapshot.reason).toBe('activate');
    expect(rows[0]!.snapshot.messages).toHaveLength(1);

    // And it is immutable: campaign_versions carries an append-only trigger.
    await expect(
      testDb().query(`UPDATE campaign_versions SET version = 99 WHERE id = $1`, [
        activated.version.id,
      ]),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses to activate a campaign that does not validate, and changes nothing', async () => {
    const campaignId = await createCampaign({ category: 'promotional' });
    await addMessage(campaignId, { bodyTemplate: 'No way out of this one, sorry.' });

    const response = await app.request(`/campaigns/${campaignId}/activate`, {
      method: 'POST',
      headers: headers(),
    });
    expect(response.status).toBe(422);

    const { rows } = await testDb().query<{ status: string; n: string }>(
      `SELECT c.status,
              (SELECT count(*)::text FROM campaign_versions v WHERE v.campaign_id = c.id) AS n
         FROM campaigns c WHERE c.id = $1`,
      [campaignId],
    );
    expect(rows[0]!.status).toBe('draft');
    // No half-activation: a refused activation must not leave a version behind.
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('activating twice produces version 2 and leaves version 1 intact', async () => {
    const campaignId = await createCampaign();
    await addMessage(campaignId);

    await app.request(`/campaigns/${campaignId}/activate`, { method: 'POST', headers: headers() });
    const second = await json<{ version: { version: number } }>(
      await app.request(`/campaigns/${campaignId}/activate`, {
        method: 'POST',
        headers: headers(),
      }),
    );
    expect(second.version.version).toBe(2);

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM campaign_versions WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

describe('pause and duplicate', () => {
  it('pauses without cancelling anything already queued', async () => {
    const campaignId = await createCampaign();
    await addMessage(campaignId);
    await app.request(`/campaigns/${campaignId}/activate`, { method: 'POST', headers: headers() });

    const paused = await json<{ campaign: Record<string, unknown>; heldMessages: number }>(
      await app.request(`/campaigns/${campaignId}/pause`, { method: 'POST', headers: headers() }),
    );
    expect(paused.campaign['status']).toBe('paused');
    expect(paused.heldMessages).toBe(0);

    // The gate treats 'paused' as retryable, so nothing in flight is destroyed —
    // an operator pausing to fix a typo must not lose the queue.
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue
        WHERE campaign_id = $1 AND status = 'cancelled'`,
      [campaignId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('duplicates an active campaign as a DRAFT with its messages and no history', async () => {
    const campaignId = await createCampaign();
    await addMessage(campaignId);
    await app.request(`/campaigns/${campaignId}/activate`, { method: 'POST', headers: headers() });

    const copy = await json<{
      campaign: Record<string, unknown>;
      messages: { bodyTemplate: string }[];
    }>(
      await app.request(`/campaigns/${campaignId}/duplicate`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ name: 'Follow-up, second attempt' }),
      }),
    );

    expect(copy.campaign['name']).toBe('Follow-up, second attempt');
    // A duplicate that inherited `active` would start enrolling contacts the
    // instant it was created, which is never what "duplicate" means.
    expect(copy.campaign['status']).toBe('draft');
    expect(copy.campaign['activeVersionId']).toBeNull();
    expect(copy.messages).toHaveLength(1);
    expect(copy.messages[0]!.bodyTemplate).toBe(MARKETING_BODY);

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM campaign_versions WHERE campaign_id = $1`,
      [copy.campaign['id']],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('audience estimate', () => {
  it('returns the count, a sample, and the SQL it actually ran', async () => {
    await seedContact(testDb(), tenantId, { email: 'vip@example.com', tags: ['vip'] });
    await seedContact(testDb(), tenantId, { email: 'ordinary@example.com', tags: [] });

    const all = await json<{
      count: number;
      sample: { id: string; email: string | null }[];
      compiledSql: string;
      params: unknown[];
    }>(
      await app.request('/audience/estimate', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ audience: {} }),
      }),
    );
    expect(all.count).toBe(2);
    expect(all.sample).toHaveLength(2);

    const vips = await json<{ count: number; compiledSql: string; params: unknown[] }>(
      await app.request('/audience/estimate', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          audience: { all: [{ field: 'tags', op: 'contains', value: 'vip' }] },
        }),
      }),
    );
    expect(vips.count).toBe(1);

    // The disclosure is the feature: the operator can see what will run. It is
    // only safe because the compiler never interpolates a value into SQL text —
    // so the value appears in `params` and NOT in `compiledSql`.
    expect(vips.compiledSql).toContain('FROM contacts c');
    expect(vips.compiledSql).toMatch(/\$\d/);
    expect(vips.compiledSql).not.toContain("'vip'");
    // `contains` on a text[] field binds a one-element array, so the value is in
    // params — as data — and nowhere in the SQL text.
    expect(JSON.stringify(vips.params)).toContain('vip');
    expect(vips.params).toContain(tenantId);
  });

  it('agrees with /audience/matches about the same contact', async () => {
    const vip = await seedContact(testDb(), tenantId, { email: 'vip2@example.com', tags: ['vip'] });
    const other = await seedContact(testDb(), tenantId, { email: 'other@example.com', tags: [] });
    const audience = { all: [{ field: 'tags', op: 'contains', value: 'vip' }] };

    const matched = await json<{ matched: boolean; failedRule: string | null }>(
      await app.request('/audience/matches', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ audience, contactId: vip }),
      }),
    );
    const missed = await json<{ matched: boolean; failedRule: string | null }>(
      await app.request('/audience/matches', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ audience, contactId: other }),
      }),
    );

    expect(matched.matched).toBe(true);
    expect(missed.matched).toBe(false);
    // A non-match says which rule turned the contact away, in prose.
    expect(missed.failedRule).toContain('tags');
  });
});

describe('orders/lookup returns all three kinds', () => {
  async function seedStoreAndOrder(code: string, number: string): Promise<string> {
    const db = testDb();
    const { rows: store } = await db.query<{ id: string }>(
      `INSERT INTO stores (tenant_id, name, code) VALUES ($1,$2,$3) RETURNING id`,
      [tenantId, `Store ${code}`, code],
    );
    const contactId = await seedContact(db, tenantId, { email: `buyer-${code}@example.com` });
    await db.query(
      // 'delivered' is not a status you can simply assert: the schema's
      // orders_status_matches_timestamps CHECK requires the timestamps to agree
      // with it, and orders_delivery_follows_shipment requires them to be ordered.
      `INSERT INTO orders (tenant_id, store_id, contact_id, order_number, status, total,
                           placed_at, shipped_at, delivered_at)
       VALUES ($1,$2,$3,$4,'delivered',49.00,
               '2026-06-01T10:00:00Z','2026-06-02T10:00:00Z','2026-06-04T10:00:00Z')`,
      [tenantId, store[0]!.id, contactId, number],
    );
    return store[0]!.id;
  }

  it("says 'none' for an order number nobody has", async () => {
    const response = await app.request('/orders/lookup?number=NOPE-1', { headers: headers() });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ kind: 'none' });
  });

  it("says 'single' when exactly one order matches", async () => {
    await seedStoreAndOrder('north', 'NW-10423');

    const body = await json<{ kind: string; match: { orderNumber: string; storeCode: string } }>(
      await app.request('/orders/lookup?number=NW-10423', { headers: headers() }),
    );
    expect(body.kind).toBe('single');
    expect(body.match.orderNumber).toBe('NW-10423');
    expect(body.match.storeCode).toBe('north');
  });

  it("says 'ambiguous' — and picks nothing — when two stores share the number", async () => {
    await seedStoreAndOrder('north', 'SHARED-1');
    const southId = await seedStoreAndOrder('south', 'SHARED-1');

    const response = await app.request('/orders/lookup?number=SHARED-1', { headers: headers() });
    const body = await json<{ kind: string; candidates: { storeId: string }[] }>(response);

    expect(body.kind).toBe('ambiguous');
    expect(body.candidates).toHaveLength(2);
    expect(body).not.toHaveProperty('match');

    // The store id is the disambiguator, and supplying it collapses the answer.
    const narrowed = await json<{ kind: string; match: { storeCode: string } }>(
      await app.request(`/orders/lookup?number=SHARED-1&storeId=${southId}`, {
        headers: headers(),
      }),
    );
    expect(narrowed.kind).toBe('single');
    expect(narrowed.match.storeCode).toBe('south');
  });

  it('refuses a lookup with no order number rather than listing every order', async () => {
    const response = await app.request('/orders/lookup', { headers: headers() });
    expect(response.status).toBe(400);
  });
});

describe('supporting surfaces', () => {
  it('serves the merge-field catalogue and validates a template', async () => {
    const fields = await json<{ fields: { name: string }[] }>(
      await app.request('/merge-fields', { headers: headers() }),
    );
    expect(fields.fields.map((f) => f.name)).toContain('unsubscribe_url');

    const ok = await json<{ ok: boolean; mergeFields: string[] }>(
      await app.request('/templates/validate', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          channel: 'email',
          category: 'promotional',
          subjectTemplate: 'Hello',
          bodyTemplate: MARKETING_BODY,
        }),
      }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.mergeFields).toContain('unsubscribe_url');

    const bad = await json<{ ok: boolean; errors: { message: string }[] }>(
      await app.request('/templates/validate', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          channel: 'email',
          category: 'promotional',
          subjectTemplate: 'Hello',
          bodyTemplate: 'Hi {{contact.frist_name}}',
        }),
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => e.message).join(' ')).toMatch(/frist_name/);
  });

  it('answers liveness without the database and readiness with it', async () => {
    const healthz = await app.request('/healthz');
    expect(healthz.status).toBe(200);

    const readyz = await app.request('/readyz');
    expect(readyz.status).toBe(200);
    expect((await json<{ status: string }>(readyz)).status).toBe('ready');

    const metrics = await app.request('/metrics');
    expect(metrics.status).toBe(200);
    // The scrape must carry the matched ROUTE PATTERN, never the raw path — one
    // time series per campaign id is a cardinality explosion that takes the whole
    // endpoint down with it.
    const text = await metrics.text();
    expect(text).toContain('http_requests_total');
    expect(text).not.toMatch(/route="\/campaigns\/[0-9a-f-]{36}"/);
  });

  it('requires a token on every operator route', async () => {
    for (const route of ['/campaigns', '/merge-fields', '/queue', '/suppressions']) {
      const response = await app.request(route);
      expect(response.status, `${route} must require authentication`).toBe(401);
    }
  });
});

describe('suppressions, queue and the decision log', () => {
  it('adds, lists and removes a suppression WITHOUT rewriting consent', async () => {
    const contactId = await seedContact(testDb(), tenantId, { email: 'bounced@example.com' });

    const added = await app.request('/suppressions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        channel: 'email',
        address: 'bounced@example.com',
        reason: 'hard_bounce',
      }),
    });
    expect(added.status).toBe(201);

    const listed = await json<{ suppressions: { address: string; is_active: boolean }[] }>(
      await app.request('/suppressions?channel=email', { headers: headers() }),
    );
    expect(listed.suppressions.map((s) => s.address)).toContain('bounced@example.com');
    // Expiry is computed in the projection, so an expired row shows as expired
    // rather than vanishing — "why was this blocked?" needs the history.
    expect(listed.suppressions[0]!.is_active).toBe(true);

    const removed = await app.request('/suppressions?channel=email&address=bounced@example.com', {
      method: 'DELETE',
      headers: headers(),
    });
    expect(removed.status).toBe(200);

    // NO consent row is written, and that is the fix for a real bug.
    //
    // This route used to record a category-less `opted_in` here, reasoning that
    // lifting a block is a consent event. But consent resolves by most-recent
    // intent across wildcard and category rows — so writing a wildcard opt-in
    // silently reversed EVERY per-category opt-out the contact had ever made. An
    // operator tidying up a bounce list re-subscribed people to categories they
    // had deliberately switched off.
    //
    // Removing a hard-bounce suppression asserts the ADDRESS is deliverable again.
    // It says nothing about what the person wants. Those are different facts, they
    // live in different tables on purpose, and only a human may move the second.
    const { rows } = await testDb().query<{ state: string }>(
      `SELECT state FROM contact_consents WHERE contact_id = $1`,
      [contactId],
    );
    expect(rows, 'removing a deliverability block must not rewrite consent').toHaveLength(0);
  });

  it('refuses to remove a suppression that records the recipient’s own decision', async () => {
    // A hard bounce is a fact about the address. An unsubscribe is a decision by a
    // person, and undoing it is a consent action that has to be deliberate.
    await seedContact(testDb(), tenantId, { email: 'asked-to-stop@example.com' });
    await app.request('/suppressions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        channel: 'email',
        address: 'asked-to-stop@example.com',
        reason: 'unsubscribe',
      }),
    });

    const refused = await app.request(
      '/suppressions?channel=email&address=asked-to-stop@example.com',
      { method: 'DELETE', headers: headers() },
    );
    expect(refused.status).toBe(409);

    const acknowledged = await app.request(
      '/suppressions?channel=email&address=asked-to-stop@example.com&acknowledgeConsent=true',
      { method: 'DELETE', headers: headers() },
    );
    expect(acknowledged.status).toBe(200);
  });

  it('refuses a DELETE that does not identify the address', async () => {
    const response = await app.request('/suppressions', { method: 'DELETE', headers: headers() });
    expect(response.status).toBe(400);
  });

  it('cancels a queued message once, and logs the decision', async () => {
    const campaignId = await createCampaign();
    await addMessage(campaignId);
    await app.request(`/campaigns/${campaignId}/activate`, { method: 'POST', headers: headers() });

    const sent = await json<{ queuedMessageId: string | null }>(
      await app.request(`/campaigns/${campaignId}/test-send`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ to: 'qa@northwind.example.com' }),
      }),
    );
    expect(sent.queuedMessageId).not.toBeNull();

    const first = await app.request(`/queue/${sent.queuedMessageId}/cancel`, {
      method: 'POST',
      headers: headers(),
    });
    expect(first.status).toBe(200);

    // A second cancel is a 409, not a silent success: the row is no longer in a
    // state that can be cancelled, and saying "cancelled" about a message that is
    // already gone makes the queue lie about what was sent.
    const second = await app.request(`/queue/${sent.queuedMessageId}/cancel`, {
      method: 'POST',
      headers: headers(),
    });
    expect(second.status).toBe(409);

    const decisions = await json<{
      decisions: { reason_code: string }[];
      glossary: Record<string, string>;
    }>(await app.request(`/decisions?campaignId=${campaignId}`, { headers: headers() }));
    expect(decisions.decisions.length).toBeGreaterThanOrEqual(2);
    // The glossary travels with the log so a client never keeps its own copy of
    // the reason-code vocabulary, which would drift the first time one is added.
    for (const decision of decisions.decisions) {
      expect(Object.keys(decisions.glossary)).toContain(decision.reason_code);
    }
  });

  it('refuses an unfiltered scan of the decision log', async () => {
    const response = await app.request('/decisions', { headers: headers() });
    expect(response.status).toBe(400);
  });

  it('a test send may be repeated, and reaches only the test recipient', async () => {
    const campaignId = await createCampaign();
    await addMessage(campaignId);
    await app.request(`/campaigns/${campaignId}/activate`, { method: 'POST', headers: headers() });

    for (let i = 0; i < 2; i++) {
      const response = await app.request(`/campaigns/${campaignId}/test-send`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ to: 'qa2@northwind.example.com' }),
      });
      expect(response.status, await response.clone().text()).toBe(202);
    }

    // Two rows, not one. The dedup key is (campaign, message, contact, anchor), so
    // a repeated test send only works because each one gets a fresh anchor.
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue
        WHERE tenant_id = $1 AND recipient_address = 'qa2@northwind.example.com'`,
      [tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('ingests events by API key and deduplicates them on the caller’s own key', async () => {
    const contactId = await seedContact(testDb(), tenantId, { email: 'converter@example.com' });
    const key = issueApiKey(tenantId, SECRET);

    const post = () =>
      app.request('/events', {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'converted',
          email: 'converter@example.com',
          idempotencyKey: 'storefront-order-991',
        }),
      });

    const first = await json<{ accepted: number; duplicates: number }>(await post());
    const second = await json<{ accepted: number; duplicates: number }>(await post());

    expect(first.accepted).toBe(1);
    // The rollup is rebuilt from message_events, so a retried POST that recorded a
    // second conversion would not be a display bug — it would be the number.
    expect(second.duplicates).toBe(1);

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_events WHERE contact_id = $1`,
      [contactId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('rejects event ingest without a valid API key', async () => {
    const response = await app.request('/events', {
      method: 'POST',
      headers: { 'x-api-key': 'ce_nope_nope', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'converted', email: 'x@example.com' }),
    });
    expect(response.status).toBe(401);
  });
});
