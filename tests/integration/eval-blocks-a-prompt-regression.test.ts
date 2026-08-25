/**
 * V4 — the eval harness is a GATE, not a dashboard.
 *
 * This is the end-to-end demonstration: the same golden set, run against two
 * prompt versions, one of which ships and one of which does not.
 *
 * v2 is deliberately worse in the two ways real prompt regressions are usually
 * worse, neither of which looks like a bug in the diff — the label definitions are
 * gone, and it instructs the model to be over-confident. Nothing about it throws.
 * The summaries still read fluently. What changes is complaint recall and the
 * proportion of wrong answers that clear the confidence gate, and the only thing
 * standing between that and production is this exit code.
 *
 * The whole run replays recorded fixtures through MockModelClient, so it costs
 * nothing and finishes in milliseconds — which is the property that lets it run on
 * every commit rather than on the branch where somebody remembered.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FakeClock } from '@campaign/core';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedTenant } from '../support/fixtures.ts';
import {
  assertNoRegression,
  evalExitCode,
  getPrompt,
  loadGoldenSet,
  MockModelClient,
  promoteToGoldenSet,
  renderEvalReport,
  runEval,
  syncPrompts,
  type PromotableCase,
} from '@campaign/triage';

afterAll(closeTestDb);
beforeEach(resetDb);

const CORPUS = fileURLToPath(
  new URL('../../packages/triage/fixtures/golden-corpus.json', import.meta.url),
);
const DATASET = 'reply-classification';

type CorpusCase = { body: string; expectedLabel: string; notes: string };

async function seedGoldenSet(): Promise<number> {
  const corpus = JSON.parse(await readFile(CORPUS, 'utf8')) as { cases: CorpusCase[] };
  const cases: PromotableCase[] = corpus.cases.map((c) => ({
    inputBody: c.body,
    expectedLabel: c.expectedLabel,
    notes: c.notes,
  }));
  const { inserted } = await promoteToGoldenSet(testDb(), DATASET, cases);
  return inserted;
}

describe('V4 — a prompt regression fails the build', () => {
  it('passes v1 and fails v2 against the same golden set', async () => {
    const db = testDb();
    const clock = new FakeClock('2026-08-25T10:00:00.000Z');
    const tenantId = await seedTenant(db);
    await syncPrompts(db);
    expect(await seedGoldenSet()).toBe(24);

    const cases = await loadGoldenSet(db, DATASET);
    // Every case carries the failure mode that put it there. A golden case with no
    // provenance is a test nobody dares delete six months later.
    expect(cases.every((c) => c.notes?.startsWith('failure mode:'))).toBe(true);

    const v1 = (await getPrompt(db, DATASET, 1))!;
    const v2 = (await getPrompt(db, DATASET, 2))!;
    const model = await MockModelClient.fromDisk();

    const shipped = await runEval({ db, clock, tenantId, prompt: v1, model }, { dataset: DATASET });
    const regressed = await runEval(
      { db, clock, tenantId, prompt: v2, model },
      { dataset: DATASET },
    );

    expect(shipped.errored, renderEvalReport(shipped)).toEqual([]);
    expect(regressed.errored, renderEvalReport(regressed)).toEqual([]);

    expect(shipped.passed, renderEvalReport(shipped)).toBe(true);
    expect(evalExitCode(shipped)).toBe(0);
    expect(shipped.metrics.accuracy).toBeCloseTo(21 / 24, 6);

    expect(regressed.passed, renderEvalReport(regressed)).toBe(false);
    expect(evalExitCode(regressed), 'a non-zero exit is what stops the merge').toBe(1);
    expect(regressed.metrics.accuracy).toBeLessThan(shipped.metrics.accuracy);

    // The failure NAMES what regressed. "below baseline" is not actionable;
    // "complaint recall 0.5000 < baseline 0.7500" is.
    expect(regressed.failures.join('\n')).toMatch(/complaint recall/);
    expect(regressed.failures.join('\n')).toMatch(/accuracy/);
    expect(() => {
      assertNoRegression(regressed);
    }).toThrow(/below the baseline/);
  });

  it('records both runs, passing and failing, so the trend survives', async () => {
    const db = testDb();
    const clock = new FakeClock('2026-08-25T10:00:00.000Z');
    const tenantId = await seedTenant(db);
    await syncPrompts(db);
    await seedGoldenSet();

    const model = await MockModelClient.fromDisk();
    for (const version of [1, 2]) {
      const prompt = (await getPrompt(db, DATASET, version))!;
      await runEval(
        { db, clock, tenantId, prompt, model, gitSha: 'deadbeef' },
        { dataset: DATASET },
      );
    }

    const { rows } = await db.query<{
      passed: boolean;
      accuracy: string;
      macro_f1: string;
      dataset_version: string;
    }>(
      `SELECT r.passed, r.accuracy::text, r.macro_f1::text, r.dataset_version
         FROM eval_runs r JOIN prompts p ON p.id = r.prompt_id
        ORDER BY p.version ASC`,
    );
    expect(
      rows.map((r) => r.passed),
      'a table of only the good runs cannot show a trend',
    ).toEqual([true, false]);
    // Both runs cite the same dataset version, which is what makes the two numbers
    // comparable at all.
    expect(rows[0]!.dataset_version).toBe(rows[1]!.dataset_version);
    expect(Number(rows[0]!.macro_f1)).toBeGreaterThan(Number(rows[1]!.macro_f1));
  });

  it('refuses to score an empty golden set instead of reporting a perfect one', async () => {
    const db = testDb();
    const clock = new FakeClock('2026-08-25T10:00:00.000Z');
    const tenantId = await seedTenant(db);
    await syncPrompts(db);
    const prompt = (await getPrompt(db, DATASET, 1))!;

    await expect(
      runEval(
        { db, clock, tenantId, prompt, model: await MockModelClient.fromDisk() },
        { dataset: 'nothing-here' },
      ),
    ).rejects.toThrow(/empty/i);
  });

  it('never lets an eval run touch consent', async () => {
    const db = testDb();
    const clock = new FakeClock('2026-08-25T10:00:00.000Z');
    const tenantId = await seedTenant(db);
    await syncPrompts(db);
    await seedGoldenSet();
    const prompt = (await getPrompt(db, DATASET, 1))!;

    await runEval(
      { db, clock, tenantId, prompt, model: await MockModelClient.fromDisk() },
      { dataset: DATASET },
    );

    // Golden cases are not people. Several of them are opt-out bodies, and if the
    // eval path could write a suppression it would be one SELECT away from
    // suppressing a real address that happened to match.
    const { rows } = await db.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM suppressions) + (SELECT count(*) FROM contact_consents) AS n`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
