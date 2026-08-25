import { z } from 'zod';

// ─── Channels, categories, statuses ──────────────────────────────────────────

export const Channel = z.enum(['email', 'sms']);
export type Channel = z.infer<typeof Channel>;

/**
 * Deliberately small, and enforced by a CHECK constraint in the database as well
 * as here. Adding a fifth category requires a migration and an ADR, not a one-line
 * edit — taxonomies grow by accretion until nobody can say what a category means.
 */
export const CampaignCategory = z.enum([
  'lifecycle',
  'promotional',
  'transactional',
  'operational',
]);
export type CampaignCategory = z.infer<typeof CampaignCategory>;

/** Categories that carry a legal obligation to offer opt-out (I7). */
export const MARKETING_CATEGORIES: readonly CampaignCategory[] = ['lifecycle', 'promotional'];

export function isMarketingCategory(c: CampaignCategory): boolean {
  return MARKETING_CATEGORIES.includes(c);
}

export const CampaignStatus = z.enum(['draft', 'observe', 'active', 'paused', 'archived']);
export type CampaignStatus = z.infer<typeof CampaignStatus>;

export const TriggerType = z.enum([
  'order_placed',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'days_since_last_order',
  'contact_created',
  'manual',
  'api_event',
]);
export type TriggerType = z.infer<typeof TriggerType>;

export const QueueStatus = z.enum([
  'pending',
  'processing',
  'sent',
  'delivered',
  'failed',
  'cancelled',
  'suppressed',
  'bounced',
  'complained',
]);
export type QueueStatus = z.infer<typeof QueueStatus>;

export const EventType = z.enum([
  'queued',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced',
  'complained',
  'failed',
  'cancelled',
  'suppressed',
  'unsubscribed',
  'replied',
  'converted',
]);
export type EventType = z.infer<typeof EventType>;

export const SendCondition = z.enum([
  'always',
  'opened_previous',
  'not_opened_previous',
  'clicked_previous',
  'not_clicked_previous',
  'replied',
  'not_replied',
]);
export type SendCondition = z.infer<typeof SendCondition>;

export const DelayAnchor = z.enum(['trigger', 'previous', 'delivery']);
export type DelayAnchor = z.infer<typeof DelayAnchor>;

export const ConsentState = z.enum(['opted_in', 'opted_out']);
export type ConsentState = z.infer<typeof ConsentState>;

export const ConsentSource = z.enum([
  'signup',
  'checkout',
  'preference_center',
  'unsubscribe_link',
  'sms_stop',
  'bounce',
  'complaint',
  'import',
  'operator',
  'api',
]);
export type ConsentSource = z.infer<typeof ConsentSource>;

export const SuppressionReason = z.enum([
  'unsubscribe',
  'sms_stop',
  'hard_bounce',
  'complaint',
  'manual',
  'invalid',
]);
export type SuppressionReason = z.infer<typeof SuppressionReason>;

// ─── Recipient resolution (I13) ──────────────────────────────────────────────

/**
 * The type that makes I13 unavoidable.
 *
 * Order numbers are unique per store, not globally. A function returning
 * `Order | null` invites the caller to take the first match; a union with an
 * explicit `ambiguous` arm forces every caller to decide what to do about it,
 * at compile time. Silently picking the most recent match sends one customer's
 * order details to a different customer.
 */
export type RecipientResolution<T> =
  | { kind: 'none' }
  | { kind: 'single'; match: T }
  | { kind: 'ambiguous'; candidates: T[] };

// ─── Send-time gate results ──────────────────────────────────────────────────

/**
 * `retryable` is the distinction that keeps the system honest.
 *
 *   retryable  — "not now": quiet hours, frequency cap, a paused campaign.
 *                The message is deferred and will be reconsidered.
 *   terminal   — "not ever": opted out, suppressed, no valid address.
 *                The message is cancelled and never reconsidered.
 *
 * Collapsing these two into one boolean is how a message that was correctly held
 * back for the night becomes a message that was permanently destroyed.
 */
export type GateResult =
  | { pass: true }
  | {
      pass: false;
      retryable: boolean;
      code: string;
      detail: string;
      nextEligibleAt?: Date;
    };

export type SendOutcome =
  | 'SENT'
  | 'FAILED'
  | 'SKIPPED'
  | 'DEFERRED'
  | 'ALREADY_CLAIMED'
  | 'SKIPPED_WITHOUT_CLAIM';

// ─── Provider contracts ─────────────────────────────────────────────────────

export type ProviderResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; errorCode: string; errorMessage: string; raw: unknown };

/**
 * Terminal errors are NEVER retried. Resending a carrier-rejected message three
 * times does not make the carrier accept it; it just triples the cost and the
 * complaint surface. (I8)
 */
export type ErrorClass = 'terminal' | 'transient';
