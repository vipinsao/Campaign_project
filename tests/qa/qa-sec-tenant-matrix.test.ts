/**
 * ATTACK: the same question as qa-sec-tenant-isolation, asked by ENUMERATION.
 *
 * qa-sec-tenant-isolation.test.ts checks a hand-written list of routes, and a
 * hand-written list is exactly the control that fails when route forty-one is
 * added — the same failure mode app.ts's own comment names about the prefix list.
 * So this file walks the app's OWN route table, substitutes tenant B's identifiers
 * into every path parameter, drives each one with tenant A's token, and demands a
 * 404 from all of them. A route added tomorrow that forgets its tenant predicate
 * fails here without anybody remembering to add it.
 *
 * The second half is the cross-tenant surface that has no path parameter at all:
 * an id supplied in a QUERY STRING or a BODY. Those never appear in a route table,
 * so they get their own list.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../support/db.ts';
import type { App } from '@campaign/api';
import { bootApp, seedWorld, authHeaders, type World } from './qa-sec-helpers.ts';

let app: App;
let a: World;
let b: World;

afterAll(closeTestDb);
beforeAll(resetDb);

beforeEach(async () => {
  await resetDb();
  app = bootApp({ sendMode: 'mock' });
  a = await seedWorld(app, 'Alpha');
  b = await seedWorld(app, 'Beta');
});

/** Everything reachable without an operator session; a tenant check is meaningless there. */
const PUBLIC_PREFIXES = ['/t/', '/r/', '/u/', '/webhooks/', '/events', '/auth/', '/health', '/ready', '/metrics'];

type Registered = { readonly path: string; readonly method: string };

function routeTable(): Registered[] {
  const routes = (app as unknown as { routes: Registered[] }).routes;
  return routes.filter(
    (r) =>
      r.method !== 'ALL' &&
      r.path.includes(':') &&
      !PUBLIC_PREFIXES.some((prefix) => r.path.startsWith(prefix)),
  );
}

/** The same path with every parameter filled from tenant B. */
function pointedAtB(path: string): string {
  return path
    .replace('/campaigns/:id', `/campaigns/${b.campaignId}`)
    .replace('/contacts/:id', `/contacts/${b.contactId}`)
    .replace('/orders/:id', `/orders/${b.orderId}`)
    .replace('/queue/:id', `/queue/${b.queuedMessageId}`)
    .replace(':messageId', b.campaignMessageId);
}

/** A body good enough to reach the handler's tenant check rather than a 400 parse. */
function bodyFor(path: string): string {
  if (path.endsWith('/test-send')) return JSON.stringify({ to: 'qa-matrix@example.org', channel: 'email' });
  if (path.endsWith('/messages')) {
    return JSON.stringify({ channel: 'email', sequenceOrder: 9, bodyTemplate: 'x {{unsubscribe_url}}' });
  }
  if (path.endsWith('/consent')) return JSON.stringify({ channel: 'email', state: 'opted_out' });
  if (path.endsWith('/flow')) {
    return JSON.stringify({
      flow: {
        nodes: [
          { id: 'n1', type: 'trigger' },
          {
            id: 'n2',
            type: 'send_email',
            data: { subject: 'Hi', body: 'Body {{unsubscribe_url}}', previewText: 'p' },
          },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      },
    });
  }
  if (path.endsWith('/campaigns/:id')) return JSON.stringify({ name: 'stolen' });
  return '{}';
}

describe('every parameterised route, enumerated from the app itself', () => {
  it('answers 404 to tenant A pointing any of them at tenant B', async () => {
    const table = routeTable();
    // If the table ever comes back tiny, the enumeration has silently stopped
    // enumerating and every assertion below is vacuous.
    expect(table.length, 'the route table should list every id-taking route').toBeGreaterThan(15);

    const leaked: string[] = [];
    for (const route of table) {
      const path = pointedAtB(route.path);
      expect(path, `no substitution for ${route.path}`).not.toContain(':');

      const response = await app.request(path, {
        method: route.method,
        headers: authHeaders(a.token),
        ...(route.method === 'GET' || route.method === 'HEAD' ? {} : { body: bodyFor(route.path) }),
      });
      if (response.status !== 404) {
        leaked.push(`${route.method} ${route.path} -> ${response.status}`);
      }
    }

    expect(leaked, "tenant A reached tenant B's rows on these routes").toEqual([]);
  });

  it('is not vacuous: the same GETs answer for the tenant that owns the rows', async () => {
    // A 404 above proves nothing if the URL is simply wrong. Every GET in the table
    // must be a live route for B's own token, which is what makes A's 404 a refusal
    // rather than a typo.
    const dead: string[] = [];
    for (const route of routeTable()) {
      if (route.method !== 'GET') continue;
      const response = await app.request(pointedAtB(route.path), { headers: authHeaders(b.token) });
      if (response.status === 404) dead.push(`GET ${route.path}`);
    }
    expect(dead, 'these URLs 404 for their own tenant, so the matrix above proved nothing').toEqual([]);
  });
});

describe('cross-tenant ids that arrive in a query string or a body', () => {
  it('ignores another tenant\'s id in every list filter', async () => {
    const probes = [
      `/queue?campaignId=${b.campaignId}`,
      `/queue?contactId=${b.contactId}`,
      `/decisions?campaignId=${b.campaignId}`,
      `/decisions?contactId=${b.contactId}`,
      `/decisions?orderId=${b.orderId}`,
      `/orders?contactId=${b.contactId}`,
    ];
    for (const probe of probes) {
      const response = await app.request(probe, { headers: authHeaders(a.token) });
      expect(response.status, probe).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value)) expect(value.length, `${probe} -> ${key}`).toBe(0);
      }
    }
  });

  it('will not confirm anything about another tenant\'s contact through /audience/matches', async () => {
    // `{}` is "match everyone", so an unscoped evaluation would answer `true` for
    // any contact id in the database and turn this endpoint into an existence
    // oracle for another tenant's contacts.
    const response = await app.request('/audience/matches', {
      method: 'POST',
      headers: authHeaders(a.token),
      body: JSON.stringify({ contactId: b.contactId, audience: {} }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { matched: boolean };
    expect(body.matched, "a match-everyone audience matched another tenant's contact").toBe(false);
  });

  it('will not estimate over another tenant\'s contacts', async () => {
    const response = await app.request('/audience/estimate', {
      method: 'POST',
      headers: authHeaders(a.token),
      body: JSON.stringify({ audience: {} }),
    });
    const body = (await response.json()) as { count: number; sample: { email: string }[] };
    expect(body.count, 'the estimate counted contacts outside the calling tenant').toBe(1);
    expect(body.sample.map((s) => s.email)).toEqual([a.contactEmail]);
  });

  it('will not let A name B\'s campaign as the source of an audience', async () => {
    const response = await app.request('/audience/estimate', {
      method: 'POST',
      headers: authHeaders(a.token),
      body: JSON.stringify({ campaignId: b.campaignId }),
    });
    expect(response.status).toBe(404);
  });

  it('will not let A name B\'s message id inside a preview of A\'s own campaign', async () => {
    // The campaign is A's, so the tenant check on the campaign passes; the message
    // id is B's. If it were honoured, B's copy would render back to A.
    const response = await app.request(`/campaigns/${a.campaignId}/preview`, {
      method: 'POST',
      headers: authHeaders(a.token),
      body: JSON.stringify({ campaignMessageId: b.campaignMessageId }),
    });
    expect(response.status).toBe(404);
  });
});
