import { z } from 'zod';

/**
 * The audience DSL.
 *
 * Kept deliberately small. A segmentation DSL that grows unbounded becomes a
 * second, worse query language, and every operator ends up needing an engineer to
 * explain why their segment matched nobody.
 *
 * Two properties matter more than the vocabulary:
 *
 *  1. Field paths come from a FIXED ALLOWLIST, and values are always bound as
 *     placeholders. The compiler never interpolates an operator-supplied value
 *     into SQL text. `/audience/estimate` returns the compiled SQL to the UI with
 *     the placeholders still visible, which is a feature — the operator can see
 *     exactly what will run — and is also why it must never be built by splicing.
 *
 *  2. `matches` (one contact) and `estimate` (the set) are two evaluations of the
 *     SAME compiled predicate. Two implementations always drift, and the operator
 *     sees a count that disagrees with who actually received the message.
 */
export const AudienceOperator = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'is_set',
  'is_not_set',
  'within_days',
  'not_within_days',
]);
export type AudienceOperator = z.infer<typeof AudienceOperator>;

/** Every queryable field, and the only strings the compiler will accept. */
export const AUDIENCE_FIELDS = {
  tags: { column: 'c.tags', type: 'text[]' },
  email: { column: 'c.email', type: 'text' },
  phone: { column: 'c.phone', type: 'text' },
  locale: { column: 'c.locale', type: 'text' },
  timezone: { column: 'c.timezone', type: 'text' },
  first_name: { column: 'c.first_name', type: 'text' },
  last_name: { column: 'c.last_name', type: 'text' },
  order_count: { column: 'c.order_count', type: 'number' },
  lifetime_value: { column: 'c.lifetime_value', type: 'number' },
  first_order_at: { column: 'c.first_order_at', type: 'timestamp' },
  last_order_at: { column: 'c.last_order_at', type: 'timestamp' },
  created_at: { column: 'c.created_at', type: 'timestamp' },
} as const;

export type AudienceFieldName = keyof typeof AUDIENCE_FIELDS;

/** `attributes.<key>` reaches into the JSONB column; the key is escaped, not spliced. */
export const ATTRIBUTE_PREFIX = 'attributes.';

const RuleLeaf = z.object({
  field: z.string().min(1),
  op: AudienceOperator,
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
    .optional(),
});

export type AudienceRule =
  | z.infer<typeof RuleLeaf>
  | { all: AudienceRule[] }
  | { any: AudienceRule[] }
  | { none: AudienceRule[] };

export const AudienceRule: z.ZodType<AudienceRule> = z.lazy(() =>
  z.union([
    RuleLeaf,
    z.object({ all: z.array(AudienceRule) }),
    z.object({ any: z.array(AudienceRule) }),
    z.object({ none: z.array(AudienceRule) }),
  ]),
);

/**
 * An empty audience matches everyone; that is stated, not implied.
 *
 * `.strict()` on BOTH members is load-bearing and was a real bug here before a
 * test caught it. Without it, a typo in a segment key — `{ alll: [...] }` — is a
 * valid definition with no recognised combinators, which compiles to `TRUE` and
 * sends the campaign to every contact in the tenant. A segmentation mistake should
 * be a validation error, never a full-tenant blast, and the difference is one
 * method call.
 */
export const AudienceDefinition = z
  .object({
    all: z.array(AudienceRule).optional(),
    any: z.array(AudienceRule).optional(),
    none: z.array(AudienceRule).optional(),
  })
  .strict();
export type AudienceDefinition = z.infer<typeof AudienceDefinition>;

export type CompiledAudience = {
  /** SQL fragment with $n placeholders. Never contains an operator-supplied value. */
  sql: string;
  params: unknown[];
};
