/**
 * @campaign/triage — the AI layer.
 *
 * The one idea this package exists to make legible:
 *
 *   THE DETERMINISTIC/MODEL BOUNDARY.
 *
 * A language model is genuinely good at reading prose, judging tone, summarising
 * and drafting. It must never be responsible for arithmetic, identity matching,
 * permission checks, or anything that has to give the same answer twice.
 *
 *   deterministic — never reaches a model      model — behind a confidence gate
 *   ─────────────────────────────────────      ─────────────────────────────────
 *   opt-out keyword detection                  intent classification
 *   order-number extraction (regex + DB)       sentiment / urgency
 *   any total, refund or date arithmetic       summarisation
 *   contact identity matching                  reply drafting
 *   duplicate detection (content hash)         entity extraction from prose
 *
 * The left column is deterministic.ts, and it has no model client in scope. The
 * right column is classifier.ts, and everything it produces is validated, gated on
 * confidence, budgeted, cached, recorded, and — crucially — wired to a consent
 * capability that can only ADD protection, never remove it (protection.ts, V9).
 */

export * from './schema.ts';
export * from './telemetry.ts';
export * from './deterministic.ts';
export * from './model-client.ts';
export * from './prompts.ts';
export * from './protection.ts';
export * from './budget.ts';
export * from './classifier.ts';

export * from './eval/metrics.ts';
export * from './eval/capture.ts';
export * from './eval/error-analysis.ts';
export * from './eval/golden-set.ts';
export * from './eval/runner.ts';
