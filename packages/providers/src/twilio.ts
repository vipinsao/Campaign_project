import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Channel, MessageProvider, OutboundMessage, ProviderEvent, ProviderResult } from '@campaign/shared';
import type { Clock } from './deps.ts';
import { DEFAULT_PROVIDER_TIMEOUT_MS, basicAuth, readHeader, readJson, transportFailure } from './http.ts';

/**
 * Twilio SMS over the REST API, with no SDK.
 *
 * The `twilio` package is not a dependency of this project, on purpose. This
 * adapter uses three documented endpoints' worth of surface -- one, in fact -- and
 * a hand-written `fetch` call against the documented endpoint keeps two properties
 * an SDK takes away:
 *
 *  1. The error codes stay Twilio's own. An SDK wraps them in its own exception
 *     hierarchy, and I8 depends on storing the provider's code verbatim rather
 *     than a library's rendering of it, which changes between major versions.
 *  2. The dependency tree stays small enough to read. A messaging SDK pulls in a
 *     request stack, a retry policy and a logging shim, all of which then have
 *     opinions about the things this codebase has already decided (retries,
 *     backoff, classification) and none of which can be turned off cleanly.
 *
 * The cost is that the signature scheme below has to be implemented rather than
 * called. It is twenty lines and it is documented, so that is a fair trade.
 */

export type TwilioConfig = {
  readonly accountSid: string;
  readonly authToken: string;
  readonly from: string;
  /** Overridable so tests and the sandbox can point at a local server. */
  readonly apiBaseUrl?: string | undefined;
  /** Where Twilio should post delivery receipts, if configured. */
  readonly statusCallbackUrl?: string | undefined;
  /**
   * The public URL Twilio was configured to call. Used to verify signatures when
   * the HTTP layer does not supply one per request.
   */
  readonly webhookUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
};

export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature';

/**
 * The header through which the API layer passes the public URL of the request.
 *
 * Twilio signs the URL it dialled, so verification needs that exact string. Behind
 * a load balancer the `Host` header and the path the application sees are both
 * frequently not it -- TLS is terminated upstream, a path prefix is stripped, or
 * the public host is a CNAME. The API layer is the only component that knows the
 * externally visible URL, so it states it explicitly rather than having this file
 * guess from proxy headers that an attacker can also set.
 */
export const TWILIO_REQUEST_URL_HEADER = 'x-webhook-url';

const DEFAULT_API_BASE_URL = 'https://api.twilio.com';

export function twilioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioConfig {
  const accountSid = env['TWILIO_ACCOUNT_SID'];
  const authToken = env['TWILIO_AUTH_TOKEN'];
  const from = env['TWILIO_FROM'];
  if (!accountSid || !authToken || !from) {
    throw new Error(
      'Twilio is not configured: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are all ' +
        'required. Use the mock SMS provider if you only want to see the lifecycle.',
    );
  }
  return {
    accountSid,
    authToken,
    from,
    apiBaseUrl: env['TWILIO_API_BASE_URL'],
    statusCallbackUrl: env['TWILIO_STATUS_CALLBACK_URL'],
    webhookUrl: env['TWILIO_STATUS_CALLBACK_URL'],
  };
}

/**
 * The documented X-Twilio-Signature scheme.
 *
 * Take the full request URL, append every POST parameter as key immediately
 * followed by value in alphabetical order of key, HMAC-SHA1 the result with the
 * account's auth token, and base64 the digest.
 *
 * Only the form-encoded variant is implemented. Twilio's JSON variant signs the
 * URL alone and moves the body into a `bodySHA256` query parameter; we configure
 * form-encoded callbacks, so implementing the other path would be untested code
 * guarding a route that does not exist.
 */
export function twilioSignature(url: string, params: Iterable<readonly [string, string]>, authToken: string): string {
  // Code-point order, not `localeCompare`. Locale collation is case-insensitive at
  // the primary level, so it sorts `Caller` before `CallSid` where a byte-wise sort
  // does the opposite -- and the two orderings produce different signed strings.
  // The failure that causes is total (every callback rejected) and entirely silent
  // until it reaches a real Twilio account.
  const sorted = [...params].sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]));
  let payload = url;
  for (const [key, value] of sorted) payload += key + value;
  return createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest('base64');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const TwilioStatusCallbackSchema = z.object({
  MessageSid: z.string().min(1).optional(),
  SmsSid: z.string().min(1).optional(),
  MessageStatus: z.string().min(1).optional(),
  SmsStatus: z.string().min(1).optional(),
  ErrorCode: z.union([z.string(), z.number()]).optional(),
});

/**
 * Twilio message statuses that mean something to us.
 *
 * `queued`, `accepted`, `scheduled`, `sending` and `sent` are all deliberately
 * absent. They describe progress inside Twilio, and recording any of them as a
 * delivery would break I9: `delivered_at` is written only by a provider receipt,
 * and "Twilio has handed it to a carrier" is not one.
 */
const STATUS_TO_EVENT: Readonly<Record<string, ProviderEvent['type']>> = {
  delivered: 'delivered',
  undelivered: 'bounced',
  failed: 'failed',
  read: 'opened',
};

export class TwilioProvider implements MessageProvider {
  readonly name = 'twilio';
  readonly channel: Channel = 'sms';

  readonly #config: TwilioConfig;
  readonly #clock: Clock;
  readonly #fetch: typeof fetch;

  constructor(config: TwilioConfig, clock: Clock, fetchImpl: typeof fetch = fetch) {
    this.#config = config;
    this.#clock = clock;
    this.#fetch = fetchImpl;
  }

  async send(msg: OutboundMessage): Promise<ProviderResult> {
    const base = this.#config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(this.#config.accountSid)}/Messages.json`;

    const form = new URLSearchParams({
      To: msg.to,
      From: msg.from || this.#config.from,
      Body: msg.body,
    });
    if (this.#config.statusCallbackUrl !== undefined) {
      form.set('StatusCallback', this.#config.statusCallbackUrl);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          authorization: basicAuth(this.#config.accountSid, this.#config.authToken),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.#config.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      return transportFailure(error, 'Twilio');
    }

    const body: unknown = await readJson(response);
    const parsed = TwilioResponseSchema.safeParse(body);

    if (response.ok && parsed.success && parsed.data.sid && (parsed.data.error_code ?? null) === null) {
      return { ok: true, providerMessageId: parsed.data.sid };
    }

    // Twilio's own numeric code is preferred over the HTTP status every time it is
    // present; ERROR_TABLE is keyed on those five-digit codes because they say
    // what happened, where a 400 says only that something did.
    const twilioCode = parsed.success ? (parsed.data.code ?? parsed.data.error_code) : undefined;
    return {
      ok: false,
      errorCode: twilioCode !== undefined && twilioCode !== null ? String(twilioCode) : `HTTP_${response.status}`,
      errorMessage:
        (parsed.success ? (parsed.data.message ?? parsed.data.error_message) : undefined) ??
        `Twilio responded ${response.status}.`,
      raw: body,
    };
  }

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer, secret: string): boolean {
    const provided = readHeader(headers, TWILIO_SIGNATURE_HEADER);
    if (provided === undefined) return false;

    const url = readHeader(headers, TWILIO_REQUEST_URL_HEADER) ?? this.#config.webhookUrl;
    // No URL means the signature cannot be computed at all. Rejecting is the only
    // safe answer: verifying against a guessed URL would either reject every
    // legitimate callback or, worse, accept whatever URL the caller supplied.
    if (url === undefined) return false;

    const params = new URLSearchParams(rawBody.toString('utf8'));
    const expected = Buffer.from(twilioSignature(url, params, secret), 'utf8');
    const actual = Buffer.from(provided, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  parseWebhook(payload: unknown): ProviderEvent[] {
    const parsed = TwilioStatusCallbackSchema.safeParse(payload);
    if (!parsed.success) return [];

    const sid = parsed.data.MessageSid ?? parsed.data.SmsSid;
    const status = (parsed.data.MessageStatus ?? parsed.data.SmsStatus)?.toLowerCase();
    if (sid === undefined || status === undefined) return [];

    const type = STATUS_TO_EVENT[status];
    if (type === undefined) return [];

    // Twilio status callbacks carry no timestamp, so the receipt time is recorded
    // instead. That is the reason this adapter takes a Clock: stamping a simulated
    // run with real wall-clock time would put webhook events days away from the
    // sends that produced them.
    const event: { -readonly [K in keyof ProviderEvent]: ProviderEvent[K] } = {
      providerMessageId: sid,
      type,
      occurredAt: this.#clock.now(),
      // Twilio does not issue event ids. The message sid paired with the status is
      // stable across a redelivery of the same callback, which is exactly what the
      // idempotency key has to be: the endpoint deduplicates on it, so a repeated
      // callback is free rather than a second bounce.
      providerEventId: `${sid}:${status}`,
    };
    if (parsed.data.ErrorCode !== undefined) event.errorCode = String(parsed.data.ErrorCode);
    return [event];
  }
}

const TwilioResponseSchema = z.object({
  sid: z.string().optional(),
  status: z.string().optional(),
  error_code: z.union([z.string(), z.number()]).nullish(),
  error_message: z.string().nullish(),
  code: z.union([z.string(), z.number()]).nullish(),
  message: z.string().nullish(),
});
