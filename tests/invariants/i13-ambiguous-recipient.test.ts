/**
 * I13 — an order number that matches two orders resolves to NEITHER of them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Order numbers are unique PER STORE. `migrations/0003` says so in its unique key,
 * `UNIQUE (tenant_id, store_id, order_number)`, and it is honest about that on
 * purpose: a schema that pretended order numbers were globally unique would push
 * the problem into the application, where it becomes invisible.
 *
 * So a lookup by order number alone can legitimately match more than one row, and
 * the only two things the system can do with that are:
 *
 *   (a) pick one — usually "the most recent", which reads as a sensible tiebreak
 *       and is in fact the decision to send one customer's order details, their
 *       shipping address, their items and their total, to a DIFFERENT customer;
 *   (b) say it does not know, and hand back both candidates.
 *
 * (a) is a data breach that looks exactly like a working feature. It produces a
 * 200, a plausible payload, and a support agent confidently reading the wrong
 * person's order aloud. Nothing errors, nothing is logged, and the only signal is
 * a confused customer months later.
 *
 * This suite pins (b). It also pins the thing that makes (b) reachable at all:
 * `storeId` is OPTIONAL. Making it required would look like a fix and would in
 * fact just hide the ambiguity from the callers that cannot supply a store —
 * which are precisely the callers that hit it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedTenant, seedContact } from '../support/fixtures.ts';
import { FakeClock } from '@campaign/core';
import type { RecipientResolution } from '@campaign/shared';
import { buildDeps, createApp, hashPassword, type App } from '@campaign/api';

const CLOCK = new FakeClock('2026-06-15T12:00:00Z');
const SECRET = new TextEncoder().encode('i13-suite-secret');
const KEY = Buffer.alloc(32, 0x13);

/** The same number, in two different stores, belonging to two different people. */
const SHARED_NUMBER = '10423';

type OrderSummary = {
  id: string;
  orderNumber: string;
  storeId: string;
  storeCode: string;
  contactId: string;
  contactEmailHint: string | null;
  placedAt: string;
};

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
  return ((await response.json()) as { token: string }).token;
}

type Store = { storeId: string; contactId: string; orderId: string; email: string };

async function seedStoreWithOrder(
  tenantId: string,
  code: string,
  orderNumber: string,
  placedAt: string,
): Promise<Store> {
  const db = testDb();
  const { rows: store } = await db.query<{ id: string }>(
    `INSERT INTO stores (tenant_id, name, code) VALUES ($1,$2,$3) RETURNING id`,
    [tenantId, `Northwind ${code}`, code],
  );
  const email = `${code}-buyer@example.com`;
  const contactId = await seedContact(db, tenantId, { email, tags: [] });
  const { rows: order } = await db.query<{ id: string }>(
    `INSERT INTO orders (tenant_id, store_id, contact_id, order_number, status, total, placed_at)
     VALUES ($1,$2,$3,$4,'placed',42.00,$5::timestamptz) RETURNING id`,
    [tenantId, store[0]!.id, contactId, orderNumber, placedAt],
  );
  return { storeId: store[0]!.id, contactId, orderId: order[0]!.id, email };
}

let app: App;
let tenantId: string;
let token: string;
let north: Store;
let south: Store;

afterAll(closeTestDb);
beforeAll(resetDb);

beforeEach(async () => {
  await resetDb();
  app = boot();
  tenantId = await seedTenant(testDb(), { name: 'Northwind Coffee' });
  token = await tokenFor(app, testDb(), tenantId);

  // Deliberately different placed_at values, so that "take the most recent" would
  // be a well-defined and entirely wrong answer rather than an arbitrary one.
  north = await seedStoreWithOrder(tenantId, 'north', SHARED_NUMBER, '2026-05-01T09:00:00Z');
  south = await seedStoreWithOrder(tenantId, 'south', SHARED_NUMBER, '2026-06-01T09:00:00Z');
});

function headers(): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function lookup(
  query: string,
): Promise<{ status: number; body: RecipientResolution<OrderSummary> }> {
  const response = await app.request(`/orders/lookup?${query}`, { headers: headers() });
  return {
    status: response.status,
    body: (await response.json()) as RecipientResolution<OrderSummary>,
  };
}

describe('I13 — the schema admits the ambiguity', () => {
  it('lets two stores hold the same order number, because they legitimately do', async () => {
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders WHERE tenant_id = $1 AND order_number = $2`,
      [tenantId, SHARED_NUMBER],
    );
    expect(Number(rows[0]!.n)).toBe(2);
    expect(north.contactId).not.toBe(south.contactId);
  });

  it('still refuses two orders with the same number in the SAME store', async () => {
    // The uniqueness that does exist is per store, and it is real.
    await expect(
      testDb().query(
        `INSERT INTO orders (tenant_id, store_id, contact_id, order_number, status, total, placed_at)
         VALUES ($1,$2,$3,$4,'placed',1.00,'2026-06-02T09:00:00Z')`,
        [tenantId, north.storeId, north.contactId, SHARED_NUMBER],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe('I13 — lookup without a store returns ambiguous and picks nothing', () => {
  it('returns both candidates and no chosen order', async () => {
    const { status, body } = await lookup(`number=${SHARED_NUMBER}`);

    expect(body.kind).toBe('ambiguous');
    // A non-2xx so that ignoring the ambiguity has to be deliberate. An integrator
    // writing `response.candidates[0]` against a 200 reintroduces the exact bug
    // this endpoint exists to prevent.
    expect(status).toBe(300);

    // THE ASSERTION: nothing was chosen. No `match`, no implicit first element.
    expect(body).not.toHaveProperty('match');

    if (body.kind !== 'ambiguous') throw new Error('unreachable');
    expect(body.candidates).toHaveLength(2);

    const ids = body.candidates.map((c) => c.id).sort();
    expect(ids).toEqual([north.orderId, south.orderId].sort());

    // Both candidates are fully described, so a human can actually disambiguate.
    const stores = body.candidates.map((c) => c.storeCode).sort();
    expect(stores).toEqual(['north', 'south']);
    const contacts = body.candidates.map((c) => c.contactId);
    expect(new Set(contacts).size).toBe(2);
  });

  it('does not quietly resolve to the most recent order', async () => {
    const { body } = await lookup(`number=${SHARED_NUMBER}`);
    if (body.kind !== 'ambiguous') throw new Error(`expected ambiguous, got ${body.kind}`);

    // The south order is strictly newer. "Most recent wins" is the tiebreak that
    // reads as sensible in review and sends one customer's order to another.
    const newest = body.candidates.reduce((a, b) => (a.placedAt > b.placedAt ? a : b));
    expect(newest.id).toBe(south.orderId);
    expect(body.candidates).toHaveLength(2);
  });

  it('stays ambiguous however many times it is asked', async () => {
    // Not a flake and not a race: the answer is a property of the data, so it does
    // not settle down on the second call.
    for (let i = 0; i < 3; i++) {
      const { body } = await lookup(`number=${SHARED_NUMBER}`);
      expect(body.kind).toBe('ambiguous');
    }
  });

  it('grows to three candidates when a third store shares the number', async () => {
    await seedStoreWithOrder(tenantId, 'east', SHARED_NUMBER, '2026-04-01T09:00:00Z');
    const { body } = await lookup(`number=${SHARED_NUMBER}`);
    if (body.kind !== 'ambiguous') throw new Error(`expected ambiguous, got ${body.kind}`);
    // A `LIMIT 2` would pass the two-store test and fail here.
    expect(body.candidates).toHaveLength(3);
  });

  it('masks the candidates’ email addresses', async () => {
    // The disambiguation screen shows candidates belonging to DIFFERENT customers.
    // It exists so an agent can pick the right one, not so they can read two
    // strangers' addresses off the same page.
    const { body } = await lookup(`number=${SHARED_NUMBER}`);
    if (body.kind !== 'ambiguous') throw new Error('expected ambiguous');

    for (const candidate of body.candidates) {
      expect(candidate.contactEmailHint).toContain('***');
      expect(candidate.contactEmailHint).not.toBe(north.email);
      expect(candidate.contactEmailHint).not.toBe(south.email);
    }
  });
});

describe('I13 — the store id is the disambiguator, and it is optional', () => {
  it('resolves to a single order once a store is named', async () => {
    const { status, body } = await lookup(`number=${SHARED_NUMBER}&storeId=${north.storeId}`);
    expect(status).toBe(200);
    expect(body.kind).toBe('single');
    if (body.kind !== 'single') throw new Error('unreachable');
    expect(body.match.id).toBe(north.orderId);
    expect(body.match.storeCode).toBe('north');
    expect(body.match.contactId).toBe(north.contactId);
  });

  it('resolves to the OTHER order for the other store', async () => {
    const { body } = await lookup(`number=${SHARED_NUMBER}&storeId=${south.storeId}`);
    if (body.kind !== 'single') throw new Error(`expected single, got ${body.kind}`);
    expect(body.match.id).toBe(south.orderId);
  });

  it("returns 'none' for a number nobody has, and for a store that has it but does not", async () => {
    expect((await lookup('number=NO-SUCH-ORDER')).body).toEqual({ kind: 'none' });

    const empty = await seedStoreWithOrder(tenantId, 'west', 'WEST-ONLY-1', '2026-01-01T09:00:00Z');
    const { body } = await lookup(`number=${SHARED_NUMBER}&storeId=${empty.storeId}`);
    // 'none' rather than a fallback to the tenant-wide match. Narrowing must not
    // silently widen again when the narrowed search comes back empty.
    expect(body).toEqual({ kind: 'none' });
  });

  it('is reachable without a storeId at all — which is what makes ambiguity possible', async () => {
    const response = await app.request(`/orders/lookup?number=${SHARED_NUMBER}`, {
      headers: headers(),
    });
    // If this were a 400 demanding a store, the ambiguous arm would be dead code
    // and the callers who cannot supply a store would have nowhere to go.
    expect(response.status).not.toBe(400);
  });
});

describe('I13 — the shape is enforced by the source, not only by this test', () => {
  it('has no LIMIT 1 or [0] shortcut in the order lookup', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../packages/api/src/routes/orders.ts', import.meta.url)),
      'utf8',
    );
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');

    const lookupBlock = code.slice(code.indexOf("app.get('/orders/lookup'"));
    const untilNextRoute = lookupBlock.slice(0, lookupBlock.indexOf("app.get('/orders/:id"));

    expect(untilNextRoute).not.toMatch(/LIMIT\s+1/i);
    expect(untilNextRoute).not.toMatch(/queryOne</);
    // And the union really does have all three arms.
    expect(code).toContain("kind: 'none'");
    expect(code).toContain("kind: 'single'");
    expect(code).toContain("kind: 'ambiguous'");
  });
});
