import { AUDIENCE_FIELDS, ATTRIBUTE_PREFIX } from '@campaign/shared';
import type {
  AudienceDefinition,
  AudienceOperator,
  AudienceRule,
  CompiledAudience,
} from '@campaign/shared';
import type { Clock } from '../clock.ts';

/**
 * Compiles the audience DSL into a SQL predicate over `contacts c`.
 *
 * This file is the single most likely injection hole in the whole system, and it is
 * worth saying why out loud: the product lets an operator define a query. Every
 * other endpoint takes values from a user; this one takes STRUCTURE from a user, and
 * structure is the thing that normally gets concatenated. Two rules hold absolutely,
 * and everything else here is detail:
 *
 *  1. Nothing operator-supplied ever becomes SQL TEXT. Field paths are looked up in
 *     the fixed AUDIENCE_FIELDS allowlist and the SQL that comes out is the constant
 *     string recorded there, never the string the operator sent. An unknown path is
 *     an error, not a passthrough.
 *  2. Every value is bound as a `$n` placeholder — including the JSONB key in
 *     `attributes.<key>`, which is the one that looks like it has to be spliced and
 *     does not (`c.attributes ->> $n::text` takes the key as a parameter).
 *
 * Those two together are why `/audience/estimate` can hand the compiled SQL back to
 * the browser for the "show me what will run" disclosure. That disclosure is only
 * safe because the SQL provably cannot contain an operator-supplied value: what is
 * being displayed is a shape, and the values sit beside it in the params array. If a
 * single branch here ever interpolated, the disclosure would become an oracle that
 * echoes the injected string back and confirms it landed.
 *
 * The attribute key is additionally checked against a conservative charset. That is
 * defence in depth and nothing is relying on it — the binding is what makes it safe.
 * It earns its place by catching operator typos (a stray quote in a segment builder)
 * at compile time with a readable message instead of at query time with zero rows.
 */

const MS_PER_DAY = 86_400_000;

/** JSONB keys real customer data actually uses. Deliberately narrower than JSON allows. */
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** Carries the rule path so an operator staring at a 40-rule segment knows which one. */
export class AudienceCompileError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Audience rule at ${path}: ${message}`);
    this.name = 'AudienceCompileError';
    this.path = path;
  }
}

type FieldKind = 'text' | 'number' | 'timestamp' | 'text[]' | 'attribute';

type FieldRef = {
  readonly kind: FieldKind;
  /** SQL expression yielding the value. Placeholders only; never operator text. */
  readonly expr: string;
  /** `c.attributes -> $n::text` for attribute fields, so ordering can guard its cast. */
  readonly jsonExpr: string | null;
};

/**
 * The only way a value reaches the query. Returning the placeholder rather than the
 * value makes the safe path the path of least resistance: there is no method here
 * that yields a string you could paste into SQL.
 */
class ParamBag {
  readonly values: unknown[] = [];

  bind(value: unknown): string {
    return `$${this.values.push(value)}`;
  }
}

/** Bounded so a hostile 4KB field path cannot turn an error log into the payload. */
function excerpt(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}...` : value;
}

function fieldNames(): string {
  return `${Object.keys(AUDIENCE_FIELDS).join(', ')}, or ${ATTRIBUTE_PREFIX}<key>`;
}

function resolveField(path: string, params: ParamBag, at: string): FieldRef {
  if (path.startsWith(ATTRIBUTE_PREFIX)) {
    const key = path.slice(ATTRIBUTE_PREFIX.length);
    if (!ATTRIBUTE_KEY_PATTERN.test(key)) {
      throw new AudienceCompileError(
        at,
        `attribute key '${excerpt(key)}' is not a valid key. ` +
          `Keys are 1-64 characters of letters, digits, underscore, dot or hyphen.`,
      );
    }
    const keyParam = params.bind(key);
    return {
      kind: 'attribute',
      // The `::text` cast is required, not cosmetic: `jsonb -> unknown` is ambiguous
      // in Postgres because both the int and text overloads are candidates, and the
      // driver sends parameters untyped.
      expr: `(c.attributes ->> ${keyParam}::text)`,
      jsonExpr: `(c.attributes -> ${keyParam}::text)`,
    };
  }

  // Index through a widened record so an unknown path is `undefined` rather than a
  // type assertion that would let a bad path through at runtime.
  const allow: Record<string, { readonly column: string; readonly type: string } | undefined> =
    AUDIENCE_FIELDS;
  const known = allow[path];
  if (!known) {
    throw new AudienceCompileError(
      at,
      `unknown field '${excerpt(path)}'. Allowed fields are ${fieldNames()}.`,
    );
  }
  return { kind: known.type as FieldKind, expr: known.column, jsonExpr: null };
}

type RuleValue = string | number | boolean | (string | number)[];
type Leaf = {
  readonly field: string;
  readonly op: AudienceOperator;
  readonly value?: RuleValue | undefined;
};

function requireValue(leaf: Leaf, at: string): RuleValue {
  if (leaf.value === undefined) {
    throw new AudienceCompileError(at, `'${leaf.op}' requires a value.`);
  }
  return leaf.value;
}

function requireNumber(leaf: Leaf, at: string): number {
  const value = requireValue(leaf, at);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AudienceCompileError(
      at,
      `'${leaf.op}' on '${leaf.field}' requires a finite number, received ${typeof value}.`,
    );
  }
  return value;
}

function requireText(leaf: Leaf, at: string): string {
  const value = requireValue(leaf, at);
  if (Array.isArray(value)) {
    throw new AudienceCompileError(at, `'${leaf.op}' on '${leaf.field}' takes a single value, not a list.`);
  }
  return typeof value === 'string' ? value : String(value);
}

function requireTimestamp(leaf: Leaf, at: string): string {
  const value = requireValue(leaf, at);
  // A bare number is refused on purpose. "1700000000" is either seconds or
  // milliseconds depending on who wrote the client, and guessing wrong moves a
  // segment by fifty years without erroring.
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new AudienceCompileError(
      at,
      `'${leaf.op}' on the timestamp field '${leaf.field}' requires an ISO-8601 string.`,
    );
  }
  return value;
}

function requireList(leaf: Leaf, at: string): (string | number)[] {
  const value = requireValue(leaf, at);
  if (!Array.isArray(value)) {
    throw new AudienceCompileError(at, `'${leaf.op}' on '${leaf.field}' requires an array of values.`);
  }
  if (value.length === 0) {
    // An empty list would compile to a predicate matching nobody, which reads as a
    // broken segment rather than as the empty list it is. Say so at compile time.
    throw new AudienceCompileError(at, `'${leaf.op}' on '${leaf.field}' requires a non-empty array.`);
  }
  return value;
}

/**
 * Escapes the LIKE metacharacters so a value containing `%` matches a literal `%`.
 * Without this, `contains "50%"` quietly becomes a two-part wildcard search — not a
 * security hole, since the value is still bound, but a correctness one that shows up
 * as a segment mysteriously larger than the operator expected.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

const ORDERING: Record<'gt' | 'gte' | 'lt' | 'lte', string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

function compileLeaf(leaf: Leaf, params: ParamBag, clock: Clock, at: string): string {
  const field = resolveField(leaf.field, params, at);
  const op = leaf.op;

  if (op === 'is_set' || op === 'is_not_set') {
    if (leaf.value !== undefined) {
      throw new AudienceCompileError(at, `'${op}' takes no value.`);
    }
    if (field.kind === 'text[]') {
      // `tags` is NOT NULL DEFAULT '{}', so IS NOT NULL is true for every contact
      // in the table. On an array column "is set" has to mean "has at least one".
      return op === 'is_set'
        ? `array_length(${field.expr}, 1) IS NOT NULL`
        : `array_length(${field.expr}, 1) IS NULL`;
    }
    return op === 'is_set' ? `${field.expr} IS NOT NULL` : `${field.expr} IS NULL`;
  }

  if (op === 'within_days' || op === 'not_within_days') {
    if (field.kind !== 'timestamp') {
      throw new AudienceCompileError(
        at,
        `'${op}' is only defined on timestamp fields; '${leaf.field}' is ${field.kind}.`,
      );
    }
    const days = requireNumber(leaf, at);
    if (days < 0) {
      throw new AudienceCompileError(at, `'${op}' requires a non-negative number of days.`);
    }
    // The boundary instant is computed here from the injected clock and BOUND, not
    // expressed as `now() - interval`. Two consequences, both wanted: the predicate
    // is deterministic under FakeClock, and `matches` and `estimate` compare against
    // the identical instant instead of two server clock reads a few milliseconds
    // apart, which is exactly the kind of drift that makes a count unreproducible.
    const since = params.bind(new Date(clock.now().getTime() - days * MS_PER_DAY));
    return op === 'within_days'
      ? `${field.expr} >= ${since}`
      : `(${field.expr} IS NULL OR ${field.expr} < ${since})`;
  }

  if (op === 'contains' || op === 'not_contains') {
    if (field.kind === 'text[]') {
      const wanted = params.bind([requireText(leaf, at)]);
      return op === 'contains'
        ? `${field.expr} @> ${wanted}::text[]`
        : `NOT (${field.expr} @> ${wanted}::text[])`;
    }
    if (field.kind === 'number' || field.kind === 'timestamp') {
      throw new AudienceCompileError(
        at,
        `'${op}' is a substring test and is not defined on the ${field.kind} field '${leaf.field}'.`,
      );
    }
    const pattern = params.bind(`%${escapeLike(requireText(leaf, at))}%`);
    // The wildcards are added to the PARAMETER, never to the SQL. Postgres' default
    // LIKE escape character is backslash, which is what escapeLike doubles.
    return op === 'contains'
      ? `${field.expr} ILIKE ${pattern}`
      : `(${field.expr} IS NULL OR ${field.expr} NOT ILIKE ${pattern})`;
  }

  if (op === 'in' || op === 'not_in') {
    const list = requireList(leaf, at);
    if (field.kind === 'text[]') {
      // "tags in [a, b]" reads as "has any of these tags", which is array overlap.
      const wanted = params.bind(list.map((v) => String(v)));
      return op === 'in'
        ? `${field.expr} && ${wanted}::text[]`
        : `NOT (${field.expr} && ${wanted}::text[])`;
    }
    if (field.kind === 'number') {
      const nums = list.map((v) => {
        if (typeof v !== 'number') {
          throw new AudienceCompileError(at, `'${op}' on the number field '${leaf.field}' takes numbers.`);
        }
        return v;
      });
      const wanted = params.bind(nums);
      return op === 'in'
        ? `${field.expr} = ANY(${wanted}::numeric[])`
        : `(${field.expr} IS NULL OR NOT (${field.expr} = ANY(${wanted}::numeric[])))`;
    }
    if (field.kind === 'timestamp') {
      const wanted = params.bind(list.map((v) => String(v)));
      return op === 'in'
        ? `${field.expr} = ANY(${wanted}::timestamptz[])`
        : `(${field.expr} IS NULL OR NOT (${field.expr} = ANY(${wanted}::timestamptz[])))`;
    }
    const wanted = params.bind(list.map((v) => String(v)));
    // Note: `email` is citext, and `citext = ANY(text[])` resolves through the
    // implicit citext-to-text cast, so `in` is case-SENSITIVE where `eq` is not.
    // Recorded rather than papered over; a cast to citext[] here would make the
    // compiler carry a per-column exception list for one field.
    return op === 'in'
      ? `${field.expr} = ANY(${wanted}::text[])`
      : `(${field.expr} IS NULL OR NOT (${field.expr} = ANY(${wanted}::text[])))`;
  }

  if (op === 'eq' || op === 'neq') {
    if (field.kind === 'text[]') {
      throw new AudienceCompileError(
        at,
        `'${op}' is not defined on the array field '${leaf.field}'. ` +
          `Use 'contains' for one tag or 'in' for any of several.`,
      );
    }
    const bound =
      field.kind === 'timestamp'
        ? `${params.bind(requireTimestamp(leaf, at))}::timestamptz`
        : field.kind === 'number'
          ? params.bind(requireNumber(leaf, at))
          : params.bind(requireText(leaf, at));
    // `IS DISTINCT FROM` rather than `<>`: an operator who asks for "locale is not
    // 'de'" means to include the contacts whose locale is unknown. Plain `<>` drops
    // every NULL and silently shrinks the segment.
    return op === 'eq' ? `${field.expr} = ${bound}` : `${field.expr} IS DISTINCT FROM ${bound}`;
  }

  const sqlOp = ORDERING[op];
  if (field.kind === 'number') {
    return `${field.expr} ${sqlOp} ${params.bind(requireNumber(leaf, at))}`;
  }
  if (field.kind === 'timestamp') {
    return `${field.expr} ${sqlOp} ${params.bind(requireTimestamp(leaf, at))}::timestamptz`;
  }
  if (field.kind === 'attribute') {
    const value = requireValue(leaf, at);
    if (typeof value === 'number') {
      // JSONB is untyped storage, so a numeric cast on it aborts the whole query the
      // first time one contact stored "n/a" in the attribute. jsonb_typeof gates the
      // cast so a dirty row is a non-match rather than a 500.
      const bound = params.bind(value);
      return (
        `(jsonb_typeof(${field.jsonExpr ?? ''}) = 'number' ` +
        `AND (${field.expr})::numeric ${sqlOp} ${bound})`
      );
    }
    // Text ordering on an attribute is lexicographic, which is what makes it useful
    // for the ISO-8601 strings that customers put in attributes.
    return `${field.expr} ${sqlOp} ${params.bind(requireText(leaf, at))}`;
  }
  if (field.kind === 'text') {
    return `${field.expr} ${sqlOp} ${params.bind(requireText(leaf, at))}`;
  }
  throw new AudienceCompileError(
    at,
    `'${op}' is an ordering comparison and is not defined on the array field '${leaf.field}'.`,
  );
}

function combine(
  rules: readonly AudienceRule[],
  joiner: 'AND' | 'OR',
  /** The identity of the joiner: AND of nothing is TRUE, OR of nothing is FALSE. */
  identity: 'TRUE' | 'FALSE',
  params: ParamBag,
  clock: Clock,
  at: string,
): string {
  if (rules.length === 0) return identity;
  const parts = rules.map((rule, i) => compileRule(rule, params, clock, `${at}[${i}]`));
  // Always parenthesised. Precedence between AND and OR is the classic way a nested
  // segment silently means something other than what the builder UI drew.
  return `(${parts.join(` ${joiner} `)})`;
}

function compileRule(rule: AudienceRule, params: ParamBag, clock: Clock, at: string): string {
  if ('all' in rule) return combine(rule.all, 'AND', 'TRUE', params, clock, `${at}.all`);
  if ('any' in rule) return combine(rule.any, 'OR', 'FALSE', params, clock, `${at}.any`);
  if ('none' in rule) {
    return `NOT ${combine(rule.none, 'OR', 'FALSE', params, clock, `${at}.none`)}`;
  }
  return compileLeaf(rule, params, clock, at);
}

type DefinitionGroups = {
  readonly all?: readonly AudienceRule[];
  readonly any?: readonly AudienceRule[];
  readonly none?: readonly AudienceRule[];
};

/**
 * Compile a definition into `{ sql, params }`. The SQL is a bare predicate over the
 * alias `c`; the caller supplies the FROM and the tenant scope, because tenancy is
 * not something a segment definition is allowed to have an opinion about.
 */
export function compileAudience(definition: AudienceDefinition, clock: Clock): CompiledAudience {
  const params = new ParamBag();
  const groups = definition as DefinitionGroups;
  const parts: string[] = [];

  if (groups.all !== undefined) parts.push(combine(groups.all, 'AND', 'TRUE', params, clock, 'all'));
  if (groups.any !== undefined) parts.push(combine(groups.any, 'OR', 'FALSE', params, clock, 'any'));
  if (groups.none !== undefined) {
    parts.push(`NOT ${combine(groups.none, 'OR', 'FALSE', params, clock, 'none')}`);
  }

  // An empty definition matches EVERYONE, and it compiles to the literal `TRUE`
  // rather than to an empty string. Stated, not implied: a compiler that returned
  // `''` here would leave the caller to concatenate `WHERE  AND ...`, and the first
  // caller who got that wrong would send a campaign to an entire tenant.
  if (parts.length === 0) return { sql: 'TRUE', params: [] };

  const sql = parts.length === 1 ? (parts[0] ?? 'TRUE') : `(${parts.join(' AND ')})`;
  return { sql, params: params.values };
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => describeValue(v)).join(', ')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'null';
}

/** Human-readable rendering, used for `failedRule`. Never used to build SQL. */
export function describeRule(rule: AudienceRule): string {
  if ('all' in rule) return `all of (${rule.all.map((r) => describeRule(r)).join('; ')})`;
  if ('any' in rule) return `any of (${rule.any.map((r) => describeRule(r)).join('; ')})`;
  if ('none' in rule) return `none of (${rule.none.map((r) => describeRule(r)).join('; ')})`;
  if (rule.op === 'is_set' || rule.op === 'is_not_set') return `${rule.field} ${rule.op}`;
  return `${rule.field} ${rule.op} ${describeValue(rule.value)}`;
}
