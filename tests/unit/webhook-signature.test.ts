import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { FakeClock } from '@campaign/core';
import type { ProviderEvent } from '@campaign/shared';
import {
  MOCK_SIGNATURE_HEADER,
  TWILIO_REQUEST_URL_HEADER,
  TWILIO_SIGNATURE_HEADER,
  TwilioProvider,
  buildMockWebhookRequest,
  parseMockWebhook,
  signMockWebhook,
  twilioSignature,
  verifyMockWebhook,
} from '@campaign/providers';

/**
 * Signature verification is the one place in this system where a passing test that
 * only checks the happy path is actively harmful: a verifier that returns `true`
 * unconditionally passes every accept-a-valid-signature test ever written. Every
 * case below therefore has its rejection twin.
 */

const MOCK_SECRET = 'mock-webhook-secret';

describe('mock webhook signatures', () => {
  const events: ProviderEvent[] = [
    {
      providerMessageId: 'mock-abcd1234',
      type: 'delivered',
      occurredAt: new Date('2026-03-01T09:00:02.000Z'),
      providerEventId: 'mock-abcd1234:delivered',
    },
  ];

  it('accepts a body signed with the shared secret', () => {
    const { headers, body } = buildMockWebhookRequest(events, MOCK_SECRET);
    expect(verifyMockWebhook(headers, body, MOCK_SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const { headers, body } = buildMockWebhookRequest(events, MOCK_SECRET);
    const tampered = Buffer.from(body.toString('utf8').replace('delivered', 'bounced'), 'utf8');
    expect(verifyMockWebhook(headers, tampered, MOCK_SECRET)).toBe(false);
  });

  it('rejects a body of the same length with one byte changed', () => {
    // Equal lengths take the comparison past the length guard and into
    // timingSafeEqual, which is the branch that actually has to be correct.
    const { headers, body } = buildMockWebhookRequest(events, MOCK_SECRET);
    const tampered = Buffer.from(body);
    tampered[10] = tampered[10]! ^ 0x01;
    expect(tampered.length).toBe(body.length);
    expect(verifyMockWebhook(headers, tampered, MOCK_SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const { body } = buildMockWebhookRequest(events, MOCK_SECRET);
    const headers = { [MOCK_SIGNATURE_HEADER]: signMockWebhook(body, 'not-the-secret') };
    expect(verifyMockWebhook(headers, body, MOCK_SECRET)).toBe(false);
  });

  it('rejects a request with no signature at all', () => {
    const { body } = buildMockWebhookRequest(events, MOCK_SECRET);
    expect(verifyMockWebhook({}, body, MOCK_SECRET)).toBe(false);
    expect(verifyMockWebhook({ [MOCK_SIGNATURE_HEADER]: '' }, body, MOCK_SECRET)).toBe(false);
  });

  it('reads the signature header whatever case it arrives in', () => {
    const { body } = buildMockWebhookRequest(events, MOCK_SECRET);
    const headers = { 'X-Mock-Signature': signMockWebhook(body, MOCK_SECRET) };
    expect(verifyMockWebhook(headers, body, MOCK_SECRET)).toBe(true);
  });

  it('round-trips the events it signed', () => {
    const { body } = buildMockWebhookRequest(events, MOCK_SECRET);
    const parsed = parseMockWebhook(JSON.parse(body.toString('utf8')));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.providerEventId).toBe('mock-abcd1234:delivered');
    expect(parsed[0]?.occurredAt.toISOString()).toBe('2026-03-01T09:00:02.000Z');
  });

  it('returns no events for a payload it cannot parse', () => {
    // The raw payload is already persisted by then (I11), so a malformed batch is
    // recoverable from the database. Throwing would become a 500 and an infinite
    // redelivery loop.
    expect(parseMockWebhook({ events: [{ type: 'nonsense' }] })).toEqual([]);
    expect(parseMockWebhook('not json at all')).toEqual([]);
    expect(parseMockWebhook(null)).toEqual([]);
  });
});

describe('Twilio webhook signatures', () => {
  const AUTH_TOKEN = '12345';
  const URL = 'https://api.example.com/webhooks/twilio?foo=1&bar=2';
  const PARAMS: readonly (readonly [string, string])[] = [
    ['CallSid', 'CA1234567890ABCDE'],
    ['Caller', '+12025550111'],
    ['Digits', '1234'],
    ['From', '+12025550111'],
    ['To', '+12025550122'],
  ];

  function provider(): TwilioProvider {
    return new TwilioProvider(
      { accountSid: 'AC0', authToken: AUTH_TOKEN, from: '+12025550100' },
      new FakeClock('2026-03-01T09:00:00Z'),
    );
  }

  function formBody(params: readonly (readonly [string, string])[]): Buffer {
    const form = new URLSearchParams();
    for (const [key, value] of params) form.set(key, value);
    return Buffer.from(form.toString(), 'utf8');
  }

  it('signs exactly the string the documented scheme describes', () => {
    // A self-consistent implementation would pass a round-trip test while still
    // disagreeing with Twilio about WHAT gets signed, and that disagreement is
    // invisible until every real callback is rejected in production. So the
    // canonical string is spelled out here literally -- the full URL including its
    // query, then each parameter as key immediately followed by value in
    // alphabetical order of key, with no separators and no encoding -- and the
    // digest is derived from it rather than from the implementation.
    const canonical =
      'https://api.example.com/webhooks/twilio?foo=1&bar=2' +
      'CallSidCA1234567890ABCDE' +
      'Caller+12025550111' +
      'Digits1234' +
      'From+12025550111' +
      'To+12025550122';
    const expected = createHmac('sha1', AUTH_TOKEN).update(canonical, 'utf8').digest('base64');
    expect(twilioSignature(URL, PARAMS, AUTH_TOKEN)).toBe(expected);
  });

  it('signs the query string as part of the URL', () => {
    // Twilio signs the URL it dialled, query included. Dropping the query is the
    // classic implementation slip, and it rejects every callback to a URL that
    // carries one.
    expect(twilioSignature(URL, PARAMS, AUTH_TOKEN)).not.toBe(
      twilioSignature('https://mycompany.com/myapp.php', PARAMS, AUTH_TOKEN),
    );
  });

  it('sorts parameters by key rather than trusting the order they arrived in', () => {
    const shuffled = [...PARAMS].reverse();
    expect(twilioSignature(URL, shuffled, AUTH_TOKEN)).toBe(
      twilioSignature(URL, PARAMS, AUTH_TOKEN),
    );
  });

  it('accepts a correctly signed callback', () => {
    const body = formBody(PARAMS);
    const params = [...new URLSearchParams(body.toString('utf8'))];
    const headers = {
      [TWILIO_SIGNATURE_HEADER]: twilioSignature(URL, params, AUTH_TOKEN),
      [TWILIO_REQUEST_URL_HEADER]: URL,
    };
    expect(provider().verifyWebhook(headers, body, AUTH_TOKEN)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = formBody(PARAMS);
    const params = [...new URLSearchParams(body.toString('utf8'))];
    const headers = {
      [TWILIO_SIGNATURE_HEADER]: twilioSignature(URL, params, AUTH_TOKEN),
      [TWILIO_REQUEST_URL_HEADER]: URL,
    };
    const tampered = formBody([...PARAMS.filter(([k]) => k !== 'To'), ['To', '+18005559999']]);
    expect(provider().verifyWebhook(headers, tampered, AUTH_TOKEN)).toBe(false);
  });

  it('rejects a signature computed for a different URL', () => {
    // The URL is part of the signed string, which is what stops a signature
    // captured from one endpoint being replayed against another.
    const body = formBody(PARAMS);
    const params = [...new URLSearchParams(body.toString('utf8'))];
    const headers = {
      [TWILIO_SIGNATURE_HEADER]: twilioSignature(
        'https://elsewhere.example/hook',
        params,
        AUTH_TOKEN,
      ),
      [TWILIO_REQUEST_URL_HEADER]: URL,
    };
    expect(provider().verifyWebhook(headers, body, AUTH_TOKEN)).toBe(false);
  });

  it('rejects a callback when no request URL is available', () => {
    const body = formBody(PARAMS);
    const params = [...new URLSearchParams(body.toString('utf8'))];
    const headers = { [TWILIO_SIGNATURE_HEADER]: twilioSignature(URL, params, AUTH_TOKEN) };
    expect(provider().verifyWebhook(headers, body, AUTH_TOKEN)).toBe(false);
  });

  it('rejects a callback with no signature header', () => {
    const body = formBody(PARAMS);
    expect(provider().verifyWebhook({ [TWILIO_REQUEST_URL_HEADER]: URL }, body, AUTH_TOKEN)).toBe(
      false,
    );
  });

  it('maps a delivery receipt but not an in-flight status', () => {
    const p = provider();
    const delivered = p.parseWebhook({ MessageSid: 'SM123', MessageStatus: 'delivered' });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.type).toBe('delivered');
    expect(delivered[0]?.providerEventId).toBe('SM123:delivered');

    // I9: delivered_at is written only by a delivery receipt, and "Twilio handed
    // it to a carrier" is not one.
    expect(p.parseWebhook({ MessageSid: 'SM123', MessageStatus: 'sent' })).toEqual([]);
    expect(p.parseWebhook({ MessageSid: 'SM123', MessageStatus: 'queued' })).toEqual([]);

    const undelivered = p.parseWebhook({
      MessageSid: 'SM456',
      MessageStatus: 'undelivered',
      ErrorCode: 30003,
    });
    expect(undelivered[0]?.type).toBe('bounced');
    expect(undelivered[0]?.errorCode).toBe('30003');
  });
});
