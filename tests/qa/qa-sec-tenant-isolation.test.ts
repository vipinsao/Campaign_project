/**
 * ATTACK: an authenticated operator of tenant A wants tenant B's rows.
 *
 * Two halves, and the second is the one that finds things.
 *
 *  1. READ/WRITE across the boundary on every id-taking route, with a bias towards
 *     the routes added most recently (`/campaigns/:id/flow`, `/tenant`,
 *     `/mock-outbox`, `/campaigns/:id/timeseries`) and the nested one where the
 *     child id could be checked against the parent OR the tenant but not both.
 *
 *  2. WRITES THAT LAND IN ANOTHER TENANT'S NUMBERS. Tenant isolation is not only
 *     "can A read B's rows". A route that lets A write a row which B's analytics
 *     then counts is the same boundary broken in the other direction, and it is
 *     invisible from A's side — which is why nothing catches it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { issueApiKey, type App } from '@campaign/api';
import { bootApp, seedWorld, authHeaders, QA_SECRET, type World } from './qa-sec-helpers.ts';

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

const asA = (extra: Record<string, string> = {}) => authHeaders(a.token, extra);

describe('every id-taking route refuses the other tenant', () => {
  it('refuses cross-tenant reads on the recently added routes', async () => {
    const routes = [
      `/campaigns/${b.campaignId}/flow`,
      `/campaigns/${b.campaignId}/timeseries`,
      `/campaigns/${b.campaignId}/timeseries?from=2026-01-01&to=2026-12-31`,
    ];
    for (const route of routes) {
      const response = await app.request(route, { headers: asA() });
      expect(response.status, `${route} leaked across the tenant boundary`).toBe(404);
    }
  });

  it('refuses PUT /campaigns/:id/flow on another tenant, and writes nothing', async () => {
    const flow = {
      nodes: [
        { id: 'n1', type: 'trigger' },
        { id: 'n2', type: 'send_email', data: { subject: 'Hi', body: 'Body {{unsubscribe_url}}', previewText: 'p' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const response = await app.request(`/campaigns/${b.campaignId}/flow`, {
      method: 'PUT',
      headers: asA(),
      body: JSON.stringify({ flow }),
    });
    expect(response.status).toBe(404);

    const { rows } = await testDb().query<{ flow_definition: unknown }>(
      `SELECT flow_definition FROM campaigns WHERE id = $1`,
      [b.campaignId],
    );
    expect(rows[0]!.flow_definition).toBeNull();
  });

  it('scopes /tenant and /mock-outbox to the calling tenant only', async () => {
    const tenant = (await (await app.request('/tenant', { headers: asA() })).json()) as {
      tenant: { id: string };
    };
    expect(tenant.tenant.id).toBe(a.tenantId);

    await testDb().query(
      `INSERT INTO mock_outbox (tenant_id, message_queue_id, channel, to_address, from_address,
                                body, provider_message_id, sent_at)
       VALUES ($1,$2,'email',$3,'from@example.com','SECRET BETA BODY','pm-beta', now())`,
      [b.tenantId, b.queuedMessageId, b.contactEmail],
    );

    const outbox = (await (await app.request('/mock-outbox', { headers: asA() })).json()) as {
      messages: { body: string }[];
      counts: { total: number };
    };
    expect(outbox.messages).toEqual([]);
    expect(outbox.counts.total).toBe(0);
  });

  it('will not let A patch or delete B\'s message by naming it under A\'s campaign', async () => {
    for (const method of ['PATCH', 'DELETE'] as const) {
      const response = await app.request(
        `/campaigns/${a.campaignId}/messages/${b.campaignMessageId}`,
        { method, headers: asA(), body: JSON.stringify({ bodyTemplate: 'stolen' }) },
      );
      expect(response.status, `${method} on a foreign message id must be 404`).toBe(404);
    }
    const { rows } = await testDb().query<{ body_template: string }>(
      `SELECT body_template FROM campaign_messages WHERE id = $1`,
      [b.campaignMessageId],
    );
    expect(rows[0]!.body_template).not.toBe('stolen');
  });

  it('refuses the remaining id-taking routes across the boundary', async () => {
    const cases: [string, RequestInit][] = [
      [`/queue/${b.queuedMessageId}/cancel`, { method: 'POST', body: '{}' }],
      [`/contacts/${b.contactId}/consent`, { method: 'GET' }],
      [`/contacts/${b.contactId}/consent`, { method: 'POST', body: JSON.stringify({ channel: 'email', state: 'opted_out' }) }],
      [`/orders/${b.orderId}/journey`, { method: 'GET' }],
      [`/campaigns/${b.campaignId}/preview`, { method: 'POST', body: '{}' }],
    ];
    for (const [route, init] of cases) {
      const response = await app.request(route, { ...init, headers: asA() });
      expect(response.status, `${init.method} ${route}`).toBe(404);
    }
  });

  it('will not render another tenant\'s contact into A\'s own campaign preview', async () => {
    // The merge context is the exfiltration channel: name, email and phone all come
    // back in `preview.context`.
    const response = await app.request(`/campaigns/${a.campaignId}/preview`, {
      method: 'POST',
      headers: asA(),
      body: JSON.stringify({ contactId: b.contactId }),
    });
    expect(response.status).toBe(404);

    const withOrder = await app.request(`/campaigns/${a.campaignId}/preview`, {
      method: 'POST',
      headers: asA(),
      body: JSON.stringify({ orderId: b.orderId }),
    });
    expect(withOrder.status).toBe(404);
  });

  it('DELETE /suppressions cannot lift another tenant\'s suppression', async () => {
    await testDb().query(
      `INSERT INTO suppressions (tenant_id, channel, address, reason) VALUES ($1,'email',$2,'unsubscribe')`,
      [b.tenantId, b.contactEmail],
    );
    const response = await app.request(
      `/suppressions?channel=email&address=${encodeURIComponent(b.contactEmail)}`,
      { method: 'DELETE', headers: asA() },
    );
    expect(response.status).toBe(404);
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM suppressions WHERE tenant_id = $1`,
      [b.tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe('writes that land in another tenant\'s numbers', () => {
  it('FIXED: POST /events REJECTS a campaignId belonging to another tenant', async () => {
    // The key names A. The contact is A's, so resolveContact is satisfied. But
    // `campaignId` is taken from the body and never checked against the tenant,
    // and message_events.campaign_id is a plain FK to campaigns(id).
    const key = issueApiKey(a.tenantId, QA_SECRET);
    const response = await app.request('/events', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'opened',
        contactId: a.contactId,
        campaignId: b.campaignId,
        channel: 'email',
        idempotencyKey: 'poison-1',
      }),
    });
    expect(response.status, 'an id from another tenant must not be accepted').toBe(404);
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_events WHERE campaign_id = $1 AND tenant_id = $2`,
      [b.campaignId, a.tenantId],
    );
    expect(
      { accepted: 0, rowsAttachedToBsCampaign: Number(rows[0]!.n) },
      'tenant A must not be able to write a row hanging off tenant B\'s campaign',
    ).toEqual({ accepted: 0, rowsAttachedToBsCampaign: 0 });
  });

  it('and that row is COUNTED by tenant B\'s own /campaigns/:id/timeseries', async () => {
    // The read side has no tenant predicate at all:
    //   FROM message_events WHERE campaign_id = $1
    // so whatever A wrote above lands in B's rangeUnique openers.
    const key = issueApiKey(a.tenantId, QA_SECRET);
    for (const [i, contact] of [a.contactId].entries()) {
      await app.request('/events', {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'opened',
          contactId: contact,
          campaignId: b.campaignId,
          channel: 'email',
          idempotencyKey: `poison-ts-${i}`,
        }),
      });
    }

    const response = await app.request(`/campaigns/${b.campaignId}/timeseries`, {
      headers: authHeaders(b.token),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rangeUnique: { openers: number } };
    expect(
      body.rangeUnique.openers,
      'tenant B\'s analytics counted an opener tenant A invented',
    ).toBe(0);
  });

  it('and a messageQueueId from another tenant inflates B\'s per-message stats', async () => {
    // /campaigns/:id/messages/stats joins message_events on message_queue_id with
    // no tenant predicate on the events side.
    const key = issueApiKey(a.tenantId, QA_SECRET);
    await app.request('/events', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'opened',
        contactId: a.contactId,
        messageQueueId: b.queuedMessageId,
        channel: 'email',
        idempotencyKey: 'poison-mq-1',
      }),
    });

    const response = await app.request(`/campaigns/${b.campaignId}/messages/stats`, {
      headers: authHeaders(b.token),
    });
    const body = (await response.json()) as { messages: { uniqueOpens: number }[] };
    expect(
      body.messages.map((m) => m.uniqueOpens),
      'tenant A attached an open to tenant B\'s queued message',
    ).toEqual([0]);
  });
});
