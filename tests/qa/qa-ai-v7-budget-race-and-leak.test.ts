/**
 * QA / ADVERSARIAL — V7: "the budget refuses BEFORE the call".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * Two separate questions, two different verdicts.
 *
 * (a) THE RACE — VERDICT: SAFE.
 *     `reserveTokens` is one `INSERT ... ON CONFLICT DO UPDATE ... WHERE ...`
 *     statement. Postgres takes a row lock on conflict and re-evaluates the
 *     DO UPDATE's WHERE against the row version the winner just wrote, so the
 *     read and the compare cannot be interleaved. 24 genuinely concurrent
 *     reservations from 24 separate pooled connections, against a budget with
 *     room for exactly one, admit exactly one. The full `triage` pipeline behaves
 *     the same way. No overshoot at any concurrency I could produce.
 *
 * (b) THE RESERVATION LEAK — VERDICT: BROKEN.
 *     `callWithBudget` releases the reservation only when `model.complete()`
 *     REJECTS. A process that dies between `reserveTokens` and `settleTokens`
 *     leaves the full pessimistic reservation — estimated input plus the entire
 *     `max_tokens` output allowance — booked permanently. There is no sweeper:
 *     `token_budget_ledger` is referenced from exactly four SQL statements in the
 *     repository, all in budget.ts, and none of them expires or reconciles a
 *     stale reservation. The ledger has no reservation identity, no timestamp and
 *     no in-flight column, so a sweeper could not be written against it as it
 *     stands.
 *
 *     Quantified below against the shipped defaults (2,000,000 tokens/month,
 *     max_output 1024, the real v1 prompt): roughly 1,400 crashes exhausts a
 *     tenant's month, after which every classification refuses until the period
 *     rolls over. That is not "a crash costs a call" — a crash costs ~1,450
 *     tokens the tenant never gets back.
 *
 * (c) A THIRD, SMALLER LEAK — VERDICT: BROKEN.
 *     `settleTokens` and `releaseTokens` both recompute `budgetPeriod(clock)` at
 *     settle time rather than carrying the period the reservation was made in.
 *     A call that starts at 23:59:59 on the last of the month and returns after
 *     midnight settles against the NEW period's row. The `UPDATE ... WHERE
 *     period = <new>` matches nothing (the row does not exist yet), so the old
 *     period keeps the full reservation forever AND the cost is silently dropped
 *     on the floor. Same bug in `releaseTokens`: a vendor error across a period
 *     boundary never refunds.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { FakeClock } from '@campaign/core';
import {
  budgetState,
  classifyReply,
  DEFAULT_MAX_OUTPUT_TOKENS,
  estimateTokens,
  MockModelClient,
  releaseTokens,
  reserveTokens,
  settleTokens,
  TokenBudgetExceededError,
} from '@campaign/triage';
import {
  CLOCK_START,
  fixtureFor,
  seedReply,
  seedTriageTenant,
  syncedPrompt,
  triageDeps,
  validAnswer,
} from '../invariants/triage-harness.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

const BUDGET_SRC = fileURLToPath(new URL('../../packages/triage/src/budget.ts', import.meta.url));

/** Genuinely concurrent: N separate connections, all released at once. */
async function concurrently<T>(n: number, fn: (i: number) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  // Reassigned synchronously by the Promise executor below; the initial value is
  // never called and exists only so the binding is definitely assigned.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = Array.from({ length: n }, (_, i) => gate.then(() => fn(i)));
  release();
  return Promise.allSettled(running);
}

describe('QA/V7 — the reservation under concurrency', () => {
  it('SAFE: 24 concurrent reservations with room for exactly one admit exactly one', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    // Room for exactly one reservation of 100.
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 100 });

    const results = await concurrently(24, () =>
      reserveTokens(db, { tenantId, tokens: 100, clock }),
    );

    const granted = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(granted).toHaveLength(1);
    expect(refused).toHaveLength(23);
    for (const r of refused) {
      expect((r).reason).toBeInstanceOf(TokenBudgetExceededError);
    }

    const state = await budgetState(db, tenantId, clock);
    expect(state.used, 'no overshoot').toBe(100);
  });

  it('SAFE: holds at fine granularity — 40 concurrent 10-token reservations against 250', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 250 });

    const results = await concurrently(40, () => reserveTokens(db, { tenantId, tokens: 10, clock }));
    const granted = results.filter((r) => r.status === 'fulfilled').length;

    expect(granted).toBe(25);
    const state = await budgetState(db, tenantId, clock);
    expect(state.used).toBe(250);
    expect(state.used).toBeLessThanOrEqual(state.budget);
  });

  it('SAFE: holds across a SECOND pool, i.e. across processes, not just across clients', async () => {
    const db = testDb();
    const other = new Pool({ connectionString: process.env['DATABASE_URL'], max: 8 });
    try {
      const clock = new FakeClock(CLOCK_START);
      const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 100 });

      const results = await concurrently(16, (i) =>
        reserveTokens(i % 2 === 0 ? db : other, { tenantId, tokens: 100, clock }),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await budgetState(db, tenantId, clock)).used).toBe(100);
    } finally {
      await other.end();
    }
  });

  it('SAFE: two concurrent full classifications with room for exactly one — one succeeds', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const prompt = await syncedPrompt(db, 1);

    const bodyA = 'Where has my parcel got to? It is a week late now.';
    const bodyB = 'Do you ship to the Isle of Man at all?';
    const model = new MockModelClient({
      fixtures: {
        ...fixtureFor(prompt, bodyA, validAnswer({ label: 'complaint', confidence: 0.9 })),
        ...fixtureFor(prompt, bodyB, validAnswer({ label: 'question', confidence: 0.9 })),
      },
    });

    // One reservation's worth of headroom, computed from the real request shape.
    const oneCall =
      estimateTokens(prompt.body) + estimateTokens(bodyA) + DEFAULT_MAX_OUTPUT_TOKENS;
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: oneCall });
    const deps = triageDeps({ db, prompt, model, clock });

    const replies = [
      await seedReply(db, tenantId, bodyA),
      await seedReply(db, tenantId, bodyB),
    ];
    const results = await concurrently(2, (i) => classifyReply(deps, replies[i]!));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected')!;
    expect(rejected.reason).toBeInstanceOf(TokenBudgetExceededError);

    // Exactly one model call was made, and the ledger settled down to what it used.
    expect(model.calls).toBe(1);
    const state = await budgetState(db, tenantId, clock);
    expect(state.used).toBeLessThanOrEqual(state.budget);
  });
});

describe('QA/V7 — the reservation leak', () => {
  it('FINDING: a crash between reserve and settle leaks the whole reservation', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 100_000 });

    // This is exactly what `callWithBudget` does, up to the point a SIGKILL, an
    // OOM, a pod eviction or a deploy would land.
    await reserveTokens(db, { tenantId, tokens: 5_000, clock });
    // ...process dies here. Nothing else runs.

    expect((await budgetState(db, tenantId, clock)).used).toBe(5_000);

    // A new process starts. Nothing reconciles the orphan.
    expect((await budgetState(db, tenantId, clock)).used).toBe(5_000);
  });

  it('FINDING: there is no sweeper, and the ledger could not support one', async () => {
    const src = await readFile(BUDGET_SRC, 'utf8');
    // Four statements touch the ledger, all here, none of them a sweep.
    const statements = [...src.matchAll(/token_budget_ledger/g)];
    expect(statements).toHaveLength(4);
    // The module's entire exported surface: no sweep, no reclaim, no reconcile.
    const exported = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
    expect(exported).toEqual([
      'budgetPeriod',
      'budgetState',
      'reserveTokens',
      'settleTokens',
      'releaseTokens',
    ]);

    // And the table has no reservation identity or timestamp to sweep BY: a
    // sweeper cannot distinguish a leaked reservation from legitimate usage.
    const db = testDb();
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'token_budget_ledger' ORDER BY ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'tenant_id',
      'period',
      'tokens_used',
      'cost_usd',
    ]);
  });

  it('FINDING: quantified — ~1,400 crashes permanently exhaust a default tenant month', async () => {
    const db = testDb();
    const prompt = await syncedPrompt(db, 1);

    // The shipped defaults: migrations/0009 sets monthly_token_budget to 2e6.
    const { rows } = await db.query<{ default: string }>(
      `SELECT column_default AS default FROM information_schema.columns
        WHERE table_name = 'tenants' AND column_name = 'monthly_token_budget'`,
    );
    expect(rows[0]!.default).toMatch(/2000000/);

    const typicalBody = 'Hi — my order arrived damaged and I would like a replacement please.';
    const perCrash =
      estimateTokens(prompt.body) + estimateTokens(typicalBody) + DEFAULT_MAX_OUTPUT_TOKENS;
    const crashesToExhaust = Math.ceil(2_000_000 / perCrash);

    // A crash costs ~1,450 tokens, not one call. The number is small enough that a
    // crash-looping worker gets there in minutes.
    expect(perCrash).toBeGreaterThan(1_200);
    expect(crashesToExhaust).toBeLessThan(2_000);

    // Demonstrated, not just arithmetic: 20 crashes against a 20-call budget leaves
    // no room for a 21st call, having produced zero classifications.
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: perCrash * 20 });
    for (let i = 0; i < 20; i += 1) {
      await reserveTokens(db, { tenantId, tokens: perCrash, clock });
    }
    await expect(reserveTokens(db, { tenantId, tokens: perCrash, clock })).rejects.toBeInstanceOf(
      TokenBudgetExceededError,
    );
    const { rows: calls } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_calls`,
    );
    expect(Number(calls[0]!.n), 'the budget is spent and nothing was produced').toBe(0);
  });

  it('FINDING: settle across a month boundary loses the reservation AND the cost', async () => {
    const db = testDb();
    const clock = new FakeClock('2026-08-31T23:59:30.000Z');
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 100_000 });

    await reserveTokens(db, { tenantId, tokens: 5_000, clock });
    expect((await budgetState(db, tenantId, clock)).used).toBe(5_000);

    // The vendor takes 45 seconds. The clock crosses into September.
    clock.advance(45_000);
    await settleTokens(db, {
      tenantId,
      reserved: 5_000,
      actualTokens: 900,
      costUsd: 0.42,
      clock,
    });

    // September's ledger row does not exist, so the UPDATE matched nothing.
    const september = await budgetState(db, tenantId, clock);
    expect(september.period).toBe('2026-09-01');
    expect(september.used).toBe(0);

    // And August still carries the full pessimistic reservation, with no cost.
    const { rows } = await db.query<{ period: string; tokens_used: string; cost_usd: string }>(
      `SELECT period::text, tokens_used::text, cost_usd::text FROM token_budget_ledger
        WHERE tenant_id = $1 ORDER BY period`,
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.period).toBe('2026-08-01');
    expect(Number(rows[0]!.tokens_used), 'the 900 actually used never reconciled').toBe(5_000);
    expect(Number(rows[0]!.cost_usd), 'the money spent is not on any ledger').toBe(0);
  });

  it('FINDING: release across a month boundary never refunds either', async () => {
    const db = testDb();
    const clock = new FakeClock('2026-08-31T23:59:30.000Z');
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 100_000 });

    await reserveTokens(db, { tenantId, tokens: 5_000, clock });
    clock.advance(45_000); // the vendor times out just after midnight
    await releaseTokens(db, { tenantId, tokens: 5_000, clock });

    const { rows } = await db.query<{ tokens_used: string }>(
      `SELECT tokens_used::text FROM token_budget_ledger WHERE tenant_id = $1 AND period = '2026-08-01'`,
      [tenantId],
    );
    expect(Number(rows[0]!.tokens_used), 'the outage burned the budget after all').toBe(5_000);
  });

  it('note: the comment about the CHECK constraint in settleTokens is wrong', async () => {
    const src = await readFile(BUDGET_SRC, 'utf8');
    // "It is clamped at zero by the ledger's own CHECK constraint rather than
    // here, so a bug that tried to refund more than was reserved fails loudly
    // instead of producing a tenant with negative usage."
    expect(src).toMatch(/clamped at zero by the ledger's own\n \* CHECK constraint rather than here/);
    // It is in fact clamped by GREATEST(0, ...) in the same statement, so an
    // over-refund is silent, not loud. Cosmetic here, but it is the sentence a
    // future reader would trust.
    expect(src).toMatch(/SET tokens_used = GREATEST\(0, tokens_used \+ \$3::bigint\)/);

    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 10_000 });
    await reserveTokens(db, { tenantId, tokens: 100, clock });
    // Refund ten times what was reserved: no error, silently floored at zero.
    await settleTokens(db, { tenantId, reserved: 1_000, actualTokens: 0, costUsd: 0, clock });
    expect((await budgetState(db, tenantId, clock)).used).toBe(0);
  });
});
