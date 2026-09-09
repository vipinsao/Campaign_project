/**
 * ATTACK: the four unauthenticated routes an email client reaches, and the
 * provider callback endpoint.
 *
 * These have no session and cannot have one. The capability IS the URL, so the
 * questions are: how big is the capability, how long does it last, and what can
 * somebody who holds one do to somebody who does not.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { mintUnsubscribeToken, sealSecret, type App } from '@campaign/api';
import { signMockWebhook, MOCK_SIGNATURE_HEADER } from '@campaign/providers';
import { bootApp, seedWorld, QA_ENC_KEY, type World } from './qa-sec-helpers.ts';

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

describe('GET/POST /u/:token — the preference centre', () => {
  it('cannot be pointed at another contact', async () => {
    const tokenForA = await mintUnsubscribeToken(testDb(), {
      tenantId: a.tenantId,
      contactId: a.contactId,
      messageQueueId: a.queuedMessageId,
    });

    const response = await app.request(`/u/${tokenForA}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'unsubscribe_all',
        contactId: b.contactId,
        tenantId: b.tenantId,
      }),
    });
    expect(response.status).toBe(200);

    // The body's contactId is ignored: the token is the only identity.
    const { rows } = await testDb().query<{ contact_id: string }>(
      `SELECT DISTINCT contact_id FROM contact_consents WHERE state = 'opted_out'`,
    );
    expect(rows.map((r) => r.contact_id)).toEqual([a.contactId]);
  });

  it('does not distinguish an unknown token from a used one', async () => {
    const token = await mintUnsubscribeToken(testDb(), {
      tenantId: a.tenantId,
      contactId: a.contactId,
    });
    await app.request(`/u/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'unsubscribe_all' }),
    });

    const unknown = await app.request(`/u/${'x'.repeat(43)}`);
    expect(unknown.status).toBe(404);
  });

  it('IS A PERMANENT, UNREVOKABLE BEARER CAPABILITY', async () => {
    // `used_at` is written and never read. There is no expiry column and no
    // revocation path, so the link in a message sent three years ago still opens a
    // page showing the contact's name, email, phone and tenant, and still applies
    // preference changes — to anyone who has the URL, including every mail gateway,
    // archive and shared-inbox the message ever passed through.
    const token = await mintUnsubscribeToken(testDb(), {
      tenantId: a.tenantId,
      contactId: a.contactId,
    });

    const first = await app.request(`/u/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'unsubscribe_all' }),
    });
    expect(first.status).toBe(200);

    const { rows } = await testDb().query<{ used_at: Date | null }>(
      `SELECT used_at FROM unsubscribe_tokens WHERE token = $1`,
      [token],
    );
    expect(rows[0]!.used_at).not.toBeNull();

    const replay = await app.request(`/u/${token}`);
    const page = await replay.text();
    expect(replay.status).toBe(200);
    expect(page).toContain(a.contactEmail);
    expect(
      replay.status,
      'a token already marked used still discloses the contact and still applies changes',
    ).toBe(404);
  });
});

describe('GET /t/o/:trackingId — the open pixel', () => {
  it('answers identically for a real and an invented tracking id', async () => {
    const real = await app.request(`/t/o/${a.trackingId}`);
    const fake = await app.request(`/t/o/${randomUUID()}`);
    const junk = await app.request('/t/o/not-a-uuid');
    for (const response of [real, fake, junk]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/gif');
    }
    expect((await real.arrayBuffer()).byteLength).toBe((await fake.arrayBuffer()).byteLength);
  });

  it('lets anyone holding the pixel URL inflate the open count at will', async () => {
    // The idempotency key is trackingId : UTC date : sha256(user-agent)[0..16].
    // Two of those three are fixed and the third is chosen by the caller, so the
    // dedup window is per-user-agent-string and the caller picks the user agent.
    for (let i = 0; i < 25; i += 1) {
      const response = await app.request(`/t/o/${a.trackingId}`, {
        headers: { 'user-agent': `Mozilla/5.0 (inflate ${i})` },
      });
      expect(response.status).toBe(200);
    }

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_events
        WHERE message_queue_id = $1 AND event_type = 'opened'`,
      [a.queuedMessageId],
    );
    expect(
      Number(rows[0]!.n),
      'one recipient turned a single message into an arbitrary number of opens',
    ).toBe(1);
  });
});

describe('POST /webhooks/:provider', () => {
  async function credentialFor(tenantId: string, secret: string, label = 'primary'): Promise<void> {
    const sealed = sealSecret(secret, QA_ENC_KEY);
    await testDb().query(
      `INSERT INTO provider_credentials
         (tenant_id, channel, provider, label, from_address, secret_ciphertext, secret_iv, secret_tag)
       VALUES ($1,'email','mock',$2,'from@example.com',$3,$4,$5)`,
      [tenantId, label, sealed.ciphertext, sealed.iv, sealed.tag],
    );
  }

  function signedBody(
    events: unknown[],
    secret: string,
  ): { body: Buffer; headers: Record<string, string> } {
    const body = Buffer.from(JSON.stringify({ events }), 'utf8');
    return {
      body,
      headers: {
        'content-type': 'application/json',
        [MOCK_SIGNATURE_HEADER]: signMockWebhook(body, secret),
      },
    };
  }

  it('rejects an unsigned payload but PERSISTS IT FIRST, as designed', async () => {
    await credentialFor(a.tenantId, 'alpha-secret');
    const response = await app.request('/webhooks/mock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });
    expect(response.status).toBe(401);

    const { rows } = await testDb().query<{ signature_status: string; tenant_id: string | null }>(
      `SELECT signature_status, tenant_id FROM webhook_deliveries`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signature_status).toBe('missing');
    expect(rows[0]!.tenant_id).toBeNull();
  });

  it('rejects a payload signed with the wrong secret', async () => {
    await credentialFor(a.tenantId, 'alpha-secret');
    const { body, headers } = signedBody([], 'the wrong secret');
    const response = await app.request('/webhooks/mock', { method: 'POST', headers, body });
    expect(response.status).toBe(401);
  });

  it("cannot mark another tenant's message delivered", async () => {
    await credentialFor(a.tenantId, 'alpha-secret');
    await credentialFor(b.tenantId, 'beta-secret');

    // Signed correctly for A, naming B's provider_message_id.
    const { body, headers } = signedBody(
      [
        {
          providerMessageId: 'pmid-beta',
          type: 'delivered',
          occurredAt: '2026-06-15T12:00:00Z',
          providerEventId: 'evt-cross-1',
        },
      ],
      'alpha-secret',
    );
    const response = await app.request('/webhooks/mock', { method: 'POST', headers, body });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as { tenantId: string; eventsAccepted: number };
    expect(outcome.tenantId).toBe(a.tenantId);
    expect(outcome.eventsAccepted).toBe(0);

    const { rows } = await testDb().query<{ status: string; delivered_at: Date | null }>(
      `SELECT status, delivered_at FROM message_queue WHERE id = $1`,
      [b.queuedMessageId],
    );
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.delivered_at).toBeNull();
  });

  it('cannot be redirected at another tenant with the x-tenant-id hint', async () => {
    await credentialFor(a.tenantId, 'alpha-secret');
    await credentialFor(b.tenantId, 'beta-secret');
    const { body, headers } = signedBody(
      [
        {
          providerMessageId: 'pmid-beta',
          type: 'delivered',
          occurredAt: '2026-06-15T12:00:00Z',
          providerEventId: 'evt-hint-1',
        },
      ],
      'alpha-secret',
    );
    const response = await app.request('/webhooks/mock', {
      method: 'POST',
      headers: { ...headers, 'x-tenant-id': b.tenantId },
      body,
    });
    expect(response.status).toBe(401);
  });

  it('lets an unauthenticated caller fill webhook_deliveries with 1 MB rows', async () => {
    // Persist-before-validate is the right call for replay, but the row is written
    // before ANY authentication and kept forever. `mock` is always an accepted
    // provider name, so the only cost to the attacker is bandwidth.
    const payload = JSON.stringify({ junk: 'x'.repeat(200_000) });
    for (let i = 0; i < 5; i += 1) {
      const response = await app.request('/webhooks/mock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      expect(response.status).toBe(401);
    }

    const { rows } = await testDb().query<{ n: string; bytes: string }>(
      `SELECT count(*)::text AS n, coalesce(sum(pg_column_size(payload)),0)::text AS bytes
         FROM webhook_deliveries`,
    );
    expect(
      { rows: Number(rows[0]!.n), bytes: Number(rows[0]!.bytes) },
      'unauthenticated writes to a table with no retention policy',
    ).toEqual({ rows: 0, bytes: 0 });
  });
});
