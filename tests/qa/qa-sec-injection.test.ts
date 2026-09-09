/**
 * ATTACK: the audience DSL, and every scalar a client can put in a query string.
 *
 * The DSL is the one place the product takes STRUCTURE from a user rather than
 * values, and `/audience/estimate` hands the compiled SQL back to the caller — so
 * if a single branch of the compiler ever spliced, this endpoint is also the oracle
 * that confirms it landed. Each case below asserts twice: the injected text must
 * never appear in `compiledSql`, and the tenant's row count must not move.
 *
 * The second half is the boring half that actually breaks servers: numbers from a
 * query string reaching Postgres as OFFSET.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import type { App } from '@campaign/api';
import { bootApp, seedWorld, authHeaders, type World } from './qa-sec-helpers.ts';

let app: App;
let a: World;

afterAll(closeTestDb);
beforeAll(resetDb);

beforeEach(async () => {
  await resetDb();
  app = bootApp();
  a = await seedWorld(app, 'Alpha');
});

const asA = () => authHeaders(a.token);

type EstimateResponse = {
  readonly error?: { readonly code: string };
  readonly compiledSql?: string;
  readonly params?: readonly unknown[];
  readonly count?: number;
};

async function estimate(audience: unknown): Promise<{ status: number; body: EstimateResponse }> {
  const response = await app.request('/audience/estimate', {
    method: 'POST',
    headers: asA(),
    body: JSON.stringify({ audience }),
  });
  return { status: response.status, body: (await response.json()) as EstimateResponse };
}

describe('the audience DSL cannot reach SQL as text', () => {
  it('rejects a field name carrying SQL rather than splicing it', async () => {
    const payloads = [
      "email' OR '1'='1",
      'c.email; DROP TABLE contacts; --',
      'email) OR (SELECT 1 FROM users LIMIT 1) IS NOT NULL OR (1=1',
      '(SELECT password_hash FROM users LIMIT 1)',
    ];
    for (const field of payloads) {
      const { status, body } = await estimate({ all: [{ field, op: 'eq', value: 'x' }] });
      expect(status, `field ${field}`).toBe(422);
      expect(body.error?.code).toBe('audience_uncompilable');
    }

    // The table is still there and still populated.
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM contacts`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('binds an attributes key rather than splicing it, and rejects a quote outright', async () => {
    const hostile = await estimate({
      all: [{ field: "attributes.x'; DROP TABLE users; --", op: 'eq', value: 'y' }],
    });
    expect(hostile.status).toBe(422);

    // The legitimate case must still bind, never splice.
    const ok = await estimate({ all: [{ field: 'attributes.plan', op: 'eq', value: 'pro' }] });
    expect(ok.status).toBe(200);
    expect(ok.body.compiledSql).not.toContain('plan');
    expect(ok.body.params).toContain('plan');
  });

  it('refuses an object where a scalar belongs instead of stringifying it into SQL', async () => {
    const response = await app.request('/audience/estimate', {
      method: 'POST',
      headers: asA(),
      body: JSON.stringify({
        audience: { all: [{ field: 'email', op: 'eq', value: { toString: "' OR 1=1--" } }] },
      }),
    });
    // zod's RuleLeaf union does not admit an object value.
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(['validation_failed', 'audience_uncompilable']).toContain(body.error.code);
  });

  it('never echoes an injected value back inside compiledSql', async () => {
    const marker = "'; SELECT pg_sleep(0); --";
    const { status, body } = await estimate({
      all: [{ field: 'email', op: 'contains', value: marker }],
    });
    expect(status).toBe(200);
    expect(body.compiledSql).not.toContain('pg_sleep');
    expect(body.compiledSql).not.toContain(';');
    expect(body.compiledSql).toMatch(/\$\d/);
    // The value is in `params`, LIKE-escaped, and nowhere near the SQL text.
    expect((body.params ?? []).some((p) => String(p).includes('SELECT pg'))).toBe(true);
  });
});

describe('the audience DSL has no size or depth bound', () => {
  it('does not turn a deeply nested rule into a 500', async () => {
    // 5,000 levels of `{ all: [ ... ] }`. Both the zod z.lazy parse and the
    // compiler's compileRule recurse per level; neither has a depth cap, so the
    // stack is the only limit and RangeError is not an ApiError.
    // Built as text: JSON.stringify would blow the CLIENT's stack first and prove
    // nothing about the server.
    const depth = 5_000;
    const body =
      `{"audience":{"all":[${'{"all":['.repeat(depth)}` +
      `{"field":"email","op":"is_set"}` +
      `${']}'.repeat(depth)}]}}`;

    const response = await app.request('/audience/estimate', {
      method: 'POST',
      headers: asA(),
      body,
    });
    expect(
      response.status,
      'a hostile nesting depth should be a 4xx, not an unhandled server error',
    ).toBeLessThan(500);
  });

  it('does not accept an unbounded `in` list', async () => {
    const huge = Array.from({ length: 200_000 }, (_, i) => `tag-${i}`);
    const response = await app.request('/audience/estimate', {
      method: 'POST',
      headers: asA(),
      body: JSON.stringify({ audience: { all: [{ field: 'tags', op: 'in', value: huge }] } }),
    });
    expect(
      response.status,
      'requireList caps nothing: a 200k-element array is bound and shipped to Postgres',
    ).toBe(422);
  });
});

describe('sort, filter and pagination parameters', () => {
  it('binds status, channel and address filters rather than interpolating them', async () => {
    const hostile = encodeURIComponent("' OR 1=1--");
    const probes = [
      `/campaigns?status=${hostile}`,
      `/queue?status=${hostile}`,
      `/queue?channel=${hostile}`,
      `/suppressions?channel=${hostile}&reason=${hostile}`,
      `/campaigns/${a.campaignId}/enrollments?status=${hostile}`,
      `/mock-outbox?channel=${hostile}`,
      `/decisions?reasonCode=${hostile}`,
    ];
    for (const probe of probes) {
      const response = await app.request(probe, { headers: asA() });
      expect(response.status, probe).toBe(200);
      const body = (await response.json()) as Record<string, unknown[]>;
      // A successful injection would return rows; a bound parameter matches nothing.
      for (const value of Object.values(body)) {
        if (Array.isArray(value)) expect(value.length, probe).toBe(0);
      }
    }
  });

  it('clamps a hostile limit and offset', async () => {
    const cases = [
      ['limit=-1', 1],
      ['limit=0', 50],
      ['limit=999999999', 200],
      ['limit=abc', 50],
    ] as const;
    for (const [qs, expected] of cases) {
      const response = await app.request(`/campaigns?${qs}`, { headers: asA() });
      expect(response.status, qs).toBe(200);
      const body = (await response.json()) as { page: { limit: number } };
      expect(body.page.limit, qs).toBe(expected);
    }

    const negative = await app.request('/campaigns?offset=-1', { headers: asA() });
    expect(((await negative.json()) as { page: { offset: number } }).page.offset).toBe(0);
  });

  it('does not 500 on an offset larger than a bigint', async () => {
    // `pagination` clamps the LOWER bound of offset and nothing else, so the value
    // travels to Postgres verbatim as OFFSET.
    for (const qs of ['offset=1e21', 'offset=99999999999999999999', 'offset=Infinity']) {
      const response = await app.request(`/campaigns?${qs}`, { headers: asA() });
      expect(response.status, `${qs} should be a 4xx, not a server error`).toBeLessThan(500);
    }
  });
});
