import { api } from './api.ts';

/**
 * The storefront's own client types.
 *
 * Kept apart from `lib/types.ts` because these describe an UNAUTHENTICATED
 * surface. Everything in types.ts is behind an operator session and can assume a
 * tenant; nothing here can. Mixing them is how a component ends up importing
 * `readToken` on a page that must work for a stranger.
 */

export type Product = {
  readonly sku: string;
  readonly name: string;
  readonly price: number;
  readonly blurb: string;
};

export type ChannelCapability = {
  readonly live: boolean;
  readonly provider: string | null;
  readonly detail: string;
  readonly whatsapp?: boolean;
  /** Present only for the Twilio WhatsApp sandbox, which requires the recipient to opt in first. */
  readonly joinInstructions?: string | null;
};

export type StorefrontConfigResponse = {
  readonly currency: string;
  readonly catalogue: readonly Product[];
  readonly sendMode: 'off' | 'mock' | 'live';
  readonly channels: { readonly email: ChannelCapability; readonly sms: ChannelCapability };
  readonly budget: { readonly limit: number; readonly spent: number; readonly remaining: number };
};

export type CheckoutResponse = {
  readonly ok: boolean;
  readonly orderNumber: string;
  readonly total: string;
  readonly currency: string;
  readonly receiptToken: string | null;
  readonly contactId: string;
  readonly enrolled: number;
  readonly queued: number;
  readonly flushed: {
    readonly claimed: number;
    readonly sent: number;
    readonly failed: number;
    readonly deferred: number;
    readonly skipped: number;
    readonly refusedWithoutClaim: boolean;
  };
  readonly notes: readonly string[];
};

export type ReceiptMessage = {
  readonly id: string;
  readonly channel: 'email' | 'sms';
  readonly status: string;
  readonly campaign: string;
  readonly to: string;
  readonly subject: string | null;
  readonly body: string;
  readonly provider: string | null;
  readonly providerMessageId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly attempts: number;
  readonly scheduledAt: string;
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
};

export type ReceiptDecision = {
  readonly stage: string;
  readonly decision: string;
  readonly reasonCode: string;
  readonly detail: string | null;
  readonly campaign: string | null;
  readonly at: string;
};

export type Receipt = {
  /** False in mock mode: nothing in the repo replays the simulated callbacks. */
  readonly deliveryReceiptsExpected: boolean;
  readonly sendMode: 'off' | 'mock' | 'live';
  readonly order: {
    readonly number: string;
    readonly status: string;
    readonly total: string;
    readonly currency: string;
    readonly placedAt: string;
    readonly items: readonly { sku: string; name: string; qty: number; price: number }[];
  };
  readonly contact: {
    readonly firstName: string | null;
    readonly email: string | null;
    readonly phone: string | null;
  };
  readonly messages: readonly ReceiptMessage[];
  readonly decisions: readonly ReceiptDecision[];
};

export const storefront = {
  config: () => api.get<StorefrontConfigResponse>('/storefront/config'),
  checkout: (body: unknown) => api.post<CheckoutResponse>('/storefront/checkout', body),
  receipt: (token: string) => api.get<Receipt>(`/storefront/receipt/${token}`),
};
