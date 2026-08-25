/**
 * I8 — Provider errors are classified terminal or transient from an explicit,
 *      tested table. Terminal errors are NEVER retried, and the provider's own
 *      error code is persisted rather than a paraphrase of it.
 *
 * Failure it prevents: a carrier-rejected message resent three times — tripling
 * the cost and the complaint surface without any chance of succeeding — and
 * forensics three months later being impossible because the stored error string
 * is the HTTP framework's, not the provider's.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { harness, queueOne, queueRow, recordingProvider } from '../support/delivery.ts';
import { processQueue } from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

async function ready() {
  const seeded = await seedAll();
  await optIn(testDb(), seeded.tenantId, seeded.contactId);
  return seeded;
}

describe('I8 — terminal is terminal', () => {
  it('never retries a terminal error, no matter how many worker passes run', async () => {
    const seeded = await ready();
    const id = await queueOne(seeded);

    const provider = recordingProvider();
    provider.respondWith({
      ok: false,
      errorCode: 'terminal_invalid_recipient',
      errorMessage: 'The destination address is not valid.',
      raw: { code: 21211 },
    });
    const { deps } = harness({ provider });

    // Ten passes of the worker. A terminal failure must be attempted exactly once.
    for (let i = 0; i < 10; i++) await processQueue(deps);

    expect(
      provider.sent.length,
      'a terminal error was retried; that is money spent on a message the provider ' +
        'has already refused',
    ).toBe(1);

    const row = await queueRow(id);
    expect(row.status).toBe('failed');
    expect(row.error_class).toBe('terminal');
    expect(row.attempts).toBe(1);
    // The provider's OWN code, kept verbatim.
    expect(row.provider_error_code).toBe('terminal_invalid_recipient');
  });

  it('retries a transient error with backoff, then gives up at the cap', async () => {
    const seeded = await ready();
    const id = await queueOne(seeded);

    const provider = recordingProvider();
    provider.respondWith({
      ok: false,
      errorCode: 'transient_rate_limited',
      errorMessage: 'Too many requests.',
      raw: { code: 20429 },
    });
    const { deps, clock } = harness({ provider, maxAttempts: 3 });

    // Each pass must advance past the backoff, or next_attempt_at holds the row.
    for (let i = 0; i < 6; i++) {
      await processQueue(deps);
      clock.advanceHours(3);
    }

    expect(provider.sent.length, 'transient errors should retry up to the cap').toBe(3);
    const row = await queueRow(id);
    expect(row.status).toBe('failed');
    expect(row.error_class).toBe('transient');
  });

  it('holds a retrying message until its backoff has elapsed', async () => {
    const seeded = await ready();
    await queueOne(seeded);

    const provider = recordingProvider();
    provider.respondWith({
      ok: false,
      errorCode: 'transient_timeout',
      errorMessage: 'Upstream timeout.',
      raw: {},
    });
    const { deps, clock } = harness({ provider });

    await processQueue(deps);
    expect(provider.sent).toHaveLength(1);

    // Immediately again: the backoff has not elapsed, so nothing may be claimed.
    await processQueue(deps);
    expect(provider.sent, 'backoff was not respected').toHaveLength(1);

    clock.advanceHours(3);
    await processQueue(deps);
    expect(provider.sent).toHaveLength(2);
  });

  it('classifies from a table rather than from string matching', () => {
    // Table-driven, because a classification chain of if/includes is exactly how a
    // provider's "Blocked" and a framework's "blocked connection" end up in the
    // same branch.
    const { deps } = harness();
    const cases = [
      { code: 'terminal_hard_bounce', expected: 'terminal' },
      { code: 'terminal_blocked_number', expected: 'terminal' },
      { code: 'transient_rate_limited', expected: 'transient' },
      { code: 'transient_5xx', expected: 'transient' },
    ] as const;

    for (const { code, expected } of cases) {
      expect(deps.classifyError('mock', code).class, `${code} should be ${expected}`).toBe(
        expected,
      );
    }
    expect(deps.classifyError('mock', 'terminal_anything').maxAttempts).toBe(1);
  });
});
