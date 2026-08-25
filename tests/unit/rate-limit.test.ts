import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { FakeClock } from '@campaign/core';
import { bucketTokens, tryAcquire } from '@campaign/providers';
import { testDb, closeTestDb, resetDb } from '../support/db.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

async function createTenant(): Promise<string> {
  const { rows } = await testDb().query<{ id: string }>(
    "INSERT INTO tenants (name) VALUES ('rate limit tenant') RETURNING id",
  );
  return rows[0]!.id;
}

/**
 * The limiter is in Postgres because it has to hold across processes, so the test
 * that matters most is the concurrent one: an in-process counter passes every
 * sequential assertion below and still lets two workers spend the same token.
 */
describe('the cross-process token bucket', () => {
  it('creates the bucket full and spends it down', async () => {
    const tenantId = await createTenant();
    const clock = new FakeClock('2026-03-01T09:00:00Z');
    const config = {
      tenantId,
      provider: 'mock',
      channel: 'email' as const,
      capacity: 3,
      refillPerSecond: 1,
    };

    expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(true);
    expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(true);
    expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(true);

    const denied = await tryAcquire(testDb(), config, clock);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills at the configured rate, measured on the injected clock', async () => {
    const tenantId = await createTenant();
    const clock = new FakeClock('2026-03-01T09:00:00Z');
    const config = {
      tenantId,
      provider: 'mock',
      channel: 'email' as const,
      capacity: 2,
      refillPerSecond: 2,
    };

    await tryAcquire(testDb(), config, clock);
    await tryAcquire(testDb(), config, clock);
    expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(false);

    // Half a second at two per second is exactly one token.
    clock.advance(500);
    expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(true);
    expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(false);
  });

  it('keeps accruing while it is being refused', async () => {
    // updated_at is deliberately not advanced on a denial. If it were, a polling
    // caller would reset the refill integral on every attempt and starve forever.
    const tenantId = await createTenant();
    const clock = new FakeClock('2026-03-01T09:00:00Z');
    const config = {
      tenantId,
      provider: 'mock',
      channel: 'sms' as const,
      capacity: 1,
      refillPerSecond: 1,
    };

    expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(true);
    for (let i = 0; i < 5; i++) {
      clock.advance(100);
      expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(false);
    }
    clock.advance(600);
    expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(true);
  });

  it('never refills beyond capacity', async () => {
    const tenantId = await createTenant();
    const clock = new FakeClock('2026-03-01T09:00:00Z');
    const config = {
      tenantId,
      provider: 'mock',
      channel: 'email' as const,
      capacity: 2,
      refillPerSecond: 5,
    };

    await tryAcquire(testDb(), config, clock);
    // A bucket idle for an hour must not become an hour's worth of burst; that is
    // the burst the provider's own throttle exists to stop.
    clock.advanceHours(1);
    expect(await bucketTokens(testDb(), config, clock)).toBe(2);
    expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(true);
    expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(true);
    expect((await tryAcquire(testDb(), config, clock)).allowed).toBe(false);
  });

  it('hands the last token to exactly one of two concurrent callers', async () => {
    const tenantId = await createTenant();
    const clock = new FakeClock('2026-03-01T09:00:00Z');
    const config = {
      tenantId,
      provider: 'mock',
      channel: 'email' as const,
      capacity: 1,
      refillPerSecond: 0.001,
    };

    const results = await Promise.all([
      tryAcquire(testDb(), config, clock),
      tryAcquire(testDb(), config, clock),
      tryAcquire(testDb(), config, clock),
      tryAcquire(testDb(), config, clock),
    ]);
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
  });

  it('keeps separate buckets per tenant, provider and channel', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const clock = new FakeClock('2026-03-01T09:00:00Z');
    const base = { capacity: 1, refillPerSecond: 0.001 };

    expect(
      (
        await tryAcquire(
          testDb(),
          { ...base, tenantId: a, provider: 'mock', channel: 'email' },
          clock,
        )
      ).allowed,
    ).toBe(true);
    // One tenant exhausting its allowance must not throttle another one; a shared
    // bucket is a noisy-neighbour outage that looks like a provider problem.
    expect(
      (
        await tryAcquire(
          testDb(),
          { ...base, tenantId: b, provider: 'mock', channel: 'email' },
          clock,
        )
      ).allowed,
    ).toBe(true);
    expect(
      (
        await tryAcquire(
          testDb(),
          { ...base, tenantId: a, provider: 'mock', channel: 'sms' },
          clock,
        )
      ).allowed,
    ).toBe(true);
    expect(
      (
        await tryAcquire(
          testDb(),
          { ...base, tenantId: a, provider: 'twilio', channel: 'sms' },
          clock,
        )
      ).allowed,
    ).toBe(true);
    expect(
      (
        await tryAcquire(
          testDb(),
          { ...base, tenantId: a, provider: 'mock', channel: 'email' },
          clock,
        )
      ).allowed,
    ).toBe(false);
  });

  it('refuses a configuration that could never permit a send', async () => {
    const tenantId = await createTenant();
    const clock = new FakeClock('2026-03-01T09:00:00Z');
    await expect(
      tryAcquire(
        testDb(),
        { tenantId, provider: 'mock', channel: 'email', capacity: 0, refillPerSecond: 1 },
        clock,
      ),
    ).rejects.toThrow(/positive capacity/);
  });
});
