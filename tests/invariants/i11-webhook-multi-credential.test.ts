/**
 * I11 — a tenant may hold SEVERAL active credentials, and every one of them works.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The bug this test exists to make impossible is a single-row lookup:
 *
 *     SELECT ... FROM provider_credentials WHERE tenant_id = $1 AND provider = $2
 *     LIMIT 1                       -- or .single(), or [0], or "the" credential
 *
 * That query is correct in every demo, in every seed script, and in every test
 * that seeds one credential. It becomes wrong the first time a tenant holds two —
 * which happens for entirely ordinary reasons: a migration between providers with
 * an overlap window, a per-brand sending identity, a key being rotated. From that
 * moment, callbacks signed with the credential that did not sort first are
 * rejected with a 401.
 *
 * And nobody investigates, because a 401 on a public webhook endpoint looks like
 * somebody probing you, not like a defect. Meanwhile every delivery receipt,
 * bounce and complaint for those callbacks is silently lost, delivery rate reads
 * artificially low, and hard-bounced addresses are never suppressed — so the
 * sender keeps mailing them and the domain reputation degrades.
 *
 * So this suite seeds THREE credentials and signs with each in turn, including the
 * last. It also pins the other two halves of I11: the raw payload is persisted
 * BEFORE the signature is checked, and an unverifiable payload FAILS CLOSED.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import {
  seedTenant,
  seedContact,
  seedCampaign,
  seedCampaignMessage,
  seedEnrollment,
} from '../support/fixtures.ts';
import { FakeClock } from '@campaign/core';
import { buildMockWebhookRequest, MOCK_SIGNATURE_HEADER } from '@campaign/providers';
import type { ProviderEvent } from '@campaign/shared';
import { buildDeps, createApp, sealSecret, type App } from '@campaign/api';

const CLOCK = new FakeClock('2026-06-15T12:00:00Z');
const SECRET = new TextEncoder().encode('i11-suite-secret');
const KEY = Buffer.alloc(32, 0xab);

/** Three credentials, three different secrets. The order matters to the test. */
const CREDENTIALS = [
  { label: 'primary', secret: 'secret-one-the-original' },
  { label: 'secondary', secret: 'secret-two-the-second-brand' },
  { label: 'rotating', secret: 'secret-three-the-one-being-rotated-in' },
] as const;

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

async function seedCredentials(tenantId: string): Promise<Record<string, string>> {
  const db = testDb();
  const ids: Record<string, string> = {};
  for (const credential of CREDENTIALS) {
    const sealed = sealSecret(credential.secret, KEY);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO provider_credentials
         (tenant_id, channel, provider, label, from_address,
          secret_ciphertext, secret_iv, secret_tag, is_active)
       VALUES ($1,'email','mock',$2,$3,$4,$5,$6,true) RETURNING id`,
      [
        tenantId,
        credential.label,
        `${credential.label}@northwind.example.com`,
        sealed.ciphertext,
        sealed.iv,
        sealed.tag,
      ],
    );
    ids[credential.label] = rows[0]!.id;
  }
  return ids;
}

/** A sent message the callbacks can refer to, so the ingest has somewhere to land. */
async function seedSentMessage(tenantId: string, providerMessageId: string): Promise<string> {
  const db = testDb();
  const contactId = await seedContact(db, tenantId, {
    email: `r-${Math.random().toString(36).slice(2, 8)}@example.com`,
  });
  const { campaignId, versionId } = await seedCampaign(db, tenantId, { status: 'active' });
  const campaignMessageId = await seedCampaignMessage(db, tenantId, campaignId, {});
  const enrollmentId = await seedEnrollment(db, tenantId, campaignId, versionId, contactId);

  const { rows } = await db.query<{ id: string; recipient_address: string }>(
    `INSERT INTO message_queue
       (tenant_id, enrollment_id, campaign_id, campaign_version_id, campaign_message_id,
        contact_id, anchor_id, channel, recipient_address, rendered_body, scheduled_at,
        status, provider, provider_message_id, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid(),'email',$7,'body',
             '2026-06-15T09:00:00Z','sent','mock',$8,'2026-06-15T09:00:01Z')
     RETURNING id, recipient_address`,
    [
      tenantId,
      enrollmentId,
      campaignId,
      versionId,
      campaignMessageId,
      contactId,
      `r-${Math.random().toString(36).slice(2, 8)}@example.com`,
      providerMessageId,
    ],
  );
  return rows[0]!.id;
}

function deliveredEvent(providerMessageId: string, suffix: string): ProviderEvent {
  return {
    providerMessageId,
    type: 'delivered',
    occurredAt: new Date('2026-06-15T10:00:00Z'),
    providerEventId: `${providerMessageId}:delivered:${suffix}`,
  };
}

async function post(app: App, headers: Record<string, string>, body: Buffer): Promise<Response> {
  return app.request('/webhooks/mock', { method: 'POST', headers, body: new Uint8Array(body) });
}

let app: App;
let tenantId: string;
let credentialIds: Record<string, string>;

afterAll(closeTestDb);
beforeAll(resetDb);

beforeEach(async () => {
  await resetDb();
  app = boot();
  tenantId = await seedTenant(testDb(), { name: 'Northwind Coffee' });
  credentialIds = await seedCredentials(tenantId);
});

describe('I11 — every active credential is tried', () => {
  it('the tenant really does hold three active credentials', async () => {
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM provider_credentials
        WHERE tenant_id = $1 AND provider = 'mock' AND is_active`,
      [tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(3);
  });

  it('accepts a payload signed by EACH credential in turn — including the third', async () => {
    for (const [index, credential] of CREDENTIALS.entries()) {
      const providerMessageId = `mock-${credential.label}`;
      const queueId = await seedSentMessage(tenantId, providerMessageId);

      const { headers, body } = buildMockWebhookRequest(
        [deliveredEvent(providerMessageId, credential.label)],
        credential.secret,
      );
      const response = await post(app, headers, body);

      expect(
        response.status,
        `credential #${index + 1} ('${credential.label}') must validate. A single-row ` +
          'lookup passes for the first and rejects every one after it.',
      ).toBe(200);

      const result = (await response.json()) as {
        credentialId: string;
        credentialsTried: number;
        eventsAccepted: number;
        tenantId: string;
      };

      // The endpoint reports how many it considered. Three means it iterated.
      expect(result.credentialsTried).toBe(3);
      expect(result.credentialId).toBe(credentialIds[credential.label]);
      expect(result.tenantId).toBe(tenantId);
      expect(result.eventsAccepted).toBe(1);

      // And the event actually landed: I9 — `delivered_at` written only from a receipt.
      const { rows } = await testDb().query<{ status: string; delivered_at: Date | null }>(
        `SELECT status, delivered_at FROM message_queue WHERE id = $1`,
        [queueId],
      );
      expect(rows[0]!.status).toBe('delivered');
      expect(rows[0]!.delivered_at).not.toBeNull();
    }
  });

  it('keeps working when the FIRST credential can no longer be opened', async () => {
    // A ciphertext that will not decrypt — a key rotated without re-encrypting the
    // rows, which is the realistic version of this. The loop must skip it and go
    // on, rather than abandoning the search at the first bad row: a `throw` there
    // is the single-credential bug wearing a different hat.
    await testDb().query(`UPDATE provider_credentials SET secret_ciphertext = $2 WHERE id = $1`, [
      credentialIds['primary'],
      Buffer.from('not a valid ciphertext at all'),
    ]);

    const providerMessageId = 'mock-after-a-broken-row';
    await seedSentMessage(tenantId, providerMessageId);
    const { headers, body } = buildMockWebhookRequest(
      [deliveredEvent(providerMessageId, 'skip')],
      CREDENTIALS[2].secret,
    );

    const response = await post(app, headers, body);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { credentialId: string }).credentialId).toBe(
      credentialIds['rotating'],
    );
  });

  it('ignores a deactivated credential rather than accepting it', async () => {
    await testDb().query(`UPDATE provider_credentials SET is_active = false WHERE id = $1`, [
      credentialIds['secondary'],
    ]);

    const providerMessageId = 'mock-deactivated';
    await seedSentMessage(tenantId, providerMessageId);
    const { headers, body } = buildMockWebhookRequest(
      [deliveredEvent(providerMessageId, 'deactivated')],
      CREDENTIALS[1].secret,
    );

    const response = await post(app, headers, body);
    expect(response.status).toBe(401);
    const envelope = (await response.json()) as {
      error: { details: { credentialsTried: number } };
    };
    expect(envelope.error.details.credentialsTried).toBe(2);
  });

  it('has no single-row credential lookup anywhere in the API source', async () => {
    // The behavioural assertions above are the real proof; this one catches the
    // shape of the mistake before it can be reintroduced by a refactor that only
    // ever runs against a one-credential fixture.
    const root = fileURLToPath(new URL('../../packages/api/src', import.meta.url));
    const offenders: string[] = [];

    async function* walk(dir: string): AsyncGenerator<string> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else if (entry.name.endsWith('.ts')) yield full;
      }
    }

    for await (const file of walk(root)) {
      const text = await readFile(file, 'utf8');
      const credentialQueries = text
        .split(/\n\s*\n/)
        .filter((block) => block.includes('provider_credentials'));
      for (const block of credentialQueries) {
        if (/\.single\(|LIMIT\s+1|queryOne</i.test(block)) {
          offenders.push(`${path.relative(root, file)}: ${block.trim().slice(0, 200)}`);
        }
      }
    }

    expect(
      offenders,
      'provider_credentials must always be read as a LIST and iterated:\n' + offenders.join('\n'),
    ).toEqual([]);
  });
});

describe('I11 — persist before validating, then fail closed', () => {
  it('stores the raw payload of a BADLY SIGNED callback and still rejects it', async () => {
    const providerMessageId = 'mock-forged';
    await seedSentMessage(tenantId, providerMessageId);

    const { body } = buildMockWebhookRequest(
      [deliveredEvent(providerMessageId, 'forged')],
      'a secret nobody configured',
    );
    const response = await post(
      app,
      { 'content-type': 'application/json', [MOCK_SIGNATURE_HEADER]: 'deadbeef'.repeat(8) },
      body,
    );

    // Fail closed. Not "process it anyway", not 200-and-ignore.
    expect(response.status).toBe(401);

    const { rows } = await testDb().query<{
      signature_status: string;
      tenant_id: string | null;
      payload: { events: { providerEventId: string }[] };
      processed_at: Date | null;
    }>(`SELECT signature_status, tenant_id, payload, processed_at FROM webhook_deliveries`);

    // The row survives, in full, so the batch can be replayed after the credential
    // is fixed. Rejecting AND discarding loses the delivery receipts for however
    // many hours the misconfiguration lasted, permanently.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signature_status).toBe('invalid');
    expect(rows[0]!.processed_at).toBeNull();
    expect(rows[0]!.payload.events[0]!.providerEventId).toBe(
      `${providerMessageId}:delivered:forged`,
    );
    // Unattributable, and honestly recorded as such rather than guessed at.
    expect(rows[0]!.tenant_id).toBeNull();

    // Nothing was applied: the message is still 'sent', not 'delivered'.
    const queue = await testDb().query<{ status: string }>(
      `SELECT status FROM message_queue WHERE provider_message_id = $1`,
      [providerMessageId],
    );
    expect(queue.rows[0]!.status).toBe('sent');
  });

  it('stores an UNSIGNED callback as `missing` and rejects it', async () => {
    const response = await post(
      app,
      { 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({ events: [] }), 'utf8'),
    );
    expect(response.status).toBe(401);

    const { rows } = await testDb().query<{ signature_status: string }>(
      `SELECT signature_status FROM webhook_deliveries`,
    );
    expect(rows).toHaveLength(1);
    // 'missing' and 'invalid' are different diagnoses: one is a misconfigured
    // sender, the other is a wrong key. Collapsing them costs an afternoon.
    expect(rows[0]!.signature_status).toBe('missing');
  });

  it('stores a payload that is not even JSON, rather than discarding it', async () => {
    const response = await post(
      app,
      { 'content-type': 'application/json', [MOCK_SIGNATURE_HEADER]: 'nope' },
      Buffer.from('{ this is not json', 'utf8'),
    );
    expect(response.status).toBe(401);

    const { rows } = await testDb().query<{ payload: { unparsed?: string } }>(
      `SELECT payload FROM webhook_deliveries`,
    );
    // The malformed payload is exactly the one most worth keeping.
    expect(rows[0]!.payload.unparsed).toContain('this is not json');
  });

  it('marks a validated delivery processed, so the replay job can skip it', async () => {
    const providerMessageId = 'mock-processed';
    await seedSentMessage(tenantId, providerMessageId);
    const { headers, body } = buildMockWebhookRequest(
      [deliveredEvent(providerMessageId, 'ok')],
      CREDENTIALS[0].secret,
    );
    await post(app, headers, body);

    const { rows } = await testDb().query<{
      signature_status: string;
      tenant_id: string | null;
      processed_at: Date | null;
    }>(`SELECT signature_status, tenant_id, processed_at FROM webhook_deliveries`);
    expect(rows[0]!.signature_status).toBe('valid');
    expect(rows[0]!.tenant_id).toBe(tenantId);
    expect(rows[0]!.processed_at).not.toBeNull();
  });

  it('is idempotent on the provider event id, so a redelivered receipt is free', async () => {
    const providerMessageId = 'mock-redelivered';
    await seedSentMessage(tenantId, providerMessageId);
    const signed = buildMockWebhookRequest(
      [deliveredEvent(providerMessageId, 'once')],
      CREDENTIALS[1].secret,
    );

    const first = await post(app, signed.headers, signed.body);
    const second = await post(app, signed.headers, signed.body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await first.json()) as { eventsAccepted: number }).eventsAccepted).toBe(1);
    // A provider that retries a receipt four times must not produce four
    // `delivered` events: campaign_daily_stats is rebuilt from this table, so a
    // duplicate is not a display bug, it is the number.
    expect(((await second.json()) as { eventsAccepted: number }).eventsAccepted).toBe(0);

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_events WHERE event_type = 'delivered'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);

    // Both raw rows are kept, because both callbacks genuinely happened.
    const deliveries = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM webhook_deliveries`,
    );
    expect(Number(deliveries.rows[0]!.n)).toBe(2);
  });

  it('suppresses the ADDRESS on a hard bounce reported by any credential', async () => {
    const providerMessageId = 'mock-bounced';
    const queueId = await seedSentMessage(tenantId, providerMessageId);
    const { rows: queue } = await testDb().query<{ recipient_address: string }>(
      `SELECT recipient_address FROM message_queue WHERE id = $1`,
      [queueId],
    );

    const bounce: ProviderEvent = {
      providerMessageId,
      type: 'bounced',
      occurredAt: new Date('2026-06-15T10:05:00Z'),
      providerEventId: `${providerMessageId}:bounced`,
      errorCode: 'mock_invalid_recipient',
    };
    const { headers, body } = buildMockWebhookRequest([bounce], CREDENTIALS[2].secret);
    expect((await post(app, headers, body)).status).toBe(200);

    const { rows } = await testDb().query<{ reason: string; address: string }>(
      `SELECT reason, address FROM suppressions WHERE tenant_id = $1`,
      [tenantId],
    );
    // Address level, not contact level: a re-import that recreates the contact
    // must not resurrect an address the provider has already refused.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('hard_bounce');
    expect(rows[0]!.address).toBe(queue[0]!.recipient_address);
  });

  it('rejects an unknown provider before it can fill the delivery table', async () => {
    const response = await post(
      app,
      { 'content-type': 'application/json' },
      Buffer.from('{}', 'utf8'),
    );
    expect(response.status).toBe(401);

    const unknown = await app.request('/webhooks/not-a-provider', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unknown.status).toBe(400);

    const { rows } = await testDb().query<{ provider: string }>(
      `SELECT provider FROM webhook_deliveries`,
    );
    expect(rows.map((r) => r.provider)).toEqual(['mock']);
  });
});
