/**
 * ATTACK: the prefix middleware list in app.ts, and the operator token itself.
 *
 * app.ts authenticates by PATH PREFIX. Its own comment says the failure mode being
 * prevented is "the forty-first route is added without it, and nothing fails — the
 * route works perfectly, for everybody, with no tenant". That control is only as
 * good as the prefix list, so this file enumerates the app's OWN route table and
 * demands a 401 from every route that is not on the documented public list. A route
 * added tomorrow under a path nobody added a prefix for fails here, not in
 * production.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { SignJWT } from 'jose';
import { createHmac } from 'node:crypto';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { signOperatorToken, verifyApiKey, issueApiKey, type App } from '@campaign/api';
import { FakeClock } from '@campaign/core';
import { bootApp, seedWorld, authHeaders, QA_SECRET, type World } from './qa-sec-helpers.ts';

/** Everything app.ts deliberately leaves unauthenticated, by design. */
const PUBLIC_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/metrics',
  '/auth/login',
  '/t/o/:trackingId',
  '/t/c/:shortCode',
  '/r/:shortCode',
  '/u/:token',
  '/webhooks/:provider',
]);
/** Authenticated by API key rather than an operator session. */
const API_KEY_PATHS = new Set(['/events']);

let app: App;
let a: World;
let b: World;

afterAll(closeTestDb);
beforeAll(resetDb);

beforeEach(async () => {
  await resetDb();
  app = bootApp();
  a = await seedWorld(app, 'Alpha');
  b = await seedWorld(app, 'Beta');
});

function concreteFor(path: string): string {
  return path
    .replace(':trackingId', a.trackingId)
    .replace(':shortCode', 'abcdefgh')
    .replace(':token', 'nope')
    .replace(':provider', 'mock')
    .replace(':messageId', a.campaignMessageId)
    .replace(':id', a.campaignId);
}

describe('every route in the table is behind a guard unless it is deliberately public', () => {
  it('answers 401 to an unauthenticated request on every non-public route', async () => {
    // Hono exposes its own routing table; using it rather than a hand-written list
    // is the whole point — a route added without a matching prefix shows up here.
    const routes = (app as unknown as { routes: { path: string; method: string }[] }).routes;
    const handlers = routes.filter(
      (r) => r.method !== 'ALL' && !r.path.endsWith('*') && r.path !== '/*',
    );
    expect(handlers.length).toBeGreaterThan(30);

    const unguarded: string[] = [];
    for (const route of handlers) {
      if (PUBLIC_PATHS.has(route.path) || API_KEY_PATHS.has(route.path)) continue;
      const response = await app.request(concreteFor(route.path), {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        ...(route.method === 'GET' || route.method === 'HEAD' ? {} : { body: '{}' }),
      });
      if (response.status !== 401) {
        unguarded.push(`${route.method} ${route.path} -> ${response.status}`);
      }
    }

    expect(unguarded, 'these routes answered without an operator token').toEqual([]);
  });

  it('rate-limits nothing before authentication on operator paths (informational)', async () => {
    // requireOperator runs BEFORE operatorLimit, so an unauthenticated flood on an
    // operator path is never counted against any bucket. Recorded, not asserted as
    // a failure: the 401 is cheap and this is a capacity note, not a bypass.
    const response = await app.request('/campaigns');
    expect(response.status).toBe(401);
    expect(response.headers.get('x-ratelimit-limit')).toBeNull();
  });
});

describe('the operator token', () => {
  it('rejects alg:none', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: a.userId,
        tenantId: a.tenantId,
        email: 'x@example.com',
        role: 'owner',
        iss: 'campaign-engine',
        aud: 'campaign-engine/api',
        exp: 4_102_444_800,
      }),
    ).toString('base64url');
    const response = await app.request('/auth/me', {
      headers: { authorization: `Bearer ${header}.${payload}.` },
    });
    expect(response.status).toBe(401);
  });

  it('rejects a token whose signature is HMACd with the wrong key', async () => {
    const forged = await new SignJWT({ tenantId: b.tenantId, email: 'x@example.com', role: 'owner' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(b.userId)
      .setIssuer('campaign-engine')
      .setAudience('campaign-engine/api')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('not the server secret'));
    const response = await app.request('/auth/me', { headers: { authorization: `Bearer ${forged}` } });
    expect(response.status).toBe(401);
  });

  it('enforces expiry against the injected clock', async () => {
    const expired = await signOperatorToken(
      { userId: a.userId, tenantId: a.tenantId, email: 'x@example.com', role: 'owner' },
      QA_SECRET,
      new FakeClock('2026-06-15T12:00:00Z'),
      60,
    );
    const later = bootApp({ clock: new FakeClock('2026-06-15T13:00:00Z') });
    const response = await later.request('/auth/me', { headers: { authorization: `Bearer ${expired}` } });
    expect(response.status).toBe(401);
  });

  it('refuses a replay after the user row is deleted', async () => {
    await testDb().query(`DELETE FROM users WHERE id = $1`, [a.userId]);
    const response = await app.request('/campaigns', { headers: authHeaders(a.token) });
    expect(response.status).toBe(401);
  });

  it('refuses a token whose tenant claim no longer matches the DB row', async () => {
    // The comment on requireOperator claims the tenant is re-checked against the
    // database rather than trusted from the token. Move the user to B and the old
    // token must stop working, rather than continuing to grant A for twelve hours.
    await testDb().query(`UPDATE users SET tenant_id = $2 WHERE id = $1`, [a.userId, b.tenantId]);
    const response = await app.request('/campaigns', { headers: authHeaders(a.token) });
    expect(response.status, 'a token for a tenant the user has left must not work').toBe(401);
  });

  it('does not let a valid token for tenant A be redirected at tenant B by any input', async () => {
    for (const attempt of [
      app.request(`/campaigns?tenantId=${b.tenantId}`, { headers: authHeaders(a.token) }),
      app.request('/campaigns', { headers: authHeaders(a.token, { 'x-tenant-id': b.tenantId }) }),
    ]) {
      const body = (await (await attempt).json()) as { campaigns: { tenantId: string }[] };
      expect(body.campaigns.every((c) => c.tenantId === a.tenantId)).toBe(true);
    }
  });
});

describe('the ingest API key', () => {
  it('cannot be forged without the server secret', async () => {
    const guesses = [
      `ce_${b.tenantId}_`,
      `ce_${b.tenantId}_${createHmac('sha256', 'guess').update(`api-key:${b.tenantId}`).digest('base64url')}`,
      `ce_${b.tenantId}_${'A'.repeat(43)}`,
      issueApiKey(b.tenantId, new TextEncoder().encode('a different secret')),
    ];
    for (const key of guesses) {
      expect(verifyApiKey(key, QA_SECRET)).toBeUndefined();
      const response = await app.request('/events', {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'converted', contactId: b.contactId }),
      });
      expect(response.status).toBe(401);
    }
  });

  it('IS STILL THE LIVE SCHEME even though migration 0010 added an api_keys table', async () => {
    // The table exists...
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'api_keys'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);

    // ...and nothing has ever written to it, yet a key still authenticates. The
    // HMAC scheme is a pure function of (tenant, server secret): it cannot be
    // revoked or rotated per key, and there is no last_used_at trail.
    const key = issueApiKey(a.tenantId, QA_SECRET);
    const response = await app.request('/events', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'converted', contactId: a.contactId }),
    });
    expect(response.status).toBe(200);

    const { rows: keys } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM api_keys`,
    );
    expect(
      Number(keys[0]!.n),
      'api_keys is dead schema: the unrevocable HMAC scheme is what actually authenticates /events',
    ).toBeGreaterThan(0);
  });
});
