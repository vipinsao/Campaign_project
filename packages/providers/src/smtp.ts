import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type {
  Channel,
  MessageProvider,
  OutboundMessage,
  ProviderEvent,
  ProviderResult,
} from '@campaign/shared';

/**
 * SMTP delivery through nodemailer.
 *
 * This adapter exists so the project can send real mail, and it is deliberately
 * not required for anything else. Nothing in the demo path constructs it, nothing
 * in the domain imports it, and no test needs a mail server: `resolveProvider`
 * only reaches this file when a tenant is genuinely configured for SMTP. That is
 * the whole value of the provider boundary -- the credentialled code exists, is
 * readable, and is off the critical path.
 */

export type SmtpConfig = {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string | undefined;
  readonly pass?: string | undefined;
  readonly from: string;
};

/**
 * Read SMTP settings from the environment, failing loudly on anything missing.
 *
 * There is no localhost default here for the same reason `getPool` has no default
 * connection string: a fallback turns a misconfigured deployment into a silent
 * one, and silence about where mail went is the worst possible failure mode for
 * this particular subsystem.
 */
export function smtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig {
  const host = env['SMTP_HOST'];
  const from = env['SMTP_FROM'];
  const missing = [host ? undefined : 'SMTP_HOST', from ? undefined : 'SMTP_FROM'].filter(
    (name): name is string => name !== undefined,
  );
  if (!host || !from) {
    throw new Error(
      `SMTP is not configured: ${missing.join(', ')} missing. ` +
        `Set them, or use the mock provider, which needs no credentials.`,
    );
  }

  const port = Number(env['SMTP_PORT'] ?? 587);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`SMTP_PORT must be a positive integer; got '${env['SMTP_PORT'] ?? ''}'.`);
  }

  // Implicit TLS is port 465; everything else negotiates STARTTLS. Deriving the
  // default from the port rather than defaulting to `false` avoids the
  // configuration where someone sets 465 and quietly speaks plaintext to it.
  const secure = env['SMTP_SECURE'] === undefined ? port === 465 : env['SMTP_SECURE'] === 'true';

  return {
    host,
    port,
    secure,
    user: env['SMTP_USER'],
    pass: env['SMTP_PASS'],
    from,
  };
}

/**
 * The one field of nodemailer's send result this adapter uses.
 *
 * Naming it, rather than accepting the library's default `any`, keeps the message
 * id from flowing untyped into `message_queue.provider_message_id` -- the column
 * every later delivery receipt is joined on.
 */
type SentInfo = { readonly messageId: string };

/** The shape nodemailer errors actually arrive in, none of which is guaranteed. */
type SmtpErrorLike = {
  readonly responseCode?: unknown;
  readonly code?: unknown;
  readonly command?: unknown;
  readonly response?: unknown;
  readonly message?: unknown;
};

export class SmtpProvider implements MessageProvider {
  readonly name = 'smtp';
  readonly channel: Channel = 'email';

  readonly #config: SmtpConfig;
  #transporter: Transporter<SentInfo> | undefined;

  constructor(config: SmtpConfig) {
    this.#config = config;
  }

  /**
   * The transporter is created on first use, not in the constructor.
   *
   * `resolveProvider` may build an adapter for a tenant whose queue turns out to
   * be empty, and opening a connection pool to a mail server for a tenant we are
   * not going to send for is both wasteful and a source of confusing connection
   * errors at startup rather than at send time, where they belong.
   */
  #transport(): Transporter<SentInfo> {
    if (this.#transporter === undefined) {
      // Annotated rather than inferred. `createTransport` is typed to return
      // nodemailer's full result object, and letting that flow onwards puts an
      // `any`-typed message id into provider_message_id, which is the column every
      // later delivery receipt is joined on.
      const transporter: Transporter<SentInfo> = nodemailer.createTransport({
        host: this.#config.host,
        port: this.#config.port,
        secure: this.#config.secure,
        ...(this.#config.user !== undefined && this.#config.pass !== undefined
          ? { auth: { user: this.#config.user, pass: this.#config.pass } }
          : {}),
      });
      this.#transporter = transporter;
    }
    return this.#transporter;
  }

  async send(msg: OutboundMessage): Promise<ProviderResult> {
    try {
      const info = await this.#transport().sendMail({
        from: msg.from || this.#config.from,
        to: msg.to,
        subject: msg.subject ?? '',
        text: msg.body,
        ...(msg.html !== undefined ? { html: msg.html } : {}),
        // Carried so a bounce arriving days later through a mailbox poller can be
        // tied back to the queue row that produced it. Message-ID alone is not
        // enough because some receivers rewrite it.
        headers: { 'X-Campaign-Tracking-Id': msg.trackingId },
      });
      return { ok: true, providerMessageId: info.messageId };
    } catch (error) {
      const smtpError = (error ?? {}) as SmtpErrorLike;
      // The SMTP reply code is preferred over nodemailer's string code because it
      // is the receiving server's own verdict, and I8 wants the provider's truth
      // rather than the client library's summary of it. The string code is the
      // fallback for failures that never reached a server at all.
      const replyCode =
        typeof smtpError.responseCode === 'number' ? String(smtpError.responseCode) : undefined;
      const libraryCode = typeof smtpError.code === 'string' ? smtpError.code : undefined;
      return {
        ok: false,
        errorCode: replyCode ?? libraryCode ?? 'UNKNOWN',
        errorMessage:
          typeof smtpError.response === 'string'
            ? smtpError.response
            : typeof smtpError.message === 'string'
              ? smtpError.message
              : 'SMTP send failed with no diagnostic.',
        raw: {
          responseCode: smtpError.responseCode ?? null,
          code: smtpError.code ?? null,
          command: smtpError.command ?? null,
          response: smtpError.response ?? null,
        },
      };
    }
  }

  /**
   * SMTP has no callback channel.
   *
   * Bounces come back as messages to the envelope sender, which is a mailbox
   * poller's job and not a webhook's. Returning `false` unconditionally is the
   * honest answer: anything claiming to be an SMTP webhook did not come from SMTP,
   * and a `return true` here would be a signature check that accepts everything.
   */
  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(): ProviderEvent[] {
    return [];
  }
}
