import type { Channel, ProviderResult, ErrorClass } from './domain.ts';

/**
 * The provider contract.
 *
 * `packages/providers` is the ONLY package permitted to import a vendor SDK, and
 * a test asserts no `twilio` / `nodemailer` / `postmark` import exists anywhere
 * else. That boundary is what lets the entire domain be tested with no network and
 * no credentials — which in turn is what lets a reviewer clone this repository and
 * watch the full message lifecycle without creating a single account.
 */
export type OutboundMessage = {
  readonly id: string;
  readonly tenantId: string;
  readonly channel: Channel;
  readonly to: string;
  readonly from: string;
  readonly subject?: string | undefined;
  readonly body: string;
  readonly html?: string | undefined;
  readonly trackingId: string;
};

export type ProviderEvent = {
  readonly providerMessageId: string;
  readonly type: 'delivered' | 'bounced' | 'complained' | 'failed' | 'opened' | 'clicked';
  readonly occurredAt: Date;
  /** The provider's own event id. Used as the event idempotency key so a
   *  redelivered webhook is free rather than double-counted. */
  readonly providerEventId: string;
  readonly errorCode?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
};

export interface MessageProvider {
  readonly name: string;
  readonly channel: Channel;
  send(msg: OutboundMessage): Promise<ProviderResult>;
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer, secret: string): boolean;
  parseWebhook(payload: unknown): ProviderEvent[];
}

/**
 * Error classification is DATA, not a chain of `if`s  (I8).
 *
 * A table can be reviewed, diffed, extended from real traffic, and asserted over
 * in a table-driven test. An `if (msg.includes('invalid'))` chain can do none of
 * those things, and it is where "retried a permanently-rejected message three
 * times" comes from.
 */
export type ErrorRule = {
  readonly provider: string;
  readonly code: string;
  readonly class: ErrorClass;
  readonly meaning: string;
  /** Terminal codes never retry. Transient codes may cap below the global limit. */
  readonly maxAttempts?: number;
};

export type Classification = {
  readonly class: ErrorClass;
  readonly meaning: string;
  readonly maxAttempts: number;
  /** True when the code was not in the table and the conservative default applied. */
  readonly unmapped: boolean;
};
