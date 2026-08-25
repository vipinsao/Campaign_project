import type { Clock } from '@campaign/core';
import { type Db, queryOne } from '@campaign/core';
import { triage, type TriageDeps } from '../classifier.ts';
import { regressionBaseline, type PromptRecord } from '../prompts.ts';
import { ReplyLabel } from '../schema.ts';
import { compareToBaseline, computeMetrics, type EvalMetrics, type Prediction } from './metrics.ts';
import { datasetVersion, loadGoldenSet, type GoldenCase } from './golden-set.ts';

/**
 * The CI gate  (V4, step four of four).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * An eval suite that reports a number is a dashboard. An eval suite that fails the
 * build is a gate. This one is a gate: `runEval` returns `passed: false` when the
 * run falls below the bar the previous prompt version cleared, `evalExitCode`
 * turns that into a non-zero exit, and the merge stops.
 *
 * The difference matters more than it sounds. Prompt regressions are not loud.
 * Nothing throws, nothing 500s, the summaries still read fluently — complaint
 * recall just drops from 0.91 to 0.68 and the review queue quietly stops catching
 * angry customers. Without a gate, that ships, and it is discovered six weeks later
 * by a support lead who noticed the tone of the inbox changed. With a gate, it is
 * discovered by the pull request that caused it.
 *
 * The run goes through the REAL pipeline (`triage`), not a reimplementation. That
 * means the golden set is exercising the deterministic pass, the cache, the budget
 * check, the schema validation and the confidence gate together — which is what is
 * actually deployed. An eval that calls the model directly and compares labels is
 * measuring the prompt while claiming to measure the system, and it will happily
 * stay green through a bug in the confidence gate.
 *
 * Cost: with MockModelClient replaying recorded fixtures, a full run is free and
 * finishes in milliseconds, which is the property that lets it run on every commit
 * instead of on the branch where somebody remembered.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type EvalRunResult = {
  readonly promptId: string;
  readonly promptName: string;
  readonly promptVersion: number;
  readonly dataset: string;
  readonly datasetVersion: string;
  readonly metrics: EvalMetrics;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly totalCostUsd: number;
  readonly evalRunId: string;
  /** Cases whose model call threw outright. Reported, never silently skipped. */
  readonly errored: readonly { readonly caseId: string; readonly error: string }[];
};

export type EvalDeps = {
  readonly db: Db;
  readonly clock: Clock;
  /** The tenant whose thresholds and budget the run executes under. Evals cost
   *  real tokens the first time, and they are charged to somebody on purpose. */
  readonly tenantId: string;
  readonly prompt: PromptRecord;
  readonly model: TriageDeps['model'];
  readonly gitSha?: string;
};

/**
 * The eval run never touches consent.
 *
 * `triage` only needs a `ProtectionCapability` because `classifyReply` does; the
 * eval path calls `triage` directly and passes a capability that throws. A golden
 * case is not a real person, and an eval run that could write a suppression would
 * be one bad SELECT away from suppressing one.
 */
const refusesToSuppress: TriageDeps['protection'] = {
  addSuppression: () =>
    Promise.reject(
      new Error(
        'An eval run attempted to write a suppression. Golden cases are not people; ' +
          'nothing in src/eval/ may have a consent side effect.',
      ),
    ),
};

export async function runEval(
  deps: EvalDeps,
  opts: { readonly dataset: string; readonly cases?: readonly GoldenCase[] },
): Promise<EvalRunResult> {
  const cases = opts.cases ?? (await loadGoldenSet(deps.db, opts.dataset));
  if (cases.length === 0) {
    throw new Error(
      `Golden set '${opts.dataset}' is empty. It is built by error analysis over real ` +
        `traces (see src/eval/error-analysis.ts), not written by hand — an empty set ` +
        `passing every threshold is the failure mode this refusal exists to prevent.`,
    );
  }

  const triageDeps: TriageDeps = {
    db: deps.db,
    clock: deps.clock,
    model: deps.model,
    prompt: deps.prompt,
    protection: refusesToSuppress,
  };

  const predictions: Prediction[] = [];
  const errored: { caseId: string; error: string }[] = [];
  let totalCostUsd = 0;

  for (const golden of cases) {
    try {
      const outcome = await triage(triageDeps, {
        tenantId: deps.tenantId,
        channel: 'email',
        fromAddress: `eval+${golden.id}@example.invalid`,
        body: golden.inputBody,
      });
      totalCostUsd += outcome.costUsd;
      predictions.push({ expected: golden.expectedLabel, predicted: outcome.label });
    } catch (error) {
      // A case that threw is counted as a WRONG ANSWER, not excluded. Excluding it
      // means a prompt that crashes on 10% of inputs scores 100% on the 90% left.
      errored.push({
        caseId: golden.id,
        error: error instanceof Error ? error.message : String(error),
      });
      predictions.push({ expected: golden.expectedLabel, predicted: null });
    }
  }

  const metrics = computeMetrics(predictions, ReplyLabel.options);
  const baseline = await regressionBaseline(deps.db, deps.prompt);
  const comparison = baseline
    ? compareToBaseline(metrics, baseline)
    : // No recorded baseline means this is the first version of a prompt. It passes
      // and says so, rather than passing silently — "no baseline" and "cleared the
      // baseline" must not look identical in CI output.
      {
        passed: true,
        failures: ['no baseline recorded for this prompt lineage; nothing to regress against'],
      };

  const version = datasetVersion(cases);
  const runId = await recordEvalRun(deps, {
    dataset: opts.dataset,
    datasetVersion: version,
    metrics,
    passed: comparison.passed,
    totalCostUsd,
  });

  return {
    promptId: deps.prompt.id,
    promptName: deps.prompt.name,
    promptVersion: deps.prompt.version,
    dataset: opts.dataset,
    datasetVersion: version,
    metrics,
    passed: comparison.passed,
    failures: comparison.failures,
    totalCostUsd,
    evalRunId: runId,
    errored,
  };
}

/** Every run is recorded, passing or failing. A table of only the good runs cannot
 *  show a trend, which is the one thing a table of eval runs is for. */
async function recordEvalRun(
  deps: EvalDeps,
  run: {
    dataset: string;
    datasetVersion: string;
    metrics: EvalMetrics;
    passed: boolean;
    totalCostUsd: number;
  },
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    deps.db,
    `INSERT INTO eval_runs
       (prompt_id, dataset_version, git_sha, accuracy, macro_f1, per_label, passed, total_cost_usd, ran_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      deps.prompt.id,
      `${run.dataset}@${run.datasetVersion}`,
      deps.gitSha ?? null,
      run.metrics.accuracy,
      run.metrics.macroF1,
      JSON.stringify(run.metrics.perLabel),
      run.passed,
      run.totalCostUsd,
      deps.clock.now(),
    ],
  );
  if (!row) throw new Error('Failed to record an eval_runs row.');
  return row.id;
}

/** 0 or 1. The whole point of the harness reduces to this line. */
export function evalExitCode(result: EvalRunResult): number {
  return result.passed ? 0 : 1;
}

/**
 * A report meant to be read in a CI log by somebody whose build just went red.
 *
 * Per-label rows, not a single score, because "macro-F1 fell" does not tell you
 * what to do and "complaint recall 0.68, was 0.91" does.
 */
export function renderEvalReport(result: EvalRunResult): string {
  const pct = (n: number): string => (n * 100).toFixed(1).padStart(5);
  const lines: string[] = [
    `${result.passed ? 'PASS' : 'FAIL'}  ${result.promptName} v${result.promptVersion}` +
      `  vs ${result.dataset}@${result.datasetVersion}`,
    `      accuracy ${pct(result.metrics.accuracy)}%   macro-F1 ${pct(result.metrics.macroF1)}%` +
      `   n=${result.metrics.total}   cost $${result.totalCostUsd.toFixed(4)}`,
    '',
    '      label        support   precision   recall       F1',
  ];
  for (const [label, m] of Object.entries(result.metrics.perLabel)) {
    lines.push(
      `      ${label.padEnd(12)} ${String(m.support).padStart(7)}   ` +
        `${pct(m.precision)}%   ${pct(m.recall)}%   ${pct(m.f1)}%`,
    );
  }
  if (result.errored.length > 0) {
    lines.push('', `      ${result.errored.length} case(s) threw and were counted as wrong:`);
    for (const e of result.errored.slice(0, 5)) lines.push(`        ${e.caseId}: ${e.error}`);
  }
  if (result.failures.length > 0) {
    lines.push('', result.passed ? '      note:' : '      below baseline:');
    for (const failure of result.failures) lines.push(`        - ${failure}`);
  }
  return lines.join('\n');
}

/**
 * Throw on a regression, for callers (tests, scripts) that would rather have an
 * exception than an exit code.
 */
export function assertNoRegression(result: EvalRunResult): void {
  if (result.passed) return;
  throw new Error(
    `${result.promptName} v${result.promptVersion} is below the baseline its ` +
      `predecessor cleared:\n  - ${result.failures.join('\n  - ')}`,
  );
}
