import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Trace } from './capture.ts';

/**
 * Error analysis  (V4, step two of four).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * This file implements a documented qualitative-research workflow — open coding,
 * axial coding, saturation — rather than a metric. That is not decoration. It is
 * the part that decides whether the golden set is worth anything, and it is the
 * part almost every "we have evals" claim is missing.
 *
 *   OPEN CODING. Read one trace. Write, in your own words and with no fixed
 *   vocabulary, what went wrong. "It called the out-of-office a question." "It
 *   read the quoted original email, not the reply." Free text, deliberately: the
 *   moment you offer a dropdown of failure types, every annotator picks the
 *   nearest option and the category you had not thought of never gets recorded.
 *   That category is the entire reason you are doing this.
 *
 *   AXIAL CODING. Having open-coded fifty or so, group the notes into a taxonomy.
 *   Now the vocabulary is allowed to be fixed, because it was DERIVED. Each axial
 *   code has a name, a definition, the open-coded notes underneath it, and a
 *   count — and the count is what turns "the model is sometimes wrong" into "31%
 *   of our errors are quoted-text bleed, and one prompt line fixes all of them".
 *
 *   SATURATION. Keep coding in batches. Track how many NEW codes each batch
 *   produces. When several consecutive batches produce none, you have seen the
 *   shape of the failure distribution and more annotation is not buying
 *   information. Saturation is what makes "we looked at enough traces" a claim
 *   with evidence behind it instead of a feeling about a Tuesday afternoon.
 *
 * The golden set is then built from the taxonomy: cases per failure mode,
 * weighted by how often that mode actually occurs. That is a set derived from
 * observed behaviour. A set written from imagination is a set of the failures you
 * already knew about, which are the ones already handled.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/** One annotator's free-text note about one trace. No taxonomy yet, on purpose. */
export type OpenCode = {
  readonly traceHash: string;
  readonly annotator: string;
  /** Free text. If this field ever becomes an enum, open coding has stopped. */
  readonly note: string;
  /** Binary, not a 1-5 scale. See metrics.ts for why. */
  readonly correct: boolean;
  /** What the trace SHOULD have said, when the annotator is confident enough to say. */
  readonly expectedLabel?: string;
};

/** A failure mode, named after the fact from a cluster of open codes. */
export type AxialCode = {
  readonly id: string;
  readonly name: string;
  readonly definition: string;
  readonly traceHashes: readonly string[];
};

export type FailureTaxonomy = {
  readonly datasetVersion: string;
  readonly tracesReviewed: number;
  readonly codes: readonly AxialCode[];
};

export type Batch = {
  readonly index: number;
  readonly newCodes: readonly string[];
  readonly totalCodesAfter: number;
};

/** Attach notes to traces, dropping notes for traces that are not in the set —
 *  loudly, via the return value, rather than silently. */
export function openCode(
  traces: readonly Trace[],
  notes: readonly OpenCode[],
): { readonly coded: readonly (Trace & { note: OpenCode })[]; readonly orphaned: readonly OpenCode[] } {
  const byHash = new Map(traces.map((trace) => [trace.bodyHash, trace]));
  const coded: (Trace & { note: OpenCode })[] = [];
  const orphaned: OpenCode[] = [];
  for (const note of notes) {
    const trace = byHash.get(note.traceHash);
    if (trace) coded.push({ ...trace, note });
    else orphaned.push(note);
  }
  return { coded, orphaned };
}

/**
 * Group open codes into named failure modes.
 *
 * `assign` is supplied by the person doing the analysis: this function does the
 * bookkeeping, not the thinking. Automating the grouping would be automating the
 * one step whose value is that a human read the words.
 */
export function axialCode(
  notes: readonly OpenCode[],
  definitions: readonly { readonly id: string; readonly name: string; readonly definition: string }[],
  assign: (note: OpenCode) => string | undefined,
  datasetVersion: string,
): FailureTaxonomy {
  const buckets = new Map<string, string[]>(definitions.map((d) => [d.id, []]));
  for (const note of notes) {
    if (note.correct) continue;
    const id = assign(note);
    if (id === undefined) continue;
    const bucket = buckets.get(id);
    if (bucket) bucket.push(note.traceHash);
  }
  return {
    datasetVersion,
    tracesReviewed: notes.length,
    codes: definitions
      .map((d) => ({ ...d, traceHashes: buckets.get(d.id) ?? [] }))
      .sort((a, b) => b.traceHashes.length - a.traceHashes.length),
  };
}

/**
 * How many NEW failure modes each batch of annotation produced.
 *
 * The shape of this curve is the answer to "have we looked at enough traces". It
 * should flatten. If it is still climbing, the taxonomy is incomplete and any
 * golden set built from it is measuring a subset of the real failure distribution.
 */
export function saturationCurve(
  batches: readonly (readonly OpenCode[])[],
  assign: (note: OpenCode) => string | undefined,
): Batch[] {
  const seen = new Set<string>();
  return batches.map((batch, index) => {
    const newCodes: string[] = [];
    for (const note of batch) {
      if (note.correct) continue;
      const id = assign(note);
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      newCodes.push(id);
    }
    return { index, newCodes, totalCodesAfter: seen.size };
  });
}

/**
 * Saturation reached when the last `window` batches produced no new codes.
 *
 * Two consecutive quiet batches is the usual working threshold. Stopping at one is
 * how you convince yourself you are done immediately after a batch that happened
 * to be all "thanks!".
 */
export function hasReachedSaturation(curve: readonly Batch[], window = 2): boolean {
  if (curve.length < window) return false;
  return curve.slice(-window).every((batch) => batch.newCodes.length === 0);
}

/**
 * Render the taxonomy as `failure-taxonomy.md`.
 *
 * A document, checked in, next to the prompts. The percentages are the useful part:
 * they say which prompt edit to make first, and they are the only defensible way to
 * decide how many golden cases each failure mode deserves.
 */
export function renderFailureTaxonomy(taxonomy: FailureTaxonomy): string {
  const totalErrors = taxonomy.codes.reduce((sum, code) => sum + code.traceHashes.length, 0);
  const lines: string[] = [
    '# Failure taxonomy — reply classification',
    '',
    `Dataset version: \`${taxonomy.datasetVersion}\``,
    `Traces open-coded: ${taxonomy.tracesReviewed}`,
    `Errors grouped: ${totalErrors}`,
    '',
    'Derived by open coding real traces (free-text notes, no fixed vocabulary), then',
    'axial coding those notes into the groups below. This file is an OUTPUT of that',
    'process. It was not written in advance, which is the point: a taxonomy invented',
    'up front only contains the failures we had already thought of, and those are the',
    'ones already handled.',
    '',
    '| # | Failure mode | Traces | Share of errors | Definition |',
    '|---|---|---:|---:|---|',
  ];

  taxonomy.codes.forEach((code, index) => {
    const count = code.traceHashes.length;
    const share = totalErrors === 0 ? 0 : Math.round((count / totalErrors) * 100);
    lines.push(`| ${index + 1} | ${code.name} | ${count} | ${share}% | ${code.definition} |`);
  });

  lines.push(
    '',
    '## How this drives the golden set',
    '',
    'Cases are drawn per failure mode in proportion to the share above, so the golden',
    'set has the same shape as the errors actually observed. A set that is uniform',
    'across modes over-weights the rare ones and reports a regression in the common',
    'one as a rounding error.',
    '',
  );
  return lines.join('\n');
}

export async function writeFailureTaxonomy(taxonomy: FailureTaxonomy, file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderFailureTaxonomy(taxonomy), 'utf8');
}

/**
 * WHY THERE IS NO LLM-AS-JUDGE IN THIS PACKAGE.
 *
 * A judge would be easy to add and it would be the most impressive-looking thing
 * in the directory. It is left out on purpose, and the reasoning is the same
 * reasoning the rest of the package runs on.
 *
 * An unvalidated judge is a second unmeasured model sitting in front of the first
 * one. Reporting "the judge says 94%" without knowing the judge's own true-positive
 * and true-negative rate against a held-out human-labelled set is not a
 * measurement — it is a correlated guess, and it is the single most common tell
 * that an eval suite is decorative. If a judge were used here, this file would
 * have to report its TPR and TNR next to every score, and every score would have
 * to be read through them: a judge with 0.80 TNR turns a 5% error rate into a
 * reported 24% one, and a team that does not know that spends a fortnight fixing
 * a model that was fine.
 *
 * The task does not need one. Reply classification is a five-way choice with a
 * ground truth a human can state in two seconds, so the golden set holds the
 * answer directly and `computeMetrics` compares strings. Binary correctness
 * against a human label beats a judge's Likert score for the same reason a unit
 * test beats a code review: it gives the same answer twice.
 *
 * The place a judge would genuinely earn its cost is the DRAFTED REPLY — free text,
 * no single right answer. When that ships, it ships with a held-out set of a
 * few hundred human-labelled drafts, a measured TPR/TNR, and those numbers printed
 * on the eval report. Not before.
 */
export const JUDGE_POLICY = 'no-llm-judge: binary correctness against human labels' as const;
