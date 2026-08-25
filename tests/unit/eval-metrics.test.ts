/**
 * Evaluation metrics, checked against a confusion matrix worked out by hand.
 *
 * The numbers below were computed on paper before the code was written, and that
 * order matters. A metrics implementation tested against its own output is a
 * tautology: it will confirm whatever averaging convention it happens to use,
 * including the wrong one. The distinctions this file pins down — macro versus
 * micro, whether zero-support labels count, whether an unparseable output is a
 * wrong answer or an excluded row — are all invisible until a number is written
 * down independently and compared.
 */
import { describe, it, expect } from 'vitest';
import { compareToBaseline, computeMetrics, type Prediction } from '@campaign/triage';

const LABELS = ['question', 'complaint', 'opt_out', 'positive', 'other'] as const;

/** Build `count` predictions of (expected, predicted). */
function rows(count: number, expected: string, predicted: string | null): Prediction[] {
  return Array.from({ length: count }, () => ({ expected, predicted }));
}

/**
 * The worked example.
 *
 *                          predicted
 *                 question complaint opt_out positive other   | support
 *   question          8         2        0        0       0   |   10
 *   complaint         3         6        0        0       1   |   10
 *   opt_out           0         0        4        0       1   |    5
 *   positive          0         0        0        9       1   |   10
 *   other             1         0        0        2       2   |    5
 *                                                              -------
 *                                                                 40
 *
 * correct = 8 + 6 + 4 + 9 + 2 = 29,  accuracy = 29/40 = 0.725
 *
 *   question:  TP 8, FP 3+0+0+1 = 4,  FN 2      P = 8/12 = 0.6667  R = 0.8     F1 = 0.72727…
 *   complaint: TP 6, FP 2,            FN 4      P = 6/8  = 0.75    R = 0.6     F1 = 0.66667
 *   opt_out:   TP 4, FP 0,            FN 1      P = 1.0            R = 0.8     F1 = 0.88889
 *   positive:  TP 9, FP 0+0+0+2 = 2,  FN 1      P = 9/11 = 0.81818 R = 0.9     F1 = 0.85714
 *   other:     TP 2, FP 1+1+1 = 3,    FN 3      P = 2/5  = 0.4     R = 0.4     F1 = 0.4
 *
 *   macro-F1 = (0.727272… + 0.666666… + 0.888888… + 0.857142… + 0.4) / 5
 *            = 3.539970…/5 = 0.7079941…
 */
const WORKED: Prediction[] = [
  ...rows(8, 'question', 'question'),
  ...rows(2, 'question', 'complaint'),
  ...rows(3, 'complaint', 'question'),
  ...rows(6, 'complaint', 'complaint'),
  ...rows(1, 'complaint', 'other'),
  ...rows(4, 'opt_out', 'opt_out'),
  ...rows(1, 'opt_out', 'other'),
  ...rows(9, 'positive', 'positive'),
  ...rows(1, 'positive', 'other'),
  ...rows(1, 'other', 'question'),
  ...rows(2, 'other', 'positive'),
  ...rows(2, 'other', 'other'),
];

describe('eval metrics', () => {
  const metrics = computeMetrics(WORKED, LABELS);

  it('counts 40 predictions and 29 correct', () => {
    expect(metrics.total).toBe(40);
    expect(metrics.correct).toBe(29);
    expect(metrics.accuracy).toBeCloseTo(0.725, 10);
  });

  it('matches the hand-computed per-label precision and recall', () => {
    expect(metrics.perLabel['question']).toMatchObject({ support: 10, truePositives: 8, falsePositives: 4, falseNegatives: 2 });
    expect(metrics.perLabel['question']!.precision).toBeCloseTo(8 / 12, 10);
    expect(metrics.perLabel['question']!.recall).toBeCloseTo(0.8, 10);
    expect(metrics.perLabel['question']!.f1).toBeCloseTo(0.7272727272727273, 10);

    expect(metrics.perLabel['complaint']!.precision).toBeCloseTo(0.75, 10);
    expect(metrics.perLabel['complaint']!.recall).toBeCloseTo(0.6, 10);
    expect(metrics.perLabel['complaint']!.f1).toBeCloseTo(2 / 3, 10);

    expect(metrics.perLabel['opt_out']!.precision).toBeCloseTo(1, 10);
    expect(metrics.perLabel['opt_out']!.recall).toBeCloseTo(0.8, 10);
    expect(metrics.perLabel['opt_out']!.f1).toBeCloseTo(0.8888888888888888, 10);

    expect(metrics.perLabel['positive']!.precision).toBeCloseTo(9 / 11, 10);
    expect(metrics.perLabel['positive']!.recall).toBeCloseTo(0.9, 10);
    expect(metrics.perLabel['positive']!.f1).toBeCloseTo(0.8571428571428571, 10);

    expect(metrics.perLabel['other']!.precision).toBeCloseTo(0.4, 10);
    expect(metrics.perLabel['other']!.recall).toBeCloseTo(0.4, 10);
    expect(metrics.perLabel['other']!.f1).toBeCloseTo(0.4, 10);
  });

  it('matches the hand-computed macro-F1', () => {
    expect(metrics.macroF1).toBeCloseTo(0.7079941, 6);
    // Macro-F1 is BELOW accuracy here, which is the whole reason to prefer it:
    // the two labels the system exists to catch are dragging the average down and
    // the headline accuracy is hiding it.
    expect(metrics.macroF1).toBeLessThan(metrics.accuracy);
  });

  it('reproduces the confusion matrix cell by cell', () => {
    expect(metrics.confusion['question']!['complaint']).toBe(2);
    expect(metrics.confusion['complaint']!['question']).toBe(3);
    expect(metrics.confusion['other']!['positive']).toBe(2);
    expect(metrics.confusion['opt_out']!['opt_out']).toBe(4);
    expect(metrics.confusion['positive']!['complaint']).toBe(0);
  });

  it('counts a null prediction as wrong rather than excluding the row', () => {
    // A prompt that fails to parse on 20% of inputs must not report 100% on the
    // 80% it managed to answer.
    const withFailures = computeMetrics([...rows(8, 'question', 'question'), ...rows(2, 'question', null)], LABELS);
    expect(withFailures.total).toBe(10);
    expect(withFailures.accuracy).toBeCloseTo(0.8, 10);
    expect(withFailures.perLabel['question']!.falseNegatives).toBe(2);
    expect(withFailures.confusion['question']!['__none__']).toBe(2);
  });

  it('averages over every label, including one with no cases', () => {
    // Dropping empty labels from the macro average silently raises the score
    // whenever the golden set happens not to contain a hard class.
    const onlyTwo = computeMetrics([...rows(5, 'question', 'question'), ...rows(5, 'positive', 'positive')], LABELS);
    expect(onlyTwo.accuracy).toBe(1);
    expect(onlyTwo.macroF1, 'five labels, three of them zero').toBeCloseTo(2 / 5, 10);
  });

  it('reports 0 rather than NaN for a label the classifier never predicted', () => {
    const missed = computeMetrics(rows(4, 'complaint', 'other'), LABELS);
    expect(missed.perLabel['complaint']!.precision).toBe(0);
    expect(missed.perLabel['complaint']!.recall).toBe(0);
    expect(Number.isNaN(missed.macroF1)).toBe(false);
  });

  it('fails a baseline on a per-label floor even when the headline improves', () => {
    // The regression this exists to catch: accuracy up, complaint recall down.
    const comparison = compareToBaseline(metrics, {
      accuracy: 0.7,
      macroF1: 0.65,
      perLabel: { complaint: { recall: 0.85 }, opt_out: { recall: 0.75 } },
    });
    expect(comparison.passed).toBe(false);
    expect(comparison.failures).toHaveLength(1);
    expect(comparison.failures[0]).toMatch(/complaint recall 0\.6000 < baseline 0\.8500/);
  });

  it('passes when every floor is cleared, and names nothing', () => {
    const comparison = compareToBaseline(metrics, {
      accuracy: 0.7,
      macroF1: 0.65,
      perLabel: { complaint: { recall: 0.5 }, opt_out: { recall: 0.75 } },
    });
    expect(comparison).toEqual({ passed: true, failures: [] });
  });

  it('reports a baseline floor for a label the golden set does not cover', () => {
    // Silently passing here would let a class be dropped from the set and its
    // floor go unenforced without anything failing.
    const comparison = compareToBaseline(computeMetrics(rows(3, 'question', 'question'), ['question']), {
      accuracy: 0.5,
      macroF1: 0.5,
      perLabel: { complaint: { recall: 0.8 } },
    });
    expect(comparison.passed).toBe(false);
    expect(comparison.failures[0]).toMatch(/no cases in the golden set/);
  });
});
