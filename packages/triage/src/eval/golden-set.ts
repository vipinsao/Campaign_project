import { type Db, query } from '@campaign/core';
import type { FailureTaxonomy, OpenCode } from './error-analysis.ts';
import type { Trace } from './capture.ts';

/**
 * The golden set  (V4, step three of four).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The golden set is the OUTPUT of error analysis, not its input. Every function
 * in this file takes labelled traces or a taxonomy and produces cases; there is
 * deliberately no `createGoldenCase(body, label)` that lets somebody invent one
 * from nothing, because that is the door through which an imagined set walks in.
 *
 * Every case carries the failure mode it came from and the trace it was derived
 * from, in `eval_cases.notes`. Six months later, "why is this in the golden set?"
 * has an answer, and a case whose failure mode has since been designed out can be
 * retired on purpose rather than lingering as a test nobody dares delete.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type GoldenCase = {
  readonly id: string;
  readonly dataset: string;
  readonly inputBody: string;
  readonly expectedLabel: string;
  readonly notes: string | null;
};

export async function loadGoldenSet(db: Db, dataset: string): Promise<GoldenCase[]> {
  const rows = await query<{
    id: string;
    dataset: string;
    input_body: string;
    expected_label: string;
    notes: string | null;
  }>(
    db,
    `SELECT id, dataset, input_body, expected_label, notes
       FROM eval_cases WHERE dataset = $1 ORDER BY created_at ASC, id ASC`,
    [dataset],
  );
  return rows.map((row) => ({
    id: row.id,
    dataset: row.dataset,
    inputBody: row.input_body,
    expectedLabel: row.expected_label,
    notes: row.notes,
  }));
}

export type PromotableCase = {
  readonly inputBody: string;
  readonly expectedLabel: string;
  readonly notes: string;
};

/**
 * Turn open-coded traces into golden cases.
 *
 * Only traces the annotator marked WRONG and gave an expected label for are
 * promoted. Correct traces are excluded on purpose: a golden set padded with cases
 * the model already gets right inflates every score it will ever produce, and
 * makes a regression on the hard cases arithmetically invisible. The set is a
 * record of where the system failed, not a sample of its inbox.
 */
export function promotableFromCoding(
  traces: readonly Trace[],
  notes: readonly OpenCode[],
  taxonomy: FailureTaxonomy,
): PromotableCase[] {
  const byHash = new Map(traces.map((trace) => [trace.bodyHash, trace]));
  const modeOf = new Map<string, string>();
  for (const code of taxonomy.codes) {
    for (const hash of code.traceHashes) modeOf.set(hash, code.name);
  }

  const out: PromotableCase[] = [];
  for (const note of notes) {
    if (note.correct) continue;
    const expected = note.expectedLabel;
    const trace = byHash.get(note.traceHash);
    if (expected === undefined || !trace) continue;
    out.push({
      inputBody: trace.body,
      expectedLabel: expected,
      notes:
        `failure mode: ${modeOf.get(note.traceHash) ?? 'unclassified'}; ` +
        `open code (${note.annotator}): ${note.note}; ` +
        `derived from trace ${note.traceHash.slice(0, 12)}`,
    });
  }
  return out;
}

/**
 * Insert cases into the golden set.
 *
 * `ON CONFLICT DO NOTHING` on (dataset, input_body): the same reply body surfacing
 * a second time in a later round of error analysis is not a second case, and
 * silently duplicating it would double that example's weight in every metric.
 */
export async function promoteToGoldenSet(
  db: Db,
  dataset: string,
  cases: readonly PromotableCase[],
): Promise<{ readonly inserted: number; readonly skipped: number }> {
  let inserted = 0;
  for (const golden of cases) {
    const rows = await query<{ id: string }>(
      db,
      `INSERT INTO eval_cases (dataset, input_body, expected_label, notes)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (dataset, input_body) DO NOTHING
       RETURNING id`,
      [dataset, golden.inputBody, golden.expectedLabel, golden.notes],
    );
    if (rows.length > 0) inserted += 1;
  }
  return { inserted, skipped: cases.length - inserted };
}

/**
 * A content-addressed version for the golden set.
 *
 * `eval_runs.dataset_version` records WHICH set a score was measured against.
 * Comparing today's 0.91 against last month's 0.88 is meaningless if six cases
 * were added in between, and a version derived from the contents makes that
 * mistake impossible to make by accident: the version simply differs.
 */
export function datasetVersion(cases: readonly GoldenCase[]): string {
  const material = cases
    .map((golden) => `${golden.expectedLabel} ${golden.inputBody}`)
    .sort()
    .join('');
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${cases.length}-${hash.toString(16).padStart(8, '0')}`;
}
