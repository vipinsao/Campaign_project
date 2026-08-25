import type { Clock } from '@campaign/core';
import { type Db, queryOne } from '@campaign/core';

/**
 * Per-tenant token budget  (V7).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The budget is checked BEFORE the call, and the position of that check is the
 * whole invariant.
 *
 * Checked after, it is not a budget, it is a report. The tokens are already spent
 * and the ledger's only remaining job is to tell you by how much you overshot.
 * With eight workers draining a reply queue, "check after" overshoots by eight
 * calls at the moment of the breach and by considerably more if one tenant gets a
 * spike, because every in-flight call was authorised against the same stale total.
 *
 * The reservation is one statement, so the read and the write cannot be
 * interleaved. The alternative — SELECT the total, compare it in TypeScript, then
 * UPDATE — passes the check on every concurrent caller, exactly the way
 * check-then-insert fails to deduplicate (see tests/invariants/i4). A budget that
 * holds under one worker and not under four is not a budget.
 *
 * And when the ceiling is hit, this refuses. It does not truncate the reply to fit,
 * it does not silently fall back to a cheaper model, it does not skip the
 * classification and mark it `auto`. Each of those turns a cost problem into a
 * quality problem that nobody is looking for: the tenant who exceeded their budget
 * is the one whose complaints stop being detected, and no alert fires because
 * everything "succeeded".
 * ─────────────────────────────────────────────────────────────────────────────
 */

export class TokenBudgetExceededError extends Error {
  readonly tenantId: string;
  readonly period: string;
  readonly requested: number;
  readonly budget: number;
  readonly used: number;

  constructor(opts: {
    tenantId: string;
    period: string;
    requested: number;
    budget: number;
    used: number;
  }) {
    super(
      `Token budget exhausted for tenant ${opts.tenantId} in ${opts.period}: ` +
        `${opts.used} of ${opts.budget} tokens used, ${opts.requested} more requested. ` +
        `The call was refused before it was made. Raise tenants.monthly_token_budget ` +
        `or wait for the period to roll over — the classification has NOT been ` +
        `silently downgraded.`,
    );
    this.name = 'TokenBudgetExceededError';
    this.tenantId = opts.tenantId;
    this.period = opts.period;
    this.requested = opts.requested;
    this.budget = opts.budget;
    this.used = opts.used;
  }
}

/** The ledger is keyed on (tenant, period) and period is a DATE: the first of the
 *  month, in UTC, from the injected Clock. Never `new Date()` — the demo
 *  fast-forwards thirty days and the ledger has to roll over with it. */
export function budgetPeriod(clock: Clock): string {
  const now = clock.now();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}-01`;
}

export type BudgetState = {
  readonly tenantId: string;
  readonly period: string;
  readonly budget: number;
  readonly used: number;
  readonly remaining: number;
};

export async function budgetState(db: Db, tenantId: string, clock: Clock): Promise<BudgetState> {
  const period = budgetPeriod(clock);
  const row = await queryOne<{ budget: string; used: string }>(
    db,
    `SELECT t.monthly_token_budget::text AS budget,
            COALESCE(l.tokens_used, 0)::text AS used
       FROM tenants t
       LEFT JOIN token_budget_ledger l ON l.tenant_id = t.id AND l.period = $2::date
      WHERE t.id = $1`,
    [tenantId, period],
  );
  if (!row) throw new Error(`Unknown tenant ${tenantId}: cannot resolve a token budget.`);
  const budget = Number(row.budget);
  const used = Number(row.used);
  return { tenantId, period, budget, used, remaining: Math.max(0, budget - used) };
}

/**
 * Reserve `tokens` against the ledger, atomically, or throw.
 *
 * The reservation is pessimistic: it books the estimated INPUT plus the maximum
 * possible output before a single token has been generated. A ledger that only
 * books what was actually used cannot refuse anything, because the actual usage is
 * only knowable once the money has been spent. `settle` reconciles afterwards.
 */
export async function reserveTokens(
  db: Db,
  opts: { readonly tenantId: string; readonly tokens: number; readonly clock: Clock },
): Promise<BudgetState> {
  const period = budgetPeriod(opts.clock);

  const row = await queryOne<{ used: string; budget: string }>(
    db,
    `INSERT INTO token_budget_ledger AS l (tenant_id, period, tokens_used, cost_usd)
     SELECT t.id, $2::date, $3::bigint, 0
       FROM tenants t
      WHERE t.id = $1 AND $3::bigint <= t.monthly_token_budget
     ON CONFLICT (tenant_id, period) DO UPDATE
        SET tokens_used = l.tokens_used + $3::bigint
      WHERE l.tokens_used + $3::bigint
            <= (SELECT monthly_token_budget FROM tenants WHERE id = $1)
     RETURNING l.tokens_used::text AS used,
               (SELECT monthly_token_budget::text FROM tenants WHERE id = $1) AS budget`,
    [opts.tenantId, period, Math.max(0, Math.ceil(opts.tokens))],
  );

  if (!row) {
    // No row came back, which means either the WHERE clause refused the insert or
    // the DO UPDATE's WHERE refused the increment. Both are "over budget"; read
    // the current state so the error can say by how much.
    const state = await budgetState(db, opts.tenantId, opts.clock);
    throw new TokenBudgetExceededError({
      tenantId: opts.tenantId,
      period,
      requested: Math.ceil(opts.tokens),
      budget: state.budget,
      used: state.used,
    });
  }

  const used = Number(row.used);
  const budget = Number(row.budget);
  return { tenantId: opts.tenantId, period, budget, used, remaining: Math.max(0, budget - used) };
}

/**
 * Reconcile a reservation against what the call actually used, and record the cost.
 *
 * The delta can be negative (the usual case: the reservation booked `max_tokens`
 * of output and the model wrote forty). It is clamped at zero by the ledger's own
 * CHECK constraint rather than here, so a bug that tried to refund more than was
 * reserved fails loudly instead of producing a tenant with negative usage and an
 * effectively infinite budget.
 */
export async function settleTokens(
  db: Db,
  opts: {
    readonly tenantId: string;
    readonly reserved: number;
    readonly actualTokens: number;
    readonly costUsd: number;
    readonly clock: Clock;
  },
): Promise<void> {
  const delta = Math.ceil(opts.actualTokens) - Math.ceil(opts.reserved);
  await db.query(
    `UPDATE token_budget_ledger
        SET tokens_used = GREATEST(0, tokens_used + $3::bigint),
            cost_usd    = cost_usd + $4::numeric
      WHERE tenant_id = $1 AND period = $2::date`,
    [
      opts.tenantId,
      budgetPeriod(opts.clock),
      delta,
      Number.isFinite(opts.costUsd) ? opts.costUsd : 0,
    ],
  );
}

/** Release a reservation for a call that never happened (the client threw before
 *  the request left the process). Without this, a flapping vendor burns a tenant's
 *  monthly budget without producing a single classification. */
export async function releaseTokens(
  db: Db,
  opts: { readonly tenantId: string; readonly tokens: number; readonly clock: Clock },
): Promise<void> {
  await db.query(
    `UPDATE token_budget_ledger
        SET tokens_used = GREATEST(0, tokens_used - $3::bigint)
      WHERE tenant_id = $1 AND period = $2::date`,
    [opts.tenantId, budgetPeriod(opts.clock), Math.max(0, Math.ceil(opts.tokens))],
  );
}
