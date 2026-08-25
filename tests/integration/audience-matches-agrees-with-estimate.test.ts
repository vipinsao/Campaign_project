import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AudienceResolver, FakeClock } from '@campaign/core';
import type { AudienceDefinition } from '@campaign/shared';
import { testDb, closeTestDb, resetDb } from '../support/db.ts';

/**
 * The named agreement test.
 *
 * `estimate` tells an operator how many people a campaign will reach; `matches`
 * decides, per contact, whether it actually reaches them. If those two ever
 * disagree, the review screen lies — and it lies with a specific number, which is
 * the worst kind of lying, because a confident wrong count stops people checking.
 *
 * The defence in the implementation is that both are the same compiled predicate,
 * differing only by an appended `AND c.id = $n`. The defence in this file is
 * empirical: 500 contacts with deliberately awkward data (NULL timestamps, empty tag
 * arrays, missing JSONB keys, a non-numeric value in a numerically-compared
 * attribute), thirteen definitions covering every combinator and every operator, and
 * zero permitted disagreements. If someone ever "optimises" `matches` into an
 * in-memory evaluator, this test is what stops it reaching production.
 *
 * The data is randomised but seeded, so a failure reproduces exactly.
 */

const NOW = '2026-06-01T12:00:00.000Z';
const CONTACT_COUNT = 500;
const clock = new FakeClock(NOW);
const resolver = new AudienceResolver(clock);

/** mulberry32: small, seeded, and identical on every machine. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAG_POOL = ['vip', 'churn_risk', 'newsletter', 'beta', 'bounced'];
const LOCALES = ['en', 'de', 'fr', 'es'];
const NAMES = ['ana', 'bo', 'cy', 'dee', 'edo'];
const PLANS = ['free', 'pro', 'enterprise'];

let tenantId = '';
let otherTenantId = '';
let contactIds: string[] = [];

async function seed(): Promise<void> {
  const db = testDb();
  const rand = seededRandom(20260601);

  const tenants = await db.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('audience agreement'), ('audience neighbour') RETURNING id`,
  );
  tenantId = tenants.rows[0]!.id;
  otherTenantId = tenants.rows[1]!.id;

  const columns = [
    'tenant_id',
    'email',
    'phone',
    'first_name',
    'last_name',
    'locale',
    'timezone',
    'tags',
    'attributes',
    'order_count',
    'lifetime_value',
    'first_order_at',
    'last_order_at',
    'created_at',
  ];
  const casts: Record<string, string> = {
    tags: '::text[]',
    attributes: '::jsonb',
    first_order_at: '::timestamptz',
    last_order_at: '::timestamptz',
    created_at: '::timestamptz',
  };

  const params: unknown[] = [];
  const tuples: string[] = [];
  const nowMs = Date.parse(NOW);

  for (let i = 0; i < CONTACT_COUNT; i++) {
    const tags = TAG_POOL.filter(() => rand() < 0.3);
    const hasLastOrder = rand() < 0.8;
    const lastOrderDaysAgo = Math.floor(rand() * 400);
    const orderCount = Math.floor(rand() * 21);

    // Deliberately mixed: a missing key, a numeric score, and a score stored as a
    // string. The last one is what makes an unguarded `::numeric` cast abort the
    // whole estimate query, and it must behave identically in matches.
    const attributes: Record<string, unknown> = {};
    if (rand() < 0.85) attributes.plan = PLANS[Math.floor(rand() * PLANS.length)];
    const scoreRoll = rand();
    if (scoreRoll < 0.7) attributes.score = Math.floor(rand() * 100);
    else if (scoreRoll < 0.8) attributes.score = 'n/a';
    if (rand() < 0.5) attributes.region = rand() < 0.5 ? 'emea' : 'amer';

    const row: Record<string, unknown> = {
      tenant_id: tenantId,
      email: `c${i}@example.com`,
      phone: rand() < 0.6 ? `+1555${String(1_000_000 + i).slice(-7)}` : null,
      first_name: rand() < 0.75 ? NAMES[Math.floor(rand() * NAMES.length)] : null,
      last_name: rand() < 0.75 ? NAMES[Math.floor(rand() * NAMES.length)] : null,
      locale: LOCALES[Math.floor(rand() * LOCALES.length)],
      timezone: rand() < 0.5 ? 'Europe/Berlin' : null,
      tags,
      attributes: JSON.stringify(attributes),
      order_count: orderCount,
      lifetime_value: (rand() * 1000).toFixed(2),
      first_order_at: hasLastOrder
        ? new Date(nowMs - (lastOrderDaysAgo + 30) * 86_400_000).toISOString()
        : null,
      last_order_at: hasLastOrder
        ? new Date(nowMs - lastOrderDaysAgo * 86_400_000).toISOString()
        : null,
      created_at: new Date(nowMs - Math.floor(rand() * 900) * 86_400_000).toISOString(),
    };

    tuples.push(
      `(${columns
        .map((column) => `$${params.push(row[column])}${casts[column] ?? ''}`)
        .join(', ')})`,
    );
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO contacts (${columns.join(', ')}) VALUES ${tuples.join(', ')} RETURNING id`,
    params,
  );
  contactIds = inserted.rows.map((r) => r.id);

  // A neighbouring tenant whose contact satisfies every definition below. If tenant
  // scoping ever slipped out of the resolver, the counts would be off by exactly one
  // and this test would be the thing that noticed.
  await db.query(
    `INSERT INTO contacts (tenant_id, email, phone, first_name, last_name, locale, tags, attributes,
                           order_count, lifetime_value, first_order_at, last_order_at)
     VALUES ($1, 'intruder@example.com', '+15559999999', 'ana', 'bo', 'de',
             ARRAY['vip','beta','newsletter']::text[], '{"plan":"pro","score":99}'::jsonb,
             9, 120.00, $2::timestamptz, $2::timestamptz)`,
    [otherTenantId, NOW],
  );
}

/** Bounded fan-out; the shared test pool holds 16 connections. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

const DEFINITIONS: readonly { name: string; definition: AudienceDefinition }[] = [
  { name: 'empty definition matches everyone', definition: {} },
  {
    name: 'single tag containment',
    definition: { all: [{ field: 'tags', op: 'contains', value: 'vip' }] },
  },
  {
    name: 'numeric range across two columns',
    definition: {
      all: [
        { field: 'order_count', op: 'gte', value: 5 },
        { field: 'lifetime_value', op: 'lt', value: 500 },
      ],
    },
  },
  {
    name: 'any over locales',
    definition: {
      any: [
        { field: 'locale', op: 'eq', value: 'de' },
        { field: 'locale', op: 'eq', value: 'fr' },
      ],
    },
  },
  {
    name: 'none excludes a tag',
    definition: { none: [{ field: 'tags', op: 'contains', value: 'bounced' }] },
  },
  {
    name: 'within_days on a nullable timestamp',
    definition: { all: [{ field: 'last_order_at', op: 'within_days', value: 90 }] },
  },
  {
    name: 'not_within_days keeps contacts who never ordered',
    definition: { all: [{ field: 'last_order_at', op: 'not_within_days', value: 180 }] },
  },
  {
    name: 'jsonb attribute equality with a missing key in the data',
    definition: { all: [{ field: 'attributes.plan', op: 'eq', value: 'pro' }] },
  },
  {
    name: 'jsonb numeric ordering with a non-numeric value in the data',
    definition: { all: [{ field: 'attributes.score', op: 'gt', value: 50 }] },
  },
  {
    name: 'nested all/any/none with is_set and a substring test',
    definition: {
      all: [
        { field: 'phone', op: 'is_set' },
        {
          any: [
            { field: 'tags', op: 'in', value: ['vip', 'beta'] },
            { field: 'order_count', op: 'eq', value: 0 },
          ],
        },
      ],
      none: [{ field: 'email', op: 'contains', value: 'c1@' }],
    },
  },
  {
    name: 'is_not_set on a nullable text column',
    definition: { all: [{ field: 'first_name', op: 'is_not_set' }] },
  },
  {
    name: 'neq and not_in include unknown values',
    definition: {
      all: [
        { field: 'timezone', op: 'neq', value: 'Europe/Berlin' },
        { field: 'locale', op: 'not_in', value: ['en'] },
      ],
    },
  },
  {
    name: 'three groups at once, deeply nested',
    definition: {
      all: [
        { field: 'locale', op: 'in', value: ['de', 'es'] },
        {
          any: [
            { field: 'lifetime_value', op: 'gte', value: 100 },
            {
              all: [
                { field: 'tags', op: 'is_set' },
                { field: 'order_count', op: 'lte', value: 3 },
              ],
            },
          ],
        },
      ],
      none: [{ field: 'attributes.region', op: 'eq', value: 'amer' }],
    },
  },
];

beforeAll(async () => {
  await resetDb();
  await seed();
}, 120_000);

afterAll(closeTestDb);

describe('estimate and matches are the same predicate', () => {
  it('seeded 500 contacts with awkward data', () => {
    expect(contactIds).toHaveLength(CONTACT_COUNT);
  });

  for (const { name, definition } of DEFINITIONS) {
    it(`agrees on every contact: ${name}`, async () => {
      const db = testDb();

      const estimate = await resolver.estimate(db, tenantId, definition, CONTACT_COUNT);
      const estimated = new Set(estimate.sample.map((s) => s.id));
      // The sample is the whole matched set at this sampleSize, so count and sample
      // must agree before the comparison below means anything.
      expect(estimate.count).toBe(estimated.size);

      const verdicts = await mapWithConcurrency(contactIds, 12, async (contactId) => ({
        contactId,
        result: await resolver.matches(db, tenantId, contactId, definition),
      }));
      const matched = new Set(verdicts.filter((v) => v.result.matched).map((v) => v.contactId));

      const inEstimateOnly = [...estimated].filter((id) => !matched.has(id));
      const inMatchesOnly = [...matched].filter((id) => !estimated.has(id));

      expect(
        { inEstimateOnly, inMatchesOnly },
        `estimate said ${estimate.count} and matches said ${matched.size} for "${name}".\n` +
          `Counted but not matched: ${inEstimateOnly.slice(0, 5).join(', ') || 'none'}\n` +
          `Matched but not counted: ${inMatchesOnly.slice(0, 5).join(', ') || 'none'}\n` +
          `SQL:\n${estimate.compiledSql}\nparams: ${JSON.stringify(estimate.params)}`,
      ).toEqual({ inEstimateOnly: [], inMatchesOnly: [] });

      // Every definition here is satisfiable and none matches the whole table except
      // the empty one; a definition that matched nobody would make the agreement
      // above vacuously true.
      if (Object.keys(definition).length > 0) {
        expect(matched.size).toBeGreaterThan(0);
        expect(matched.size).toBeLessThan(CONTACT_COUNT);
      } else {
        expect(matched.size).toBe(CONTACT_COUNT);
      }
    });
  }
});

describe('estimate and matches, around the edges', () => {
  it('never counts a contact belonging to another tenant', async () => {
    const db = testDb();
    const everyone = await resolver.estimate(db, tenantId, {}, 0);
    expect(everyone.count).toBe(CONTACT_COUNT);

    const intruder = await db.query<{ id: string }>(
      `SELECT id FROM contacts WHERE tenant_id = $1`,
      [otherTenantId],
    );
    const verdict = await resolver.matches(db, tenantId, intruder.rows[0]!.id, {});
    expect(verdict.matched).toBe(false);
    expect(verdict.failedRule).toBe('contact does not exist in this tenant');
  });

  it('returns the count independently of the sample size', async () => {
    const db = testDb();
    const definition: AudienceDefinition = {
      all: [{ field: 'tags', op: 'contains', value: 'vip' }],
    };
    const full = await resolver.estimate(db, tenantId, definition, CONTACT_COUNT);
    const small = await resolver.estimate(db, tenantId, definition, 3);
    const none = await resolver.estimate(db, tenantId, definition, 0);

    expect(small.count).toBe(full.count);
    expect(none.count).toBe(full.count);
    expect(small.sample).toHaveLength(3);
    expect(none.sample).toHaveLength(0);
    expect(small.sample[0]?.tags).toContain('vip');
  });

  it('discloses SQL that holds placeholders and no operator-supplied value', async () => {
    const db = testDb();
    const estimate = await resolver.estimate(
      db,
      tenantId,
      { all: [{ field: 'attributes.plan', op: 'eq', value: 'pro' }] },
      1,
    );
    expect(estimate.compiledSql).toContain('c.attributes ->> $1::text');
    expect(estimate.compiledSql).not.toContain('pro');
    expect(estimate.compiledSql).not.toContain(tenantId);
    expect(estimate.params.slice(0, 2)).toEqual(['plan', 'pro']);
  });

  it('names the top-level rule that turned a contact away', async () => {
    const db = testDb();
    const definition: AudienceDefinition = {
      all: [
        { field: 'locale', op: 'eq', value: 'de' },
        { field: 'order_count', op: 'gte', value: 1000 },
      ],
    };
    const german = await testDb().query<{ id: string }>(
      `SELECT id FROM contacts WHERE tenant_id = $1 AND locale = 'de' LIMIT 1`,
      [tenantId],
    );
    const verdict = await resolver.matches(db, tenantId, german.rows[0]!.id, definition);
    expect(verdict.matched).toBe(false);
    expect(verdict.failedRule).toBe('order_count gte 1000');
  });

  it('reports the excluding rule when a none group is what rejected the contact', async () => {
    const db = testDb();
    const vip = await testDb().query<{ id: string }>(
      `SELECT id FROM contacts WHERE tenant_id = $1 AND 'vip' = ANY(tags) LIMIT 1`,
      [tenantId],
    );
    const verdict = await resolver.matches(db, tenantId, vip.rows[0]!.id, {
      none: [{ field: 'tags', op: 'contains', value: 'vip' }],
    });
    expect(verdict.matched).toBe(false);
    expect(verdict.failedRule).toBe(`excluded by 'none': tags contains "vip"`);
  });

  it('leaves failedRule undefined on a match', async () => {
    const db = testDb();
    const verdict = await resolver.matches(db, tenantId, contactIds[0]!, {});
    expect(verdict.matched).toBe(true);
    expect(verdict.failedRule).toBeUndefined();
  });
});
