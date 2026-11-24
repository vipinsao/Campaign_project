import { describe, it, expect } from 'vitest';
import type { OutboundMessage } from '@campaign/shared';
import {
  BrevoProvider,
  PROVIDER_NAMES,
  brevoConfigFromEnv,
  classify,
  parseSender,
  senderFromEnv,
} from '@campaign/providers';

/**
 * Brevo over HTTPS, because Render's free tier blocks outbound SMTP.
 *
 * No network: every case hands the adapter a fetch stub, so what is being proved
 * is the request it builds and how it reads each shape of answer — which is where
 * an adapter goes wrong, rather than in Brevo.
 */

const MESSAGE: OutboundMessage = {
  id: 'q-1',
  tenantId: 't-1',
  channel: 'email',
  to: 'visitor@example.com',
  from: 'Campaign Engine <sender@example.com>',
  subject: 'Your order CE-ABC123 is confirmed',
  body: 'Hi Ada',
  html: '<p>Hi Ada</p>',
  trackingId: 'trk-1',
  idempotencyKey: 'q-1',
};

type Captured = { url: string; init: RequestInit };

function stub(status: number, body: unknown): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(body === undefined ? '' : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const provider = (f: typeof fetch) =>
  new BrevoProvider({ apiKey: 'xkeysib-test', fromEmail: 'fallback@example.com' }, f);

describe('BrevoProvider.send', () => {
  it('posts one transactional email with the api-key header and both bodies', async () => {
    const { fetch, calls } = stub(201, { messageId: '<abc@smtp-relay.mailin.fr>' });
    const result = await provider(fetch).send(MESSAGE);

    expect(result).toEqual({ ok: true, providerMessageId: '<abc@smtp-relay.mailin.fr>' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.brevo.com/v3/smtp/email');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['api-key']).toBe('xkeysib-test');
    const sent = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      sender: { email: 'sender@example.com', name: 'Campaign Engine' },
      to: [{ email: 'visitor@example.com' }],
      subject: 'Your order CE-ABC123 is confirmed',
      textContent: 'Hi Ada',
      htmlContent: '<p>Hi Ada</p>',
    });
    expect((sent['headers'] as Record<string, string>)['X-Campaign-Engine-Message-Id']).toBe('q-1');
  });

  it("stores Brevo's own error code, so the table can classify it (I8)", async () => {
    const { fetch } = stub(401, { code: 'unauthorized', message: 'Key not found' });
    const result = await provider(fetch).send(MESSAGE);
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'unauthorized',
      errorMessage: 'Key not found',
    });
    expect(classify('brevo', 'unauthorized').unmapped).toBe(false);
  });

  it('falls back to the HTTP status when there is no body to read', async () => {
    const { fetch } = stub(503, undefined);
    const result = await provider(fetch).send(MESSAGE);
    expect(result).toMatchObject({ ok: false, errorCode: 'HTTP_503' });
    expect(classify('brevo', 'HTTP_503').class).toBe('transient');
  });

  it('records a 2xx without a message id as a failure, never as a send', async () => {
    const { fetch } = stub(201, {});
    const result = await provider(fetch).send(MESSAGE);
    expect(result.ok).toBe(false);
  });

  it('maps a thrown fetch onto a transient transport code', async () => {
    const failing = (() =>
      Promise.reject(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      )) as unknown as typeof fetch;
    const result = await provider(failing).send(MESSAGE);
    expect(result).toMatchObject({ ok: false, errorCode: 'ECONNRESET' });
    expect(classify('brevo', 'ECONNRESET').class).toBe('transient');
  });

  it('treats an invalid recipient as terminal: never retried (I8)', () => {
    expect(classify('brevo', 'invalid_parameter').class).toBe('terminal');
  });

  it('refuses every webhook, because Brevo does not sign them', () => {
    expect(provider(stub(200, {}).fetch).verifyWebhook()).toBe(false);
  });
});

describe('configuration', () => {
  it('parses both shapes an operator pastes as the sender', () => {
    expect(parseSender('Campaign Engine <a@b.co>')).toEqual({
      email: 'a@b.co',
      name: 'Campaign Engine',
    });
    expect(parseSender('"Quoted Name" <a@b.co>')).toEqual({ email: 'a@b.co', name: 'Quoted Name' });
    expect(parseSender('  a@b.co ')).toEqual({ email: 'a@b.co' });
  });

  it('needs both the key and the sender', () => {
    expect(() => brevoConfigFromEnv({ BREVO_API_KEY: 'k' })).toThrow(/BREVO_FROM/);
    expect(brevoConfigFromEnv({ BREVO_API_KEY: 'k', BREVO_FROM: 'Shop <s@x.io>' })).toMatchObject({
      apiKey: 'k',
      fromEmail: 's@x.io',
      fromName: 'Shop',
    });
  });

  it('wins over a leftover SMTP host, which cannot connect where Brevo is needed', () => {
    const env = {
      SMTP_HOST: 'smtp-relay.brevo.com',
      SMTP_FROM: 'old@example.com',
      BREVO_API_KEY: 'k',
      BREVO_FROM: 'new@example.com',
    };
    expect(senderFromEnv('email', env)).toEqual({
      provider: 'brevo',
      fromAddress: 'new@example.com',
    });
    expect(PROVIDER_NAMES).toContain('brevo');
  });
});
