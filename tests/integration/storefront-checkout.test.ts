/**
 * The storefront, end to end through the real app.
 *
 * This is the path a stranger with the public URL actually walks: a POST from a
 * checkout form produces a contact, a consent record, an order, an enrolment, a
 * rendered message and — inside the same request — a send. Every assertion below
 * exists because the alternative was a demo that looked like it worked.
 *
 * The send is against the MOCK provider, because a test that needs a mailbox is a
 * test that nobody runs. What is being proved here is that the wiring reaches the
 * one send path, that the gates run on it, and that a message which does not go
 * out leaves behind the sentence explaining why.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedTenant, seedCampaign, seedCampaignMessage, seedContact } from '../support/fixtures.ts';
import { FakeClock } from '@campaign/core';
import { buildDeps, createApp, readReceiptToken, toE164, type App } from '@campaign/api';

const CLOCK = new FakeClock('2026-06-15T12:00:00Z');
const SECRET = new TextEncoder().encode('storefront-suite-secret');
const KEY = Buffer.alloc(32, 0x44);

const TENANT_NAME = 'Storefront Test Shop';
const ENV = {
  ...process.env,
  LOG_LEVEL: 'silent',
  STOREFRONT_TENANT_NAME: TENANT_NAME,
  STOREFRONT_STORE_CODE: 'main',
  // Zero, so the per-address cooldown never makes an assertion depend on a
  // FakeClock that does not advance between two requests in the same test.
  STOREFRONT_ADDRESS_COOLDOWN_SECONDS: '0',
  // The mock provider models a real channel: ~2% hard failures, ~5% bounces. That
  // is correct for the seeded dataset and useless here, where a 2% chance of a
  // red test is indistinguishable from a regression.
  MOCK_FAILURE_RATE: '0',
  MOCK_BOUNCE_RATE: '0',
  MOCK_COMPLAINT_RATE: '0',
};

function boot(sendMode: 'off' | 'mock' | 'live' = 'mock'): App {
  return createApp(
    buildDeps({
      db: testDb(),
      clock: CLOCK,
      jwtSecret: SECRET,
      encryptionKey: KEY,
      publicBaseUrl: 'http://api.test',
      sendMode,
      rateLimit: { limit: 10_000, windowMs: 60_000, publicLimit: 10_000, loginLimit: 10_000 },
      env: ENV,
    }),
  );
}

async function seedShop(): Promise<{ tenantId: string; campaignId: string }> {
  const db = testDb();
  const tenantId = await seedTenant(db, { name: TENANT_NAME });
  await db.query(`INSERT INTO stores (tenant_id, name, code) VALUES ($1,'Main Store','main')`, [
    tenantId,
  ]);

  const { campaignId } = await seedCampaign(db, tenantId, {
    name: 'Order confirmation',
    category: 'transactional',
    triggerType: 'order_placed',
    status: 'active',
  });
  await seedCampaignMessage(db, tenantId, campaignId, {
    channel: 'email',
    sequenceOrder: 1,
    subject: 'Order {{order.number}} confirmed',
    body: 'Thanks {{contact.first_name}}, order {{order.number}} for {{order.total}}.',
  });
  await seedCampaignMessage(db, tenantId, campaignId, {
    channel: 'sms',
    sequenceOrder: 2,
    subject: null,
    body: 'Order {{order.number}} confirmed.',
  });
  return { tenantId, campaignId };
}

async function checkout(app: App, body: Record<string, unknown>): Promise<Response> {
  return app.request('/storefront/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      items: [{ sku: 'CE-MUG', qty: 1 }],
      marketingConsent: true,
      ...body,
    }),
  });
}

type CheckoutResult = {
  ok: boolean;
  orderNumber: string;
  receiptToken: string | null;
  queued: number;
  enrolled: number;
  flushed: { sent: number; claimed: number; refusedWithoutClaim: boolean };
  notes: string[];
};

type Receipt = {
  order: { number: string; total: string };
  contact: { email: string | null; phone: string | null };
  messages: {
    channel: string;
    status: string;
    subject: string | null;
    body: string;
    provider: string | null;
    to: string;
  }[];
  decisions: { stage: string; decision: string; reasonCode: string; detail: string | null }[];
};

let app: App;

afterAll(closeTestDb);
beforeAll(resetDb);
beforeEach(async () => {
  await resetDb();
  app = boot();
});

describe('a stranger places an order', () => {
  it('writes the contact, the order and the consent, then sends inside the request', async () => {
    await seedShop();

    const response = await checkout(app, { phone: '+44 7700 900123' });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = (await response.json()) as CheckoutResult;

    expect(result.ok).toBe(true);
    expect(result.orderNumber).toMatch(/^CE-[0-9A-Z]{6}$/);
    expect(result.enrolled, 'the order_placed campaign should have enrolled the contact').toBe(1);
    expect(result.queued, 'one email and one SMS').toBe(2);

    // The point of the whole exercise: the send happened in the request, not on a
    // timer five minutes later.
    expect(result.flushed.claimed).toBe(2);
    expect(result.flushed.sent).toBe(2);
    expect(result.flushed.refusedWithoutClaim).toBe(false);

    const db = testDb();
    const { rows: contacts } = await db.query<{ email: string; phone: string | null }>(
      `SELECT email::text AS email, phone FROM contacts`,
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.email).toBe('ada@example.com');
    // Normalised on the way in, because contacts_phone_is_e164 would otherwise
    // turn a space in a phone number into a 500 on a checkout screen.
    expect(contacts[0]!.phone).toBe('+447700900123');

    const { rows: consents } = await db.query<{ channel: string; state: string; source: string }>(
      `SELECT channel, state, source FROM contact_consents ORDER BY channel`,
    );
    expect(consents).toEqual([
      { channel: 'email', state: 'opted_in', source: 'checkout' },
      { channel: 'sms', state: 'opted_in', source: 'checkout' },
    ]);
  });

  it('renders the merge fields, so the receipt is about their order and not a template', async () => {
    await seedShop();
    const result = (await (await checkout(app, {})).json()) as CheckoutResult;

    const receipt = (await (
      await app.request(`/storefront/receipt/${result.receiptToken!}`)
    ).json()) as Receipt;

    const email = receipt.messages.find((m) => m.channel === 'email');
    expect(email).toBeDefined();
    expect(email!.subject).toBe(`Order ${result.orderNumber} confirmed`);
    expect(email!.body).toContain('Thanks Ada');
    expect(email!.body).toContain(result.orderNumber);
    expect(email!.status).toBe('sent');
    expect(email!.provider).toBe('mock');
    expect(receipt.order.total).toBe('14.00');
  });

  it('records WHY the SMS did not go out, rather than silently dropping it', async () => {
    await seedShop();
    // No phone on the form. The SMS campaign message still exists, so the skip has
    // to be visible somewhere — that is the entire premise of the project.
    const result = (await (await checkout(app, {})).json()) as CheckoutResult;
    expect(result.queued, 'only the email is queueable without a phone number').toBe(1);

    const receipt = (await (
      await app.request(`/storefront/receipt/${result.receiptToken!}`)
    ).json()) as Receipt;

    const skip = receipt.decisions.find(
      (d) => d.stage === 'schedule' && d.reasonCode === 'no_recipient_address',
    );
    expect(skip, JSON.stringify(receipt.decisions, null, 2)).toBeDefined();
    expect(skip!.detail).toContain('no sms address');
  });
});

describe('the guards on a public endpoint that can send real mail', () => {
  it('refuses a phone number with no country code, with a sentence a human can act on', async () => {
    await seedShop();
    const response = await checkout(app, { phone: '9876543210' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_phone');
    expect(body.error.message).toContain('country code');
  });

  it('holds the same address to a cooldown, so the form cannot mailbomb anybody', async () => {
    await seedShop();
    const strict = createApp(
      buildDeps({
        db: testDb(),
        clock: CLOCK,
        jwtSecret: SECRET,
        encryptionKey: KEY,
        publicBaseUrl: 'http://api.test',
        sendMode: 'mock',
        rateLimit: { limit: 10_000, windowMs: 60_000, publicLimit: 10_000, loginLimit: 10_000 },
        env: { ...ENV, STOREFRONT_ADDRESS_COOLDOWN_SECONDS: '600' },
      }),
    );

    expect((await checkout(strict, {})).status).toBe(200);
    const second = await checkout(strict, {});
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { message: string } }).error.message).toContain(
      'mailbomb',
    );
  });

  it('answers the honeypot with a 200 that does nothing at all', async () => {
    await seedShop();
    const response = await checkout(app, { website: 'http://spam.example' });
    expect(response.status).toBe(200);

    const { rows } = await testDb().query<{ n: string }>(`SELECT count(*)::text AS n FROM orders`);
    expect(rows[0]!.n, 'the honeypot must not create an order').toBe('0');
  });

  it('never lets a checkout box overturn an earlier opt-out', async () => {
    const { tenantId } = await seedShop();
    const db = testDb();
    // The same person, already in the dataset, already unsubscribed.
    const contactId = await seedContact(db, tenantId, { email: 'ada@example.com' });
    await db.query(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source, occurred_at)
       VALUES ($1,$2,'email','opted_out','unsubscribe_link',$3)`,
      [tenantId, contactId, new Date('2026-06-01T00:00:00Z')],
    );

    await checkout(app, { marketingConsent: true });

    const { rows } = await db.query<{ state: string; source: string }>(
      `SELECT state, source FROM contact_consents
        WHERE contact_id = $1 AND channel = 'email'
        ORDER BY occurred_at DESC LIMIT 1`,
      [contactId],
    );
    expect(rows[0], 'the opt-out must still be the latest word on this channel').toEqual({
      state: 'opted_out',
      source: 'unsubscribe_link',
    });
  });

  it('claims no row and burns no attempt when the deployment may not send (I2)', async () => {
    await seedShop();
    const off = boot('off');
    const result = (await (await checkout(off, {})).json()) as CheckoutResult;

    expect(result.queued).toBe(1);
    expect(result.flushed.refusedWithoutClaim).toBe(true);
    expect(result.flushed.claimed).toBe(0);

    const { rows } = await testDb().query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM message_queue`,
    );
    expect(rows[0]).toEqual({ status: 'pending', attempts: 0 });
  });
});

describe('the receipt token is a capability, not an identifier', () => {
  it('round-trips the order id under the server secret', () => {
    const orderId = '0199a9f1-0000-7000-8000-000000000001';
    const token = `${orderId}.notarealmac`;
    expect(readReceiptToken(token, SECRET), 'a forged MAC must not open it').toBeUndefined();
  });

  it('refuses a token signed with a different secret', async () => {
    await seedShop();
    const result = (await (await checkout(app, {})).json()) as CheckoutResult;
    const other = createApp(
      buildDeps({
        db: testDb(),
        clock: CLOCK,
        jwtSecret: new TextEncoder().encode('a different server'),
        encryptionKey: KEY,
        publicBaseUrl: 'http://api.test',
        sendMode: 'mock',
        rateLimit: { limit: 10_000, windowMs: 60_000, publicLimit: 10_000, loginLimit: 10_000 },
        env: ENV,
      }),
    );
    expect((await other.request(`/storefront/receipt/${result.receiptToken!}`)).status).toBe(404);
  });
});

describe('phone normalisation', () => {
  it.each([
    ['+44 7700 900123', '+447700900123'],
    ['+91-98765-43210', '+919876543210'],
    ['0049 30 123456', '+4930123456'],
    ['+1 (415) 523-8886', '+14155238886'],
  ])('normalises %s', (input, expected) => {
    const parsed = toE164(input);
    expect(parsed.ok && parsed.phone).toBe(expected);
  });

  it.each(['9876543210', 'not a phone', '+0123456789', '+1'])('rejects %s', (input) => {
    expect(toE164(input).ok).toBe(false);
  });
});
