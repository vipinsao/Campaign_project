import { z } from 'zod';

/**
 * The output contract  (V5).
 *
 * `z.strictObject`, not `z.object`, and the difference is the whole point.
 * `z.object` STRIPS unknown keys: a model that returns
 * `{label:'positive', action:'resubscribe'}` would parse cleanly, the extra field
 * would vanish, and nothing anywhere would record that the model had tried to
 * ask for something it is not allowed to ask for. `strictObject` makes that a
 * schema violation, which is escalated to a human rather than coerced into a
 * plausible-looking success.
 *
 * The generated JSON Schema is also what is handed to the API as a structured
 * output format, so the same declaration constrains generation AND validates the
 * result. Two copies of a schema drift; one does not.
 */

export const ReplyLabel = z.enum(['question', 'complaint', 'opt_out', 'positive', 'other']);
export type ReplyLabel = z.infer<typeof ReplyLabel>;

export const Urgency = z.enum(['low', 'normal', 'high']);
export type Urgency = z.infer<typeof Urgency>;

/**
 * Everything here is a judgement about PROSE — tone, topic, gist. Nothing here is
 * arithmetic, identity or permission.
 *
 * `entities.order_number_mentioned` is the one that looks like an exception and is
 * not: it records what the model thinks it read, and it is never used to look up
 * an order. Identity resolution goes through `extractOrderNumber`, which is a
 * regex plus a database existence check and can return `ambiguous`. A model that
 * confidently reads "1234" as order 12345 would otherwise send one customer's
 * order details to another customer.
 */
export const ReplyClassification = z.strictObject({
  label: ReplyLabel,
  /** The model's own certainty. Compared against tenants.confidence_threshold (V6). */
  confidence: z.number().min(0).max(1),
  /** One sentence for the review queue. Prose in, prose out. */
  summary: z.string().min(1).max(280),
  urgency: Urgency,
  entities: z.strictObject({
    order_number_mentioned: z.string().max(64).nullable(),
    product_mentioned: z.string().max(120).nullable(),
  }),
});
export type ReplyClassification = z.infer<typeof ReplyClassification>;

/**
 * Prompts name their schema in front matter rather than embedding it, so the
 * prompt file and the parser cannot disagree about what a valid answer looks like.
 */
export const OUTPUT_SCHEMAS = {
  'reply-classification': ReplyClassification,
} as const;

export type OutputSchemaName = keyof typeof OUTPUT_SCHEMAS;

export function isOutputSchemaName(name: string): name is OutputSchemaName {
  return Object.hasOwn(OUTPUT_SCHEMAS, name);
}

/** JSON Schema for the API's structured-output format. Derived, never hand-written. */
export function jsonSchemaFor(name: OutputSchemaName): Record<string, unknown> {
  return z.toJSONSchema(OUTPUT_SCHEMAS[name]);
}
