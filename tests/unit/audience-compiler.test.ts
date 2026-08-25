import { describe, it, expect } from 'vitest';
import { compileAudience, AudienceCompileError, FakeClock } from '@campaign/core';
import type { AudienceDefinition } from '@campaign/shared';

/**
 * The compiler's contract, in three parts:
 *
 *  1. Each operator produces the SQL shape the schema can actually use an index for.
 *  2. Nothing an operator typed ever reaches the SQL string. That is asserted
 *     positively — hostile inputs are compiled where they are legal, and the test
 *     checks the payload is in `params` and absent from `sql`.
 *  3. Nesting parenthesises, because AND/OR precedence is how a segment silently
 *     comes to mean something other than what the builder drew.
 */

const clock = new FakeClock('2026-03-01T12:00:00.000Z');

function compile(definition: AudienceDefinition) {
  return compileAudience(definition, clock);
}

describe('audience compiler: operator shapes', () => {
  it('compiles eq on a text column to a bound equality', () => {
    const c = compile({ all: [{ field: 'locale', op: 'eq', value: 'de' }] });
    expect(c.sql).toBe('(c.locale = $1)');
    expect(c.params).toEqual(['de']);
  });

  it('compiles neq to IS DISTINCT FROM so unknown values are not silently dropped', () => {
    const c = compile({ all: [{ field: 'locale', op: 'neq', value: 'de' }] });
    expect(c.sql).toBe('(c.locale IS DISTINCT FROM $1)');
    expect(c.params).toEqual(['de']);
  });

  it('compiles the ordering operators on numbers', () => {
    expect(compile({ all: [{ field: 'order_count', op: 'gt', value: 3 }] }).sql).toBe(
      '(c.order_count > $1)',
    );
    expect(compile({ all: [{ field: 'order_count', op: 'gte', value: 3 }] }).sql).toBe(
      '(c.order_count >= $1)',
    );
    expect(compile({ all: [{ field: 'lifetime_value', op: 'lt', value: 50 }] }).sql).toBe(
      '(c.lifetime_value < $1)',
    );
    expect(compile({ all: [{ field: 'lifetime_value', op: 'lte', value: 50 }] }).sql).toBe(
      '(c.lifetime_value <= $1)',
    );
  });

  it('compiles ordering on a timestamp with an explicit cast and a bound ISO value', () => {
    const c = compile({
      all: [{ field: 'last_order_at', op: 'gte', value: '2026-01-01T00:00:00Z' }],
    });
    expect(c.sql).toBe('(c.last_order_at >= $1::timestamptz)');
    expect(c.params).toEqual(['2026-01-01T00:00:00Z']);
  });

  it('compiles contains on the tags array to the gin-usable containment operator', () => {
    const c = compile({ all: [{ field: 'tags', op: 'contains', value: 'vip' }] });
    expect(c.sql).toBe('(c.tags @> $1::text[])');
    expect(c.params).toEqual([['vip']]);
  });

  it('compiles not_contains on tags to a negated containment', () => {
    expect(compile({ all: [{ field: 'tags', op: 'not_contains', value: 'vip' }] }).sql).toBe(
      '(NOT (c.tags @> $1::text[]))',
    );
  });

  it('compiles contains on a text column to ILIKE with the wildcards in the parameter', () => {
    const c = compile({ all: [{ field: 'email', op: 'contains', value: 'acme' }] });
    expect(c.sql).toBe('(c.email ILIKE $1)');
    expect(c.params).toEqual(['%acme%']);
    // The wildcards are in the value, never in the SQL text.
    expect(c.sql).not.toContain('%');
  });

  it('escapes LIKE metacharacters so a literal percent does not become a wildcard', () => {
    const c = compile({ all: [{ field: 'first_name', op: 'contains', value: '50%_off\\' }] });
    expect(c.params).toEqual(['%50\\%\\_off\\\\%']);
  });

  it('compiles not_contains on text so NULL-valued contacts are included', () => {
    expect(compile({ all: [{ field: 'phone', op: 'not_contains', value: '+44' }] }).sql).toBe(
      '((c.phone IS NULL OR c.phone NOT ILIKE $1))',
    );
  });

  it('compiles in on a text column to = ANY over a bound array', () => {
    const c = compile({ all: [{ field: 'locale', op: 'in', value: ['de', 'fr'] }] });
    expect(c.sql).toBe('(c.locale = ANY($1::text[]))');
    expect(c.params).toEqual([['de', 'fr']]);
  });

  it('compiles in on tags to array overlap, meaning "has any of these"', () => {
    expect(compile({ all: [{ field: 'tags', op: 'in', value: ['vip', 'churn'] }] }).sql).toBe(
      '(c.tags && $1::text[])',
    );
  });

  it('compiles not_in so NULL-valued contacts are included', () => {
    expect(compile({ all: [{ field: 'order_count', op: 'not_in', value: [1, 2] }] }).sql).toBe(
      '((c.order_count IS NULL OR NOT (c.order_count = ANY($1::numeric[]))))',
    );
  });

  it('compiles is_set and is_not_set without a value', () => {
    expect(compile({ all: [{ field: 'phone', op: 'is_set' }] }).sql).toBe('(c.phone IS NOT NULL)');
    expect(compile({ all: [{ field: 'phone', op: 'is_not_set' }] }).sql).toBe('(c.phone IS NULL)');
  });

  it('reads is_set on tags as "has at least one tag", because the column is NOT NULL', () => {
    expect(compile({ all: [{ field: 'tags', op: 'is_set' }] }).sql).toBe(
      '(array_length(c.tags, 1) IS NOT NULL)',
    );
    expect(compile({ all: [{ field: 'tags', op: 'is_not_set' }] }).sql).toBe(
      '(array_length(c.tags, 1) IS NULL)',
    );
  });

  it('binds within_days as an instant computed from the clock, not as now() - interval', () => {
    const c = compile({ all: [{ field: 'last_order_at', op: 'within_days', value: 30 }] });
    expect(c.sql).toBe('(c.last_order_at >= $1)');
    expect(c.params[0]).toBeInstanceOf(Date);
    expect((c.params[0] as Date).toISOString()).toBe('2026-01-30T12:00:00.000Z');
    // Determinism is the point: the same clock compiles to the same parameter.
    expect(
      (
        compile({ all: [{ field: 'last_order_at', op: 'within_days', value: 30 }] })
          .params[0] as Date
      ).toISOString(),
    ).toBe('2026-01-30T12:00:00.000Z');
  });

  it('compiles not_within_days to include contacts with no timestamp at all', () => {
    expect(
      compile({ all: [{ field: 'last_order_at', op: 'not_within_days', value: 7 }] }).sql,
    ).toBe('((c.last_order_at IS NULL OR c.last_order_at < $1))');
  });

  it('binds the JSONB attribute key as a parameter rather than splicing it', () => {
    const c = compile({ all: [{ field: 'attributes.plan', op: 'eq', value: 'pro' }] });
    expect(c.sql).toBe('((c.attributes ->> $1::text) = $2)');
    expect(c.params).toEqual(['plan', 'pro']);
    expect(c.sql).not.toContain('plan');
  });

  it('guards the numeric cast on an attribute so one dirty row cannot abort the query', () => {
    const c = compile({ all: [{ field: 'attributes.score', op: 'gt', value: 10 }] });
    expect(c.sql).toBe(
      "((jsonb_typeof((c.attributes -> $1::text)) = 'number' " +
        'AND ((c.attributes ->> $1::text))::numeric > $2))',
    );
    expect(c.params).toEqual(['score', 10]);
  });

  it('compiles is_set on an attribute to a presence test on the extracted text', () => {
    expect(compile({ all: [{ field: 'attributes.plan', op: 'is_set' }] }).sql).toBe(
      '((c.attributes ->> $1::text) IS NOT NULL)',
    );
  });
});

describe('audience compiler: injection', () => {
  const HOSTILE_FIELDS = [
    'c.email; DROP TABLE contacts --',
    "email' OR '1'='1",
    'contacts.email',
    'password_hash',
    '(SELECT password_hash FROM users)',
    '',
  ];

  for (const field of HOSTILE_FIELDS) {
    it(`rejects the field path ${JSON.stringify(field)}`, () => {
      const attempt = (): string => compile({ all: [{ field, op: 'eq', value: 'x' }] }).sql;
      expect(attempt).toThrow(AudienceCompileError);
      // And the rejected string never reached a compiled statement, because there is
      // no compiled statement: the allowlist lookup fails before any SQL is built.
      let sql: string | undefined;
      try {
        sql = attempt();
      } catch {
        // Expected; there is nothing to inspect, which is the assertion below.
      }
      expect(sql).toBeUndefined();
    });
  }

  it('rejects an attributes key containing a quote', () => {
    expect(() =>
      compile({ all: [{ field: `attributes.plan' OR 1=1 --`, op: 'eq', value: 'x' }] }),
    ).toThrow(/is not a valid key/);
    expect(() => compile({ all: [{ field: 'attributes.a"b', op: 'eq', value: 'x' }] })).toThrow(
      AudienceCompileError,
    );
    expect(() => compile({ all: [{ field: 'attributes.', op: 'eq', value: 'x' }] })).toThrow(
      AudienceCompileError,
    );
  });

  it('never places a hostile VALUE into the SQL, on any operator that accepts one', () => {
    const payload = "'; DROP TABLE contacts; --";
    const definitions: AudienceDefinition[] = [
      { all: [{ field: 'email', op: 'eq', value: payload }] },
      { all: [{ field: 'email', op: 'neq', value: payload }] },
      { all: [{ field: 'email', op: 'contains', value: payload }] },
      { all: [{ field: 'email', op: 'not_contains', value: payload }] },
      { all: [{ field: 'locale', op: 'in', value: [payload] }] },
      { all: [{ field: 'locale', op: 'not_in', value: [payload] }] },
      { all: [{ field: 'tags', op: 'contains', value: payload }] },
      { all: [{ field: 'tags', op: 'in', value: [payload] }] },
      { all: [{ field: 'attributes.plan', op: 'eq', value: payload }] },
      { all: [{ field: 'first_name', op: 'gt', value: payload }] },
    ];

    for (const definition of definitions) {
      const compiled = compile(definition);
      expect(compiled.sql).not.toContain('DROP');
      expect(compiled.sql).not.toContain(payload);
      expect(compiled.sql).not.toContain("'");
      // The payload is present, exactly once, as a bound parameter.
      const flat: unknown[] = compiled.params.flatMap((p) =>
        Array.isArray(p) ? (p as unknown[]) : [p],
      );
      expect(flat.some((p) => typeof p === 'string' && p.includes(payload))).toBe(true);
    }
  });

  it('never places a hostile attribute KEY into the SQL for keys that are legal', () => {
    const compiled = compile({ all: [{ field: 'attributes.drop_table_contacts', op: 'is_set' }] });
    expect(compiled.sql).not.toContain('drop_table_contacts');
    expect(compiled.params).toEqual(['drop_table_contacts']);
  });

  it('rejects an unknown operator', () => {
    const rogue = {
      all: [{ field: 'email', op: 'regex', value: '.*' }],
    } as unknown as AudienceDefinition;
    expect(() => compile(rogue)).toThrow(AudienceCompileError);
  });

  it('names the offending rule path in the error', () => {
    expect(() =>
      compile({
        all: [
          { field: 'locale', op: 'eq', value: 'de' },
          { any: [{ field: 'nope', op: 'eq', value: 'x' }] },
        ],
      }),
    ).toThrow(/all\[1\]\.any\[0\]/);
  });
});

describe('audience compiler: value shape validation', () => {
  it('rejects in without an array', () => {
    expect(() => compile({ all: [{ field: 'locale', op: 'in', value: 'de' }] })).toThrow(
      /requires an array/,
    );
  });

  it('rejects in with an empty array rather than compiling a segment that matches nobody', () => {
    expect(() => compile({ all: [{ field: 'locale', op: 'in', value: [] }] })).toThrow(
      /non-empty array/,
    );
  });

  it('rejects a missing value on an operator that needs one', () => {
    expect(() => compile({ all: [{ field: 'locale', op: 'eq' }] })).toThrow(/requires a value/);
  });

  it('rejects a value on is_set', () => {
    expect(() => compile({ all: [{ field: 'phone', op: 'is_set', value: true }] })).toThrow(
      /takes no value/,
    );
  });

  it('rejects a non-number on a number field', () => {
    expect(() => compile({ all: [{ field: 'order_count', op: 'gt', value: 'three' }] })).toThrow(
      /finite number/,
    );
  });

  it('rejects an epoch number on a timestamp field, because seconds and millis are ambiguous', () => {
    expect(() =>
      compile({ all: [{ field: 'last_order_at', op: 'gte', value: 1_700_000_000 }] }),
    ).toThrow(/ISO-8601/);
  });

  it('rejects within_days on something that is not a timestamp', () => {
    expect(() =>
      compile({ all: [{ field: 'order_count', op: 'within_days', value: 30 }] }),
    ).toThrow(/only defined on timestamp fields/);
  });

  it('rejects a negative within_days', () => {
    expect(() =>
      compile({ all: [{ field: 'last_order_at', op: 'within_days', value: -1 }] }),
    ).toThrow(/non-negative/);
  });

  it('rejects eq on the tags array and says what to use instead', () => {
    expect(() => compile({ all: [{ field: 'tags', op: 'eq', value: 'vip' }] })).toThrow(
      /Use 'contains' for one tag/,
    );
  });

  it('rejects a substring test on a numeric column', () => {
    expect(() => compile({ all: [{ field: 'order_count', op: 'contains', value: '3' }] })).toThrow(
      /substring test/,
    );
  });
});

describe('audience compiler: nesting and identities', () => {
  it('compiles the empty definition to TRUE, matching everyone', () => {
    expect(compile({})).toEqual({ sql: 'TRUE', params: [] });
  });

  it('compiles an empty all group to TRUE and an empty any group to FALSE', () => {
    expect(compile({ all: [] }).sql).toBe('TRUE');
    expect(compile({ any: [] }).sql).toBe('FALSE');
    // NOT of the OR-identity: excluding nobody excludes nobody.
    expect(compile({ none: [] }).sql).toBe('NOT FALSE');
  });

  it('parenthesises a nested any inside an all', () => {
    const c = compile({
      all: [
        { field: 'order_count', op: 'gte', value: 1 },
        {
          any: [
            { field: 'locale', op: 'eq', value: 'de' },
            { field: 'locale', op: 'eq', value: 'fr' },
          ],
        },
      ],
    });
    expect(c.sql).toBe('(c.order_count >= $1 AND (c.locale = $2 OR c.locale = $3))');
    expect(c.params).toEqual([1, 'de', 'fr']);
  });

  it('parenthesises none as a negated OR', () => {
    const c = compile({
      none: [
        { field: 'tags', op: 'contains', value: 'unsubscribed' },
        { field: 'tags', op: 'contains', value: 'bounced' },
      ],
    });
    expect(c.sql).toBe('NOT (c.tags @> $1::text[] OR c.tags @> $2::text[])');
  });

  it('joins the three top-level groups with AND', () => {
    const c = compile({
      all: [{ field: 'order_count', op: 'gte', value: 1 }],
      any: [{ field: 'locale', op: 'eq', value: 'de' }],
      none: [{ field: 'tags', op: 'contains', value: 'vip' }],
    });
    expect(c.sql).toBe(
      '((c.order_count >= $1) AND (c.locale = $2) AND NOT (c.tags @> $3::text[]))',
    );
    expect(c.params).toEqual([1, 'de', ['vip']]);
  });

  it('keeps deeply nested combinators correct and numbers every parameter once', () => {
    const c = compile({
      all: [
        {
          any: [
            {
              all: [
                { field: 'order_count', op: 'gt', value: 5 },
                { field: 'locale', op: 'eq', value: 'de' },
              ],
            },
            { none: [{ field: 'tags', op: 'contains', value: 'churn' }] },
          ],
        },
      ],
    });
    expect(c.sql).toBe('(((c.order_count > $1 AND c.locale = $2) OR NOT (c.tags @> $3::text[])))');
    expect(c.params).toEqual([5, 'de', ['churn']]);
  });
});
