/**
 * V7 — THE BUDGET REFUSES AT THE CEILING, BEFORE THE CALL.
 *
 * Failure it prevents: a cost problem silently converted into a quality problem.
 *
 * Two things are being asserted, and the second is the one that gets skipped.
 *
 *   POSITION. The check runs before the call, not after. Checked after, it is not
 *   a budget, it is a report — the tokens are already spent and the ledger's only
 *   remaining job is to tell you by how much you overshot.
 *
 *   ATOMICITY. The reservation is one statement. SELECT-compare-UPDATE passes on
 *   every concurrent caller, exactly the way check-then-insert fails to
 *   deduplicate (tests/invariants/i4). A budget that holds under one worker and
 *   leaks under eight is not a budget, and the leak is invisible in development
 *   because development runs one worker.
 *
 * And at the ceiling it REFUSES. It does not truncate the reply to fit, fall back
 * to a cheaper model, or skip the classification and mark it `auto`. Each of those
 * means the tenant who exceeded their budget is the tenant whose complaints stop
 * being detected, with nothing failing to say so.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import {
  budgetState,
  classifyReply,
  MockModelClient,
  releaseTokens,
  reserveTokens,
  TokenBudgetExceededError,
} from '@campaign/triage';
import {
  fakeClock,
  fixtureFor,
  seedReply,
  seedTriageTenant,
  syncedPrompt,
  triageDeps,
  validAnswer,
} from './triage-harness.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

describe('V7 — the token budget refuses at the ceiling', () => {
  it('refuses the call rather than degrading it', async () => {
    const db = testDb();
    const clock = fakeClock();
    // Small enough that a single classification cannot fit.
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 50 });
    const prompt = await syncedPrompt(db, 1);
    const body = 'Where has my order got to?';
    const model = new MockModelClient({ fixtures: fixtureFor(prompt, body, validAnswer()) });

    await expect(
      classifyReply(triageDeps({ db, prompt, model, clock }), await seedReply(db, tenantId, body)),
    ).rejects.toThrow(TokenBudgetExceededError);

    // The model was never asked, and nothing was written that would let this look
    // like a successful classification later.
    expect(model.calls).toBe(0);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM classifications`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('names the numbers in the error, because "budget exceeded" is not actionable', async () => {
    const db = testDb();
    const clock = fakeClock();
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 1000 });
    await reserveTokens(db, { tenantId, tokens: 900, clock });

    const error = await reserveTokens(db, { tenantId, tokens: 200, clock }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TokenBudgetExceededError);
    const budgetError = error as TokenBudgetExceededError;
    expect(budgetError.budget).toBe(1000);
    expect(budgetError.used).toBe(900);
    expect(budgetError.requested).toBe(200);
    expect(budgetError.message).toMatch(/has NOT been\s+silently downgraded|NOT been/);
  });

  it('allows a reservation that exactly fills the budget', async () => {
    const db = testDb();
    const clock = fakeClock();
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 1000 });
    const state = await reserveTokens(db, { tenantId, tokens: 1000, clock });
    expect(state.used).toBe(1000);
    expect(state.remaining).toBe(0);
    await expect(reserveTokens(db, { tenantId, tokens: 1, clock })).rejects.toThrow(
      TokenBudgetExceededError,
    );
  });

  it('holds under concurrent reservations from separate connections', async () => {
    const db = testDb();
    const clock = fakeClock();
    // Ten workers, each asking for 100, against a ceiling of 500. Exactly five may
    // win. SELECT-then-UPDATE would let all ten through.
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 500 });
    const url = process.env['DATABASE_URL']!;
    const pools = Array.from({ length: 10 }, () => new Pool({ connectionString: url, max: 2 }));

    try {
      const results = await Promise.all(
        pools.map((pool) =>
          reserveTokens(pool, { tenantId, tokens: 100, clock }).then(
            () => 'ok' as const,
            () => 'refused' as const,
          ),
        ),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(5);

      const state = await budgetState(db, tenantId, clock);
      expect(state.used, 'the ledger must never exceed the ceiling').toBe(500);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });

  it('reconciles the pessimistic reservation down to what was actually used', async () => {
    const db = testDb();
    const clock = fakeClock();
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 1_000_000 });
    const prompt = await syncedPrompt(db, 1);
    const body = 'A short question about sizing.';
    const model = new MockModelClient({ fixtures: fixtureFor(prompt, body, validAnswer()) });

    await classifyReply(
      triageDeps({ db, prompt, model, clock }),
      await seedReply(db, tenantId, body),
    );

    // The fixture reports 400 input + 60 output. The reservation booked the prompt
    // plus the full max_tokens; settlement brings it back to the truth.
    const state = await budgetState(db, tenantId, clock);
    expect(state.used).toBe(460);

    const { rows } = await db.query<{ cost: string }>(
      `SELECT cost_usd::text AS cost FROM token_budget_ledger WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(Number(rows[0]!.cost)).toBe(0);
  });

  it('releases the reservation when the vendor throws, so an outage cannot drain a budget', async () => {
    const db = testDb();
    const clock = fakeClock();
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 100_000 });
    const prompt = await syncedPrompt(db, 1);
    // No fixture and no synthesiser: the mock refuses rather than inventing one.
    const model = new MockModelClient({ fixtures: {} });

    await expect(
      classifyReply(
        triageDeps({ db, prompt, model, clock }),
        await seedReply(db, tenantId, 'anything'),
      ),
    ).rejects.toThrow(/No recorded model response/);

    const state = await budgetState(db, tenantId, clock);
    expect(state.used, 'a failed call must not consume budget').toBe(0);
  });

  it('rolls over with the clock, not with wall time', async () => {
    const db = testDb();
    const august = fakeClock();
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 1000 });
    await reserveTokens(db, { tenantId, tokens: 1000, clock: august });
    await expect(reserveTokens(db, { tenantId, tokens: 1, clock: august })).rejects.toThrow();

    const september = fakeClock();
    september.advanceDays(31);
    // A new period is a new ledger row. This is why the demo can fast-forward a
    // month in a second and watch the budget reset.
    const state = await reserveTokens(db, { tenantId, tokens: 900, clock: september });
    expect(state.used).toBe(900);
    expect(state.period).toBe('2026-09-01');
  });

  it('never lets a release drive the ledger negative', async () => {
    const db = testDb();
    const clock = fakeClock();
    const tenantId = await seedTriageTenant(db, { monthlyTokenBudget: 1000 });
    await reserveTokens(db, { tenantId, tokens: 100, clock });
    await releaseTokens(db, { tenantId, tokens: 5000, clock });
    // A tenant with negative usage has an effectively infinite budget, which is a
    // far worse bug than the double-release it would be papering over.
    expect((await budgetState(db, tenantId, clock)).used).toBe(0);
  });
});
