import { z } from 'zod';
import type {
  Channel,
  MessageProvider,
  OutboundMessage,
  ProviderEvent,
  ProviderResult,
} from '@campaign/shared';
import { DEFAULT_PROVIDER_TIMEOUT_MS, readJson, transportFailure } from './http.ts';

/**
 * Brevo transactional email over its HTTPS API, with no SDK.
 *
 * WHY THIS EXISTS WHEN `smtp.ts` ALREADY SPEAKS TO BREVO
 *
 * Since September 2025 Render's free web services block outbound traffic on SMTP
 * ports 25, 465 and 587. The SMTP adapter pointed at `smtp-relay.brevo.com:587`
 * from a free instance does not get a rejection it could classify; it gets a
 * connection that never opens, and every storefront email times out. The HTTPS
 * API is the same Brevo account, the same 300/day free allowance and the same
 * sender, over port 443 — which no platform blocks, because it is also how the
 * platform's own web traffic leaves.
 *
 * Same shape as `postmark.ts`: one endpoint's worth of surface does not justify a
 * dependency, and the raw endpoint keeps Brevo's own error `code` as the stored
 * value rather than an SDK exception class name (I8).
 *
 * WHAT IT DOES NOT DO
 *
 * Brevo's transactional API documents no idempotency key. `msg.idempotencyKey` is
 * sent as a custom header so a duplicate can at least be identified afterwards,
 * but Brevo will not collapse one. Delivery through this adapter is therefore
 * at-least-once with no provider-side backstop — the same bound README.md states
 * for I3, without the last line of defence Postmark offers.
 *
 * Webhooks are not wired. Brevo's transactional webhooks are unsigned, and an
 * unauthenticated route that can mark a message delivered or a contact bounced is
 * a route anybody can write suppressions through. Until a verified mechanism is
 * added, `verifyWebhook` refuses everything and the storefront tells visitors not
 * to wait for a delivery receipt from this provider.
 */

export type BrevoConfig = {
  readonly apiKey: string;
  /** The verified sender address. Brevo refuses any `from` it has not verified. */
  readonly fromEmail: string;
  /** Display name shown in the recipient's inbox. */
  readonly fromName?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
};

const DEFAULT_API_BASE_URL = 'https://api.brevo.com/v3';

/**
 * Parse `Name <address>` or a bare address.
 *
 * Operators copy the sender from Brevo's UI in either shape, and splitting it
 * here means BREVO_FROM can be pasted verbatim instead of being two variables
 * that drift.
 */
export function parseSender(raw: string): { email: string; name?: string } {
  const trimmed = raw.trim();
  const match = /^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(trimmed);
  if (match) {
    const name = (match[1] ?? '').trim().replace(/^"|"$/g, '').trim();
    const email = (match[2] ?? '').trim();
    return name.length > 0 ? { email, name } : { email };
  }
  return { email: trimmed };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export function brevoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrevoConfig {
  const apiKey = env['BREVO_API_KEY']?.trim();
  const from = env['BREVO_FROM']?.trim();
  if (!apiKey || !from) {
    throw new Error(
      'Brevo is not configured: BREVO_API_KEY and BREVO_FROM are required. ' +
        'Use the mock email provider if you only want to see the lifecycle.',
    );
  }
  const sender = parseSender(from);
  return {
    apiKey,
    fromEmail: sender.email,
    fromName: nonEmpty(env['BREVO_FROM_NAME']) ?? sender.name,
    apiBaseUrl: env['BREVO_API_BASE_URL'],
  };
}

const BrevoSendResponseSchema = z.object({
  messageId: z.string().optional(),
  messageIds: z.array(z.string()).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

export class BrevoProvider implements MessageProvider {
  readonly name = 'brevo';
  readonly channel: Channel = 'email';

  readonly #config: BrevoConfig;
  readonly #fetch: typeof fetch;

  constructor(config: BrevoConfig, fetchImpl: typeof fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async send(msg: OutboundMessage): Promise<ProviderResult> {
    const base = this.#config.apiBaseUrl ?? DEFAULT_API_BASE_URL;

    // The queue row carries the sender the gate chain resolved. It may be a bare
    // address or `Name <address>`; a display name configured on the deployment
    // fills in when the row has none.
    const resolved = parseSender(msg.from || this.#config.fromEmail);
    const senderName = resolved.name ?? this.#config.fromName;

    let response: Response;
    try {
      response = await this.#fetch(`${base}/smtp/email`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'api-key': this.#config.apiKey,
        },
        body: JSON.stringify({
          sender: {
            email: resolved.email,
            ...(senderName !== undefined && senderName !== '' ? { name: senderName } : {}),
          },
          to: [{ email: msg.to }],
          subject: msg.subject ?? '',
          textContent: msg.body,
          ...(msg.html !== undefined ? { htmlContent: msg.html } : {}),
          // Identification only — see the header comment on idempotency.
          headers: {
            'X-Campaign-Engine-Message-Id': msg.idempotencyKey,
            'X-Campaign-Engine-Tracking-Id': msg.trackingId,
          },
          tags: ['campaign-engine'],
        }),
        signal: AbortSignal.timeout(this.#config.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      return transportFailure(error, 'Brevo');
    }

    const body: unknown = await readJson(response);
    const parsed = BrevoSendResponseSchema.safeParse(body);

    // 201 with a messageId is the only success shape. A 2xx without one is
    // recorded as a failure rather than a send: `sent` with no provider id is a
    // row nobody can ever reconcile against the provider's logs.
    const messageId = parsed.success
      ? (parsed.data.messageId ?? parsed.data.messageIds?.[0])
      : undefined;
    if (response.ok && messageId !== undefined && messageId !== '') {
      return { ok: true, providerMessageId: messageId };
    }

    const bodyCode = parsed.success ? parsed.data.code : undefined;
    return {
      ok: false,
      // Brevo's own code when it sent one (`unauthorized`, `invalid_parameter`,
      // `not_enough_credits`…), the HTTP status when it did not.
      errorCode: bodyCode !== undefined && bodyCode !== '' ? bodyCode : `HTTP_${response.status}`,
      errorMessage:
        (parsed.success ? parsed.data.message : undefined) ?? `Brevo responded ${response.status}.`,
      raw: body,
    };
  }

  /** Refuses everything: Brevo's transactional webhooks are unsigned. See header. */
  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(): ProviderEvent[] {
    return [];
  }
}
