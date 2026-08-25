import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  Channel,
  MessageProvider,
  OutboundMessage,
  ProviderEvent,
  ProviderResult,
} from '@campaign/shared';
import type { Clock } from './deps.ts';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  basicAuth,
  readHeader,
  readJson,
  transportFailure,
} from './http.ts';

/**
 * Postmark transactional email over the REST API, with no SDK.
 *
 * Same reasoning as `twilio.ts`: one endpoint's worth of surface does not justify
 * a dependency that would then re-implement retry and error handling this project
 * has already decided how to do, and the raw endpoint keeps `ErrorCode` as
 * Postmark's own value rather than an SDK exception class name.
 */

export type PostmarkConfig = {
  readonly serverToken: string;
  readonly from: string;
  /**
   * Postmark separates transactional and broadcast streams, and getting this wrong
   * is not cosmetic: sending campaign mail down the transactional stream damages
   * the reputation of the stream that carries password resets. The caller has to
   * state which one it means.
   */
  readonly messageStream: string;
  readonly apiBaseUrl?: string | undefined;
  /**
   * Postmark does not sign its webhooks. It authenticates them with HTTP Basic
   * credentials embedded in the callback URL you register, so this is the
   * `user:pass` pair we expect back. See `verifyWebhook`.
   */
  readonly webhookBasicAuth?: string | undefined;
  readonly timeoutMs?: number | undefined;
};

const DEFAULT_API_BASE_URL = 'https://api.postmarkapp.com';

export function postmarkConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PostmarkConfig {
  const serverToken = env['POSTMARK_SERVER_TOKEN'];
  const from = env['POSTMARK_FROM'];
  if (!serverToken || !from) {
    throw new Error(
      'Postmark is not configured: POSTMARK_SERVER_TOKEN and POSTMARK_FROM are required. ' +
        'Use the mock email provider if you only want to see the lifecycle.',
    );
  }
  return {
    serverToken,
    from,
    messageStream: env['POSTMARK_MESSAGE_STREAM'] ?? 'broadcast',
    apiBaseUrl: env['POSTMARK_API_BASE_URL'],
    webhookBasicAuth: env['POSTMARK_WEBHOOK_BASIC_AUTH'],
  };
}

const PostmarkSendResponseSchema = z.object({
  MessageID: z.string().optional(),
  ErrorCode: z.number().optional(),
  Message: z.string().optional(),
});

const PostmarkWebhookSchema = z.object({
  RecordType: z.string(),
  MessageID: z.string().optional(),
  ID: z.union([z.string(), z.number()]).optional(),
  Type: z.string().optional(),
  Description: z.string().optional(),
  BouncedAt: z.string().optional(),
  DeliveredAt: z.string().optional(),
  ReceivedAt: z.string().optional(),
  Metadata: z.record(z.string(), z.unknown()).optional(),
});

const RECORD_TO_EVENT: Readonly<Record<string, ProviderEvent['type']>> = {
  Delivery: 'delivered',
  Bounce: 'bounced',
  SpamComplaint: 'complained',
  Open: 'opened',
  Click: 'clicked',
};

export class PostmarkProvider implements MessageProvider {
  readonly name = 'postmark';
  readonly channel: Channel = 'email';

  readonly #config: PostmarkConfig;
  readonly #clock: Clock;
  readonly #fetch: typeof fetch;

  constructor(config: PostmarkConfig, clock: Clock, fetchImpl: typeof fetch = fetch) {
    this.#config = config;
    this.#clock = clock;
    this.#fetch = fetchImpl;
  }

  async send(msg: OutboundMessage): Promise<ProviderResult> {
    const base = this.#config.apiBaseUrl ?? DEFAULT_API_BASE_URL;

    let response: Response;
    try {
      response = await this.#fetch(`${base}/email`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-postmark-server-token': this.#config.serverToken,
        },
        body: JSON.stringify({
          From: msg.from || this.#config.from,
          To: msg.to,
          Subject: msg.subject ?? '',
          TextBody: msg.body,
          ...(msg.html !== undefined ? { HtmlBody: msg.html } : {}),
          MessageStream: this.#config.messageStream,
          // Postmark echoes Metadata back on every webhook for the message, which
          // is what lets a bounce arriving hours later be tied to the queue row
          // without a lookup table of our own.
          Metadata: { trackingId: msg.trackingId, messageQueueId: msg.id },
        }),
        signal: AbortSignal.timeout(this.#config.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      return transportFailure(error, 'Postmark');
    }

    const body: unknown = await readJson(response);
    const parsed = PostmarkSendResponseSchema.safeParse(body);

    // Postmark answers 200 with `ErrorCode: 0` on success and puts the real verdict
    // in the body. Trusting the HTTP status alone would record an inactive-recipient
    // rejection as a successful send.
    if (
      response.ok &&
      parsed.success &&
      parsed.data.MessageID &&
      (parsed.data.ErrorCode ?? 0) === 0
    ) {
      return { ok: true, providerMessageId: parsed.data.MessageID };
    }

    const bodyCode = parsed.success ? parsed.data.ErrorCode : undefined;
    return {
      ok: false,
      errorCode:
        bodyCode !== undefined && bodyCode !== 0 ? String(bodyCode) : `HTTP_${response.status}`,
      errorMessage:
        (parsed.success ? parsed.data.Message : undefined) ??
        `Postmark responded ${response.status}.`,
      raw: body,
    };
  }

  /**
   * Postmark webhooks are authenticated, not signed.
   *
   * There is no HMAC to verify: the documented mechanism is HTTP Basic credentials
   * embedded in the callback URL registered with Postmark, so the check is that
   * the Authorization header matches what we registered. The comparison is still
   * constant-time, because a shared secret compared with `===` is a shared secret
   * that leaks one byte at a time regardless of how it was transported.
   *
   * When no credentials are configured this returns false rather than true. An
   * unauthenticated webhook endpoint accepting anything that claims to be Postmark
   * would let anyone mark any message delivered, or any contact bounced -- and the
   * bounce path writes suppressions.
   */
  verifyWebhook(headers: Record<string, string>, _rawBody: Buffer, secret: string): boolean {
    const configured = secret || this.#config.webhookBasicAuth;
    if (!configured) return false;

    const provided = readHeader(headers, 'authorization');
    if (provided === undefined) return false;

    // The secret may be given either as `user:pass` or as a complete header value,
    // because operators copy it from both places.
    const expectedHeader = configured.startsWith('Basic ')
      ? configured
      : basicAuth(...splitBasic(configured));

    const expected = Buffer.from(expectedHeader, 'utf8');
    const actual = Buffer.from(provided, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  parseWebhook(payload: unknown): ProviderEvent[] {
    const parsed = PostmarkWebhookSchema.safeParse(payload);
    if (!parsed.success) return [];

    const type = RECORD_TO_EVENT[parsed.data.RecordType];
    if (type === undefined) return [];

    const messageId = parsed.data.MessageID;
    if (messageId === undefined) return [];

    const stamp = parsed.data.DeliveredAt ?? parsed.data.BouncedAt ?? parsed.data.ReceivedAt;
    const occurredAt = stamp === undefined ? this.#clock.now() : new Date(stamp);

    const event: { -readonly [K in keyof ProviderEvent]: ProviderEvent[K] } = {
      providerMessageId: messageId,
      type,
      // Bounce and complaint payloads carry Postmark's own record `ID`; opens and
      // clicks do not, so those fall back to message plus record type. Both forms
      // are stable across a redelivery, which is the only property the idempotency
      // key needs.
      occurredAt: Number.isNaN(occurredAt.getTime()) ? this.#clock.now() : occurredAt,
      providerEventId:
        parsed.data.ID !== undefined
          ? `postmark:${String(parsed.data.ID)}`
          : `${messageId}:${parsed.data.RecordType}`,
    };
    if (parsed.data.Type !== undefined) event.errorCode = parsed.data.Type;
    if (parsed.data.Metadata !== undefined) event.metadata = parsed.data.Metadata;
    return [event];
  }
}

function splitBasic(credentials: string): [string, string] {
  const separator = credentials.indexOf(':');
  if (separator < 0) return [credentials, ''];
  return [credentials.slice(0, separator), credentials.slice(separator + 1)];
}
