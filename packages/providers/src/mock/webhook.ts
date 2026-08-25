import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ProviderEvent } from '@campaign/shared';
import { readHeader } from '../http.ts';

/**
 * The mock provider's callback format.
 *
 * The mock signs and verifies for real. A mock whose `verifyWebhook` returns `true`
 * unconditionally makes the demo prove nothing about the code path that matters,
 * and it trains everyone who reads it that signature verification is a formality.
 * It also means the webhook endpoint gets exercised end to end in tests without a
 * single credential, which is the point of the whole mock.
 */

/** Lower-case because Node normalises incoming header names, and so does this file. */
export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

const MockEventSchema = z.object({
  providerMessageId: z.string().min(1),
  type: z.enum(['delivered', 'bounced', 'complained', 'failed', 'opened', 'clicked']),
  occurredAt: z.coerce.date(),
  providerEventId: z.string().min(1),
  errorCode: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A bare array is accepted alongside the enveloped form because the replay tool
 * posts stored `webhook_deliveries.payload` rows straight back, and a payload that
 * was captured from one shape must not become unreplayable when the other is used.
 */
const MockWebhookSchema = z.union([
  z.object({ events: z.array(MockEventSchema) }),
  z.array(MockEventSchema),
]);

/** HMAC-SHA256 over the raw body, hex encoded. */
export function signMockWebhook(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verify a mock callback signature.
 *
 * The comparison is constant-time. A `===` here leaks the position of the first
 * differing byte through timing, which is enough to forge a signature one byte at
 * a time given patience and a loop; `timingSafeEqual` costs nothing and removes
 * the question. It throws on unequal lengths, so the length check has to happen
 * first -- and a length mismatch is itself a rejection, not an error.
 */
export function verifyMockWebhook(
  headers: Record<string, string>,
  rawBody: Buffer,
  secret: string,
): boolean {
  const provided = readHeader(headers, MOCK_SIGNATURE_HEADER);
  if (provided === undefined) return false;

  const expected = Buffer.from(signMockWebhook(rawBody, secret), 'utf8');
  const actual = Buffer.from(provided, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Build a signed request body for a batch of simulated callbacks.
 *
 * The worker job that fires mock webhooks posts exactly this to the real webhook
 * endpoint. Serialising once and signing that same buffer is not incidental: a
 * signature computed over a re-serialised object is a signature over a different
 * byte sequence than the one the endpoint will verify, and the resulting
 * intermittent 403 is a genuinely unpleasant afternoon.
 */
export function buildMockWebhookRequest(
  events: readonly ProviderEvent[],
  secret: string,
): { readonly headers: Record<string, string>; readonly body: Buffer } {
  const body = Buffer.from(JSON.stringify({ events }), 'utf8');
  return {
    headers: {
      'content-type': 'application/json',
      [MOCK_SIGNATURE_HEADER]: signMockWebhook(body, secret),
    },
    body,
  };
}

/**
 * Map a mock payload to provider events.
 *
 * Returns an empty array for anything that does not parse rather than throwing.
 * The webhook endpoint has already persisted the raw payload (I11) by the time
 * this runs, so a malformed batch is recoverable from the database; throwing here
 * would turn it into a 500 that the provider would then redeliver forever.
 */
export function parseMockWebhook(payload: unknown): ProviderEvent[] {
  const parsed = MockWebhookSchema.safeParse(payload);
  if (!parsed.success) return [];

  const events = Array.isArray(parsed.data) ? parsed.data : parsed.data.events;
  return events.map((event) => {
    // Built field by field because `exactOptionalPropertyTypes` distinguishes an
    // absent key from a key holding undefined, and ProviderEvent means the former.
    const mapped: {
      -readonly [K in keyof ProviderEvent]: ProviderEvent[K];
    } = {
      providerMessageId: event.providerMessageId,
      type: event.type,
      occurredAt: event.occurredAt,
      providerEventId: event.providerEventId,
    };
    if (event.errorCode !== undefined) mapped.errorCode = event.errorCode;
    if (event.metadata !== undefined) mapped.metadata = event.metadata;
    return mapped;
  });
}
