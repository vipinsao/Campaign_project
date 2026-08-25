/**
 * Evaluation metrics  (V4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Three choices here, each of which is a position rather than a default.
 *
 * 1. MACRO-F1, not accuracy, and not micro-F1.
 *
 *    The label distribution in a real reply inbox is roughly 60% `other`/`positive`
 *    noise, and the labels that pay for the system — `complaint`, `opt_out` — are a
 *    few percent each. A classifier that answers `other` to everything scores
 *    around 0.6 accuracy, and micro-averaged F1 is dominated by the same majority
 *    class. Macro-F1 gives `complaint` the same weight as `other`, so a change that
 *    trades complaint recall for majority-class precision shows up as a fall
 *    instead of a rise.
 *
 * 2. PER-LABEL precision and recall are reported separately, and CI can gate on
 *    them individually.
 *
 *    Precision and recall fail in opposite directions and cost different things.
 *    Low complaint RECALL means angry customers going unanswered. Low complaint
 *    PRECISION means a review queue full of "thanks!" that a human stops reading
 *    carefully. A single F1 averages those two failures into one number that
 *    cannot distinguish them, which is exactly the number you do not want when
 *    deciding whether to ship.
 *
 * 3. NO ROUGE, NO BERTScore, NO 1–5 QUALITY SCALE.
 *
 *    ROUGE and BERTScore measure overlap with a reference string. A summary that
 *    says the opposite of the reference while reusing its nouns scores well; a
 *    correct summary phrased differently scores badly. The number moves, it looks
 *    like a metric, and it is uncorrelated with the only question anyone is asking
 *    — is this right. That is worse than having no metric, because a meaningless
 *    number gets tracked, plotted, and eventually optimised.
 *
 *    Likert scales fail the same way for a different reason: "is this a 3 or a 4"
 *    has no stable answer across two annotators or the same annotator on two days,
 *    so a 0.3-point movement is indistinguishable from drift in the rater. Binary
 *    pass/fail forces the disagreement out into the open where it can be resolved
 *    into a written criterion, which is the artefact you actually wanted.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type LabelMetrics = {
  readonly support: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
};

export type EvalMetrics = {
  readonly total: number;
  readonly correct: number;
  readonly accuracy: number;
  readonly macroF1: number;
  readonly perLabel: Readonly<Record<string, LabelMetrics>>;
  /** Predicted-vs-expected counts. Kept because the confusion PAIRS are what error
   *  analysis reads; a scalar tells you it got worse, the matrix tells you how. */
  readonly confusion: Readonly<Record<string, Readonly<Record<string, number>>>>;
};

export type Prediction = {
  readonly expected: string;
  /** null when the model produced nothing valid. Counted as wrong, never dropped:
   *  silently excluding unparseable outputs is how a prompt that fails 8% of the
   *  time reports 100% accuracy on the 92% it managed to answer. */
  readonly predicted: string | null;
};

const NO_PREDICTION = '__none__';

function divide(numerator: number, denominator: number): number {
  // A label with no predictions has undefined precision. Reporting 0 rather than
  // NaN keeps the macro average computable, and 0 is the honest reading: the
  // classifier found none of them.
  return denominator === 0 ? 0 : numerator / denominator;
}

export function computeMetrics(
  predictions: readonly Prediction[],
  labels: readonly string[],
): EvalMetrics {
  const confusion: Record<string, Record<string, number>> = {};
  for (const expected of labels) {
    const row: Record<string, number> = {};
    for (const predicted of [...labels, NO_PREDICTION]) row[predicted] = 0;
    confusion[expected] = row;
  }

  let correct = 0;
  for (const prediction of predictions) {
    const predicted = prediction.predicted ?? NO_PREDICTION;
    const row = confusion[prediction.expected];
    if (row) row[predicted] = (row[predicted] ?? 0) + 1;
    if (prediction.predicted !== null && prediction.predicted === prediction.expected) correct += 1;
  }

  const perLabel: Record<string, LabelMetrics> = {};
  let f1Sum = 0;
  for (const label of labels) {
    let truePositives = 0;
    let falseNegatives = 0;
    let falsePositives = 0;
    let support = 0;

    for (const prediction of predictions) {
      const predicted = prediction.predicted;
      if (prediction.expected === label) {
        support += 1;
        if (predicted === label) truePositives += 1;
        else falseNegatives += 1;
      } else if (predicted === label) {
        falsePositives += 1;
      }
    }

    const precision = divide(truePositives, truePositives + falsePositives);
    const recall = divide(truePositives, truePositives + falseNegatives);
    const f1 = divide(2 * precision * recall, precision + recall);
    perLabel[label] = {
      support,
      truePositives,
      falsePositives,
      falseNegatives,
      precision,
      recall,
      f1,
    };
    f1Sum += f1;
  }

  return {
    total: predictions.length,
    correct,
    accuracy: divide(correct, predictions.length),
    // Macro: the unweighted mean over labels, INCLUDING labels with zero support.
    // Dropping empty labels from the average silently raises the score whenever the
    // golden set happens not to contain a hard class.
    macroF1: divide(f1Sum, labels.length),
    perLabel,
    confusion,
  };
}

export type BaselineComparison = {
  readonly passed: boolean;
  readonly failures: readonly string[];
};

/**
 * Compare a run against the bar the previous prompt version cleared.
 *
 * Every check is `>=`, and each one is reported independently: a run that improves
 * accuracy while dropping complaint recall below the floor fails, and the failure
 * message names complaint recall rather than saying "below baseline".
 */
export function compareToBaseline(
  metrics: EvalMetrics,
  baseline: {
    readonly accuracy: number;
    readonly macroF1: number;
    readonly perLabel?: Readonly<
      Record<string, { readonly precision?: number; readonly recall?: number }>
    >;
  },
): BaselineComparison {
  const failures: string[] = [];
  const round = (n: number): string => n.toFixed(4);

  if (metrics.accuracy < baseline.accuracy) {
    failures.push(`accuracy ${round(metrics.accuracy)} < baseline ${round(baseline.accuracy)}`);
  }
  if (metrics.macroF1 < baseline.macroF1) {
    failures.push(`macro-F1 ${round(metrics.macroF1)} < baseline ${round(baseline.macroF1)}`);
  }
  for (const [label, floors] of Object.entries(baseline.perLabel ?? {})) {
    const actual = metrics.perLabel[label];
    if (!actual) {
      failures.push(`label '${label}' has a baseline floor but no cases in the golden set`);
      continue;
    }
    if (floors.precision !== undefined && actual.precision < floors.precision) {
      failures.push(
        `${label} precision ${round(actual.precision)} < baseline ${round(floors.precision)}`,
      );
    }
    if (floors.recall !== undefined && actual.recall < floors.recall) {
      failures.push(`${label} recall ${round(actual.recall)} < baseline ${round(floors.recall)}`);
    }
  }

  return { passed: failures.length === 0, failures };
}
