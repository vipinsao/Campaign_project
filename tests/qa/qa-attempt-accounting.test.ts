/**
 * H1 — ATTEMPT AND DEFERRAL ACCOUNTING.
 *
 * `claimBatch` does `attempts = attempts + 1`; `deferClaimed` does
 * `attempts = GREATEST(attempts - 1, 0)` and `deferrals = deferrals + 1`.
 *
 * Three separate questions:
 *   (a) can `attempts` go negative?  — clamped twice (GREATEST + a CHECK). SAFE.
 *   (b) is a deferral bounded?  — `deferrals` is written by one statement, read by
 *       two read-only API projections, and compared against nothing anywhere. There
 *       is no MAX_DEFERRALS in the repository.
 *   (c) worse: because a deferral hands an attempt BACK, a row that alternates
 *       "transient provider failure / retryable gate" never reaches attempt
 *       exhaustion, and is handed to the provider an unbounded number of times.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { queueOne } from '../support/delivery.ts';
import { claimBatch, deferClaimed, processQueue, FakeClock } from '@campaign/core';
import { scriptedProvider, depsFor, fullQueueRow } from './support.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

async function oneQueuedMessage(opts: { paused?: boolean } = {}) {
  const seeded = await seedAll(testDb(), {
    campaign: opts.paused ? { status: 'paused' } : {},
  });
  await optIn(testDb(), seeded.tenantId, seeded.contactId);
  const id = await queueOne(seeded);
  return { seeded, id };
}

describe('H1(a) — attempts cannot go negative', () => {
  it('SAFE: 50 deferrals against 1 claim leave attempts at 0, never below', async () => {
    const { id } = await oneQueuedMessage();
    const clock = new FakeClock('2026-06-15T12:00:00Z');
    await claimBatch(testDb(), { workerId: 'w', batchSize: 1, clock });

    for (let i = 0; i < 50; i++) {
      await deferClaimed(testDb(), { claimedBy: 'w', id, until: new Date('2026-06-16T09:00:00Z'), clock });
    }

    const row = await fullQueueRow(id);
    expect(row!.attempts, 'GREATEST(attempts - 1, 0) clamps at zero').toBe(0);
    expect(row!.deferrals).toBe(50);
    // Belt and braces: the schema would have refused anyway.
    await expect(
      testDb().query(`UPDATE message_queue SET attempts = -1 WHERE id = $1`, [id]),
    ).rejects.toThrow(/message_queue_attempts_nonneg/);
  });
});

describe('H1(b) — deferrals are unbounded', () => {
  it('OBSERVED: a row survives 1000 deferrals and is still pending and claimable', async () => {
    const { id } = await oneQueuedMessage();
    const clock = new FakeClock('2026-06-15T12:00:00Z');

    await testDb().query(
      `UPDATE message_queue SET deferrals = 1000, last_deferred_at = $2,
              status = 'pending', scheduled_at = $2, attempts = 0 WHERE id = $1`,
      [id, clock.now()],
    );

    const row = await fullQueueRow(id);
    expect(row!.deferrals).toBe(1000);
    expect(row!.status, 'still pending after a thousand deferrals').toBe('pending');

    const claimed = await claimBatch(testDb(), { workerId: 'w', batchSize: 1, clock });
    expect(claimed, 'and still claimable — nothing reads `deferrals`').toHaveLength(1);
  });

  it('OBSERVED: a paused campaign re-defers the same row every pass, forever', async () => {
    const { id } = await oneQueuedMessage({ paused: true });
    const clock = new FakeClock('2026-06-15T12:00:00Z');
    const provider = scriptedProvider([{ ok: true, providerMessageId: 'pm' }]);
    const deps = depsFor(provider, clock);

    // 40 worker passes = 10 simulated hours of a campaign left paused.
    for (let i = 0; i < 40; i++) {
      await processQueue(deps);
      clock.advanceMinutes(16); // the gate's own nextEligibleAt is now + 15 min
    }

    const row = await fullQueueRow(id);
    expect(row!.deferrals, 'every single pass deferred it again').toBe(40);
    expect(row!.attempts, 'and gave the attempt straight back').toBe(0);
    expect(provider.sent, 'nothing was sent, which is correct').toHaveLength(0);

    // 40 identical send_decisions rows for ONE message in 10 hours. A campaign
    // left paused for a month writes ~2,900 per message, times the queue depth.
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM send_decisions
        WHERE message_queue_id = $1 AND reason_code = 'campaign_not_active'`,
      [id],
    );
    expect(Number(rows[0]!.n)).toBe(40);
  });

  it('SHOULD: something in the queue/delivery layer bounds the deferral count', () => {
    const queue = src('packages/core/src/queue/message-queue.ts');
    const orch = src('packages/core/src/delivery/orchestrator.ts');
    const both = `${queue}\n${orch}`;

    // `deferrals` is incremented, and then never compared against anything. Any of
    // `deferrals >=`, `deferrals >`, `maxDeferrals` would count.
    const bounded = /deferrals\s*(>=|>)|maxDeferrals|MAX_DEFERRALS/.test(both);
    expect(
      bounded,
      '`deferrals` is written by deferClaimed and read by nothing that can stop a ' +
        'deferral loop: a row held by a recurring retryable gate stays pending ' +
        'indefinitely, and there is no expiry sweep for it either (expire-anchors ' +
        "only touches scheduled_at = 'infinity' rows)",
    ).toBe(true);
  });
});

describe('H1(c) — does a deferral let a row dodge attempt exhaustion?', () => {
  /**
   * Tenant sending window is 08:00-20:00. Each cycle:
   *   12:00 - claimed (attempts +1), provider returns TRANSIENT, scheduleRetry
   *   23:00 - claimed (attempts +1), quiet-hours gate defers, deferClaimed (-1)
   *
   * The hypothesis was that the decrement lets a row retry forever. It does not:
   * every decrement cancels the increment from ITS OWN claim, so `attempts` still
   * nets +1 per real provider call and exhaustion arrives on schedule.
   */
  async function runCycles(cycles: number) {
    const seeded = await seedAll(testDb(), {
      tenant: { quietStart: '08:00', quietEnd: '20:00' },
    });
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z' });

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    const provider = scriptedProvider([
      { ok: false, errorCode: 'transient_timeout', errorMessage: 'timed out' , raw: {}},
    ]);
    const deps = depsFor(provider, clock, { maxAttempts: 5, backoffMs: () => 60_000 });

    for (let c = 0; c < cycles; c++) {
      const day = String(16 + c).padStart(2, '0');
      clock.set(`2026-06-${day}T12:00:00Z`);
      await processQueue(deps); // a real attempt: transient provider failure
      clock.set(`2026-06-${day}T23:00:00Z`);
      await processQueue(deps); // outside the window: deferral, attempts - 1
    }
    return { id, provider };
  }

  it('SAFE: 12 alternating cycles still stop at exactly maxAttempts provider calls', async () => {
    const { id, provider } = await runCycles(12);
    const row = await fullQueueRow(id);

    expect(provider.sent.length, 'exactly maxAttempts real provider calls').toBe(5);
    expect(row!.status, 'and then the row is permanently failed').toBe('failed');
    expect(row!.error_class).toBe('transient');
    expect(row!.provider_error_code).toBe('transient_timeout');
    // The deferrals that happened after exhaustion stop happening because the row
    // is no longer pending; the ones before it did not buy the row extra attempts.
    expect(row!.deferrals, 'deferrals happened, and cost nothing').toBeGreaterThan(0);
  });
});
