import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { FakeClock } from '@campaign/core';
import type { OutboundMessage } from '@campaign/shared';
import { MockEmailProvider, MockSmsProvider, drawOutcome } from '@campaign/providers';
import { testDb, closeTestDb, resetDb } from '../support/db.ts';

afterAll(closeTestDb);

/**
 * mulberry32: a small, fast, well-distributed PRNG with an explicit seed.
 *
 * Determinism here is not a nicety. A distribution assertion against
 * `Math.random` is a test that fails on some fraction of CI runs and is then
 * quietly given a wider tolerance until it asserts nothing at all.
 */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function createTenant(name: string): Promise<string> {
  // mock_outbox.tenant_id is a foreign key, so the tenant has to exist first.
  const { rows } = await testDb().query<{ id: string }>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [name],
  );
  return rows[0]!.id;
}

function emailMessage(tenantId: string, n: number): OutboundMessage {
  return {
    id: `synthetic-${n}`,
    tenantId,
    channel: 'email',
    to: `contact-${n}@example.com`,
    from: 'hello@shop.example',
    subject: 'Your order is on its way',
    body: 'Plain text body.',
    html: '<p>Plain text body.</p>',
    trackingId: `track-${n}`,
  };
}

beforeEach(resetDb);

describe('the mock providers', () => {
  it('writes a row to mock_outbox for every send', async () => {
    const tenantId = await createTenant('outbox tenant');
    const clock = new FakeClock('2026-03-01T09:00:00Z');
    const provider = new MockEmailProvider({
      db: testDb(),
      clock,
      failureRate: 0,
      bounceRate: 0,
      complaintRate: 0,
      rng: seededRng(7),
    });

    const result = await provider.send(emailMessage(tenantId, 1));
    expect(result.ok).toBe(true);

    const { rows } = await testDb().query<{
      channel: string;
      to_address: string;
      from_address: string;
      subject: string | null;
      body: string;
      html: string | null;
      provider_message_id: string;
      simulated_outcome: string;
      message_queue_id: string | null;
      sent_at: Date;
    }>('SELECT * FROM mock_outbox');

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.channel).toBe('email');
    expect(row.to_address).toBe('contact-1@example.com');
    expect(row.from_address).toBe('hello@shop.example');
    expect(row.subject).toBe('Your order is on its way');
    expect(row.body).toBe('Plain text body.');
    expect(row.html).toBe('<p>Plain text body.</p>');
    expect(row.simulated_outcome).toBe('delivered');
    expect(result.ok && row.provider_message_id).toBe(result.ok ? result.providerMessageId : '');
    // The send time comes from the injected clock, which is what lets the
    // simulation fast-forward and still produce a coherent outbox.
    expect(row.sent_at.toISOString()).toBe('2026-03-01T09:00:00.000Z');
    // No queue row exists behind a synthetic id, and the guard resolves it to NULL
    // rather than violating the foreign key.
    expect(row.message_queue_id).toBeNull();
  });

  it('records SMS sends with no subject and no html', async () => {
    const tenantId = await createTenant('sms tenant');
    const provider = new MockSmsProvider({
      db: testDb(),
      clock: new FakeClock('2026-03-01T09:00:00Z'),
      failureRate: 0,
      bounceRate: 0,
      complaintRate: 0,
      rng: seededRng(11),
    });

    await provider.send({
      id: 'synthetic-sms',
      tenantId,
      channel: 'sms',
      to: '+15551234567',
      from: '+15557654321',
      body: 'Your order shipped.',
      trackingId: 'track-sms',
    });

    const { rows } = await testDb().query<{ subject: string | null; html: string | null; channel: string }>(
      'SELECT subject, html, channel FROM mock_outbox',
    );
    expect(rows[0]).toEqual({ subject: null, html: null, channel: 'sms' });
  });

  it('refuses a message for the wrong channel', async () => {
    const tenantId = await createTenant('mismatch tenant');
    const provider = new MockSmsProvider({
      db: testDb(),
      clock: new FakeClock('2026-03-01T09:00:00Z'),
      rng: seededRng(1),
    });
    await expect(provider.send(emailMessage(tenantId, 99))).rejects.toThrow(/was handed a email/);
  });

  it('rejects rates that leave no room for a delivery', () => {
    expect(
      () =>
        new MockEmailProvider({
          db: testDb(),
          clock: new FakeClock('2026-03-01T09:00:00Z'),
          failureRate: 0.5,
          bounceRate: 0.4,
          complaintRate: 0.3,
        }),
    ).toThrow(/exceeds 1/);
  });

  describe('simulated outcomes', () => {
    it('partitions one uniform draw across the configured rates', () => {
      // Asserted on the pure function first, at a sample size a database test
      // could not afford, so the distribution claim is tight rather than merely
      // plausible.
      const rates = { failureRate: 0.1, bounceRate: 0.2, complaintRate: 0.05 };
      const rng = seededRng(2026);
      const counts = { delivered: 0, bounced: 0, complained: 0, failed: 0 };
      const n = 40_000;
      for (let i = 0; i < n; i++) counts[drawOutcome(rng(), rates)] += 1;

      expect(counts.failed / n).toBeCloseTo(0.1, 2);
      expect(counts.bounced / n).toBeCloseTo(0.2, 2);
      expect(counts.complained / n).toBeCloseTo(0.05, 2);
      expect(counts.delivered / n).toBeCloseTo(0.65, 2);
    });

    it('assigns outbox outcomes at roughly the configured rates', async () => {
      const tenantId = await createTenant('distribution tenant');
      const provider = new MockEmailProvider({
        db: testDb(),
        clock: new FakeClock('2026-03-01T09:00:00Z'),
        failureRate: 0.1,
        bounceRate: 0.2,
        complaintRate: 0.05,
        rng: seededRng(4242),
      });

      const n = 400;
      for (let i = 0; i < n; i++) await provider.send(emailMessage(tenantId, i));

      const { rows } = await testDb().query<{ simulated_outcome: string; count: string }>(
        'SELECT simulated_outcome, count(*)::text AS count FROM mock_outbox GROUP BY simulated_outcome',
      );
      const counts = new Map(rows.map((r) => [r.simulated_outcome, Number(r.count)]));
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      expect(total).toBe(n);

      // Every outcome has to actually occur, because the point of the mock is that
      // the demo exercises the bounce and complaint paths rather than describing
      // them. A tolerance of six points is comfortably inside the sampling error
      // of four hundred draws while still failing if a rate is ignored.
      for (const [outcome, expected] of [
        ['failed', 0.1],
        ['bounced', 0.2],
        ['complained', 0.05],
        ['delivered', 0.65],
      ] as const) {
        const observed = (counts.get(outcome) ?? 0) / n;
        expect(observed, `${outcome} observed ${observed}`).toBeGreaterThan(0);
        expect(Math.abs(observed - expected), `${outcome} observed ${observed}`).toBeLessThan(0.06);
      }
    });

    it('produces the same sequence twice for the same seed', async () => {
      const tenantId = await createTenant('determinism tenant');
      const outcomes = async (): Promise<string[]> => {
        await testDb().query('DELETE FROM mock_outbox');
        const provider = new MockEmailProvider({
          db: testDb(),
          clock: new FakeClock('2026-03-01T09:00:00Z'),
          failureRate: 0.2,
          bounceRate: 0.2,
          complaintRate: 0.1,
          rng: seededRng(99),
        });
        for (let i = 0; i < 25; i++) await provider.send(emailMessage(tenantId, i));
        const { rows } = await testDb().query<{ simulated_outcome: string; provider_message_id: string }>(
          'SELECT simulated_outcome, provider_message_id FROM mock_outbox ORDER BY sent_at, id',
        );
        return rows.map((r) => `${r.simulated_outcome}:${r.provider_message_id}`);
      };
      expect(await outcomes()).toEqual(await outcomes());
    });
  });

  describe('simulated callbacks', () => {
    it('reports a rejected send synchronously and schedules no callback', async () => {
      const tenantId = await createTenant('failure tenant');
      const clock = new FakeClock('2026-03-01T09:00:00Z');
      const provider = new MockEmailProvider({
        db: testDb(),
        clock,
        failureRate: 1,
        bounceRate: 0,
        complaintRate: 0,
        rng: seededRng(5),
      });

      const result = await provider.send(emailMessage(tenantId, 1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['mock_invalid_recipient', 'mock_rate_limited']).toContain(result.errorCode);
      }
      // A provider that never accepted the message has nothing to call back about.
      expect(provider.scheduledWebhookCount()).toBe(0);
      clock.advanceMinutes(10);
      expect(provider.pendingWebhookEvents()).toEqual([]);
    });

    it('holds a delivery callback until it comes due on the injected clock', async () => {
      const tenantId = await createTenant('delivery tenant');
      const clock = new FakeClock('2026-03-01T09:00:00Z');
      const provider = new MockEmailProvider({
        db: testDb(),
        clock,
        failureRate: 0,
        bounceRate: 0,
        complaintRate: 0,
        webhookDelayMs: 2_000,
        rng: seededRng(13),
      });

      const result = await provider.send(emailMessage(tenantId, 1));
      expect(provider.pendingWebhookEvents()).toEqual([]);
      expect(provider.scheduledWebhookCount()).toBe(1);

      clock.advance(2_000);
      const due = provider.pendingWebhookEvents();
      expect(due).toHaveLength(1);
      expect(due[0]?.type).toBe('delivered');
      expect(due[0]?.providerMessageId).toBe(result.ok ? result.providerMessageId : '');
      expect(due[0]?.occurredAt.toISOString()).toBe('2026-03-01T09:00:02.000Z');

      // Draining is at-most-once; the webhook endpoint deduplicates on
      // providerEventId, so there is no second delivery state machine here.
      expect(provider.pendingWebhookEvents()).toEqual([]);
    });

    it('emits a bounce instead of a delivery when the outcome is a bounce', async () => {
      const tenantId = await createTenant('bounce tenant');
      const clock = new FakeClock('2026-03-01T09:00:00Z');
      const provider = new MockEmailProvider({
        db: testDb(),
        clock,
        failureRate: 0,
        bounceRate: 1,
        complaintRate: 0,
        rng: seededRng(21),
      });

      await provider.send(emailMessage(tenantId, 1));
      clock.advanceMinutes(1);
      const events = provider.pendingWebhookEvents();
      expect(events.map((e) => e.type)).toEqual(['bounced']);
      expect(events[0]?.errorCode).toBe('mock_invalid_recipient');
    });

    it('delivers before it complains', async () => {
      const tenantId = await createTenant('complaint tenant');
      const clock = new FakeClock('2026-03-01T09:00:00Z');
      const provider = new MockEmailProvider({
        db: testDb(),
        clock,
        failureRate: 0,
        bounceRate: 0,
        complaintRate: 1,
        rng: seededRng(33),
      });

      await provider.send(emailMessage(tenantId, 1));
      clock.advanceMinutes(1);
      const events = provider.pendingWebhookEvents();
      // A recipient cannot report as spam a message they were never handed, and
      // the consent rules have to cope with delivered-then-suppressed.
      expect(events.map((e) => e.type)).toEqual(['delivered', 'complained']);
      expect(events[1]!.occurredAt.getTime()).toBeGreaterThan(events[0]!.occurredAt.getTime());
      expect(new Set(events.map((e) => e.providerEventId)).size).toBe(2);
    });
  });
});
