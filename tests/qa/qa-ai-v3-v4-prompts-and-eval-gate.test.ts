/**
 * QA / ADVERSARIAL — V3 (prompt immutability) and V4 (the eval gate).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * (10) CAN `baseline_metrics` EVER BE WRITTEN AFTER INSERT? — VERDICT: SAFE.
 *      No, by two independent mechanisms, and the column really is the trap the
 *      package's own report calls it:
 *        - `prompts_append_only` refuses the UPDATE at the database;
 *        - adding `baseline:` to the front matter changes the file, which changes
 *          the content hash, which makes `syncPrompts` throw
 *          `PromptEditedInPlaceError`.
 *      So a version that shipped without a baseline can NEVER acquire one. The
 *      only route is a new version number, which is the intended answer.
 *
 * (11) CAN A REGRESSION BE MADE TO PASS? — VERDICT: BROKEN. Three ways.
 *
 *      (a) PRUNE THE GOLDEN SET. `eval_cases` has NO append-only trigger — unlike
 *          `prompts`, `contact_consents`, `campaign_versions`, `message_events` and
 *          `send_decisions`, all of which have one. Delete the eleven cases v2 gets
 *          wrong and v2 goes from FAIL to PASS with a clean exit code. The runner
 *          records `dataset_version` faithfully and then never compares it to
 *          anything: the baseline in v1's front matter is an absolute number that
 *          is applied to whatever set happens to be loaded. There is no record
 *          anywhere of which dataset version the baseline was measured against,
 *          so "0.80 accuracy" and "0.80 accuracy on a different 13 cases" are
 *          indistinguishable to the gate.
 *
 *          The existing suite comes within one line of catching this: it asserts
 *          `rows[0].dataset_version === rows[1].dataset_version` for two runs in
 *          the same test. Nothing asserts it across a git history, and the gate
 *          itself does not look at the column at all.
 *
 *      (b) HAND THE RUNNER ITS OWN CASES. `runEval(deps, { dataset, cases })`
 *          takes an optional case list that bypasses `loadGoldenSet` entirely.
 *          The `dataset` string is still recorded as the provenance, so a run
 *          over thirteen hand-picked cases is stored under the same name as the
 *          real set.
 *
 *      (c) RENAME THE PROMPT. `regressionBaseline` looks for an earlier version
 *          OF THE SAME NAME; failing that it falls back to the prompt's OWN
 *          declared baseline. A new lineage therefore gets to declare the bar it
 *          is judged against — which is precisely the failure prompts.ts says it
 *          prevents ("a version that gets to declare its own bar can always
 *          declare one it clears"). It prevents it within a lineage only.
 *
 *      All three are things a person does on the afternoon the build is red, and
 *      none of them looks like tampering in a diff.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { FakeClock } from '@campaign/core';
import { seedTenant } from '../support/fixtures.ts';
import {
  contentHash,
  evalExitCode,
  fixtureKey,
  getPrompt,
  loadGoldenSet,
  MockModelClient,
  promoteToGoldenSet,
  PromptEditedInPlaceError,
  regressionBaseline,
  renderEvalReport,
  runEval,
  syncPrompts,
  type ModelFixture,
  type PromotableCase,
} from '@campaign/triage';

afterAll(closeTestDb);
beforeEach(resetDb);

const CORPUS = fileURLToPath(
  new URL('../../packages/triage/fixtures/golden-corpus.json', import.meta.url),
);
const PROMPTS_DIR = fileURLToPath(
  new URL('../../packages/triage/prompts', import.meta.url),
);
const DATASET = 'reply-classification';
const CLOCK = '2026-08-25T10:00:00.000Z';

type CorpusCase = {
  body: string;
  expectedLabel: string;
  notes: string;
  v1: { label: string; confidence: number; urgency: string };
  v2: { label: string; confidence: number; urgency: string };
};

async function corpus(): Promise<CorpusCase[]> {
  return (JSON.parse(await readFile(CORPUS, 'utf8')) as { cases: CorpusCase[] }).cases;
}

async function seedGoldenSet(): Promise<number> {
  const cases: PromotableCase[] = (await corpus()).map((c) => ({
    inputBody: c.body,
    expectedLabel: c.expectedLabel,
    notes: c.notes,
  }));
  const { inserted } = await promoteToGoldenSet(testDb(), DATASET, cases);
  return inserted;
}

describe('QA/V3 — baseline_metrics after insert', () => {
  it('SAFE: the append-only trigger refuses an UPDATE of baseline_metrics', async () => {
    const db = testDb();
    await syncPrompts(db);
    await expect(
      db.query(
        `UPDATE prompts SET baseline_metrics = '{"accuracy":0.1,"macroF1":0.1}'::jsonb
          WHERE name = $1 AND version = 2`,
        [DATASET],
      ),
    ).rejects.toThrow(/append-only/);

    // v2 still has none, which is what makes it inherit v1's bar.
    const v2 = (await getPrompt(db, DATASET, 2))!;
    expect(v2.baselineMetrics).toBeUndefined();
  });

  it('SAFE: adding a baseline to a shipped version is caught as an in-place edit', async () => {
    const db = testDb();
    await syncPrompts(db);

    const dir = await mkdtemp(path.join(tmpdir(), 'qa-prompts-'));
    await mkdir(path.join(dir, DATASET), { recursive: true });
    // v1 verbatim, so it verifies.
    const v1 = await readFile(path.join(PROMPTS_DIR, DATASET, 'v1.md'), 'utf8');
    await writeFile(path.join(dir, DATASET, 'v1.md'), v1, 'utf8');
    // v2 with a comfortable, self-serving bar bolted on.
    const v2 = await readFile(path.join(PROMPTS_DIR, DATASET, 'v2.md'), 'utf8');
    const tampered = v2.replace(
      'schema: reply-classification',
      'schema: reply-classification\nbaseline: {"accuracy":0.10,"macroF1":0.10}',
    );
    expect(tampered).not.toBe(v2);
    await writeFile(path.join(dir, DATASET, 'v2.md'), tampered, 'utf8');

    await expect(syncPrompts(db, dir)).rejects.toBeInstanceOf(PromptEditedInPlaceError);
  });

  it('SAFE: the column is therefore write-once, at insert, from the file', async () => {
    const db = testDb();
    await syncPrompts(db);
    const { rows } = await db.query<{ version: number; baseline_metrics: unknown }>(
      `SELECT version, baseline_metrics FROM prompts WHERE name = $1 ORDER BY version`,
      [DATASET],
    );
    expect(rows.map((r) => r.baseline_metrics !== null)).toEqual([true, false]);
    // And a DELETE-then-reinsert is not available either.
    await expect(db.query(`DELETE FROM prompts WHERE version = 2`)).rejects.toThrow(/append-only/);
  });
});

describe('QA/V4 — making a regression pass the gate', () => {
  it('baseline: v2 fails the gate on the real golden set', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK);
    const tenantId = await seedTenant(db);
    await syncPrompts(db);
    expect(await seedGoldenSet()).toBe(24);

    const v2 = (await getPrompt(db, DATASET, 2))!;
    const model = await MockModelClient.fromDisk();
    const run = await runEval({ db, clock, tenantId, prompt: v2, model }, { dataset: DATASET });

    expect(run.passed, renderEvalReport(run)).toBe(false);
    expect(evalExitCode(run)).toBe(1);
  });

  it('FINDING (a): deleting the cases v2 gets wrong turns the FAIL into a PASS', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK);
    const tenantId = await seedTenant(db);
    await syncPrompts(db);
    await seedGoldenSet();

    const v2 = (await getPrompt(db, DATASET, 2))!;
    const model = await MockModelClient.fromDisk();

    const before = await runEval({ db, clock, tenantId, prompt: v2, model }, { dataset: DATASET });
    expect(before.passed).toBe(false);

    // `eval_cases` has no append-only trigger. This is a plain DELETE, and it is
    // exactly the shape of a "retire some flaky cases" pull request.
    const wrong = (await corpus()).filter((c) => c.v2.label !== c.expectedLabel);
    expect(wrong).toHaveLength(11);
    const { rowCount } = await db.query(
      `DELETE FROM eval_cases WHERE dataset = $1 AND input_body = ANY($2::text[])`,
      [DATASET, wrong.map((c) => c.body)],
    );
    expect(rowCount).toBe(11);
    expect(await loadGoldenSet(db, DATASET)).toHaveLength(13);

    const after = await runEval({ db, clock, tenantId, prompt: v2, model }, { dataset: DATASET });

    // Same prompt. Same baseline. Green build.
    expect(after.passed, renderEvalReport(after)).toBe(true);
    expect(evalExitCode(after), 'the merge is no longer blocked').toBe(0);
    expect(after.metrics.accuracy).toBeGreaterThan(before.metrics.accuracy);
    expect(after.failures).toEqual([]);

    // The dataset version changed and NOTHING looked at it.
    const { rows } = await db.query<{ dataset_version: string; passed: boolean }>(
      `SELECT dataset_version, passed FROM eval_runs ORDER BY ran_at, id`,
    );
    expect(rows.map((r) => r.passed)).toEqual([false, true]);
    expect(rows[0]!.dataset_version).not.toBe(rows[1]!.dataset_version);
    expect(rows[0]!.dataset_version).toMatch(/^reply-classification@24-/);
    expect(rows[1]!.dataset_version).toMatch(/^reply-classification@13-/);
    // The bar it was compared against records no dataset version of its own, so
    // there is nothing the runner could have compared it to.
    const baseline = await regressionBaseline(db, v2);
    expect(baseline).toBeDefined();
    expect(Object.keys(baseline!).sort()).toEqual(['accuracy', 'macroF1', 'perLabel']);
    expect(JSON.stringify(baseline)).not.toMatch(/dataset/i);
  });

  it('FINDING (b): `runEval({ cases })` bypasses the stored golden set entirely', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK);
    const tenantId = await seedTenant(db);
    await syncPrompts(db);
    await seedGoldenSet();

    const v2 = (await getPrompt(db, DATASET, 2))!;
    const model = await MockModelClient.fromDisk();
    const stored = await loadGoldenSet(db, DATASET);
    const winners = new Set((await corpus()).filter((c) => c.v2.label === c.expectedLabel).map((c) => c.body));

    const run = await runEval(
      { db, clock, tenantId, prompt: v2, model },
      { dataset: DATASET, cases: stored.filter((c) => winners.has(c.inputBody)) },
    );

    expect(run.passed).toBe(true);
    expect(evalExitCode(run)).toBe(0);
    // The 24 real cases are still sitting untouched in the table, so the tamper is
    // invisible to anyone inspecting the data.
    expect(await loadGoldenSet(db, DATASET)).toHaveLength(24);
    // And the run is filed under the real dataset name.
    const { rows } = await db.query<{ dataset_version: string }>(
      `SELECT dataset_version FROM eval_runs`,
    );
    expect(rows[0]!.dataset_version).toMatch(/^reply-classification@13-/);
  });

  it('FINDING (c): renaming the prompt lets it declare the bar it is judged against', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK);
    const tenantId = await seedTenant(db);
    await syncPrompts(db);
    await seedGoldenSet();

    // The v2 body, verbatim, under a new lineage name with a bar it clears.
    const v2File = await readFile(path.join(PROMPTS_DIR, DATASET, 'v2.md'), 'utf8');
    const renamed = 'reply-triage';
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-prompts-'));
    await mkdir(path.join(dir, renamed), { recursive: true });
    await writeFile(
      path.join(dir, renamed, 'v1.md'),
      v2File.replace(
        'schema: reply-classification',
        'schema: reply-classification\nbaseline: {"accuracy":0.50,"macroF1":0.40}',
      ),
      'utf8',
    );
    const [fresh] = await syncPrompts(db, dir);
    expect(fresh!.name).toBe(renamed);

    // `regressionBaseline` finds no earlier version of THIS name and falls back to
    // the prompt's own declaration.
    const bar = await regressionBaseline(db, fresh!);
    expect(bar).toEqual({ accuracy: 0.5, macroF1: 0.4 });

    // Fixtures are keyed on the prompt NAME, so re-key the recorded v2 answers.
    const disk = JSON.parse(
      await readFile(
        fileURLToPath(new URL('../../packages/triage/fixtures/model-responses.json', import.meta.url)),
        'utf8',
      ),
    ) as Record<string, ModelFixture>;
    const rekeyed: Record<string, ModelFixture> = {};
    for (const c of await corpus()) {
      const from = disk[fixtureKey({ promptName: DATASET, promptVersion: 2, inputHash: contentHash(c.body) })];
      if (!from) continue;
      rekeyed[fixtureKey({ promptName: renamed, promptVersion: 1, inputHash: contentHash(c.body) })] = from;
    }
    expect(Object.keys(rekeyed).length).toBeGreaterThan(15);

    const run = await runEval(
      { db, clock, tenantId, prompt: fresh!, model: new MockModelClient({ fixtures: rekeyed }) },
      { dataset: DATASET },
    );

    // Same words that failed as v2, now green, because the lineage restarted.
    expect(run.metrics.accuracy).toBeLessThan(0.8);
    expect(run.passed, renderEvalReport(run)).toBe(true);
    expect(evalExitCode(run)).toBe(0);
  });

  it('SAFE: the three defences that DO hold', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK);
    const tenantId = await seedTenant(db);
    await syncPrompts(db);
    const v2 = (await getPrompt(db, DATASET, 2))!;
    const model = await MockModelClient.fromDisk();

    // 1. An empty golden set is refused rather than scored as perfect.
    await expect(
      runEval({ db, clock, tenantId, prompt: v2, model }, { dataset: DATASET }),
    ).rejects.toThrow(/is empty/);

    // 2. Cases that throw are counted as WRONG, not skipped. Wipe the fixtures and
    //    every case errors; the run scores zero rather than 100% of nothing.
    await seedGoldenSet();
    const blind = await runEval(
      { db, clock, tenantId, prompt: v2, model: new MockModelClient({ fixtures: {} }) },
      { dataset: DATASET },
    );
    expect(blind.errored.length).toBeGreaterThan(15);
    expect(blind.metrics.total).toBe(24);
    expect(blind.passed).toBe(false);

    // 3. macro-F1 averages over ALL labels including zero-support ones, so a
    //    golden set that quietly loses a hard class cannot inflate the average.
    expect(Object.keys(blind.metrics.perLabel).sort()).toEqual([
      'complaint',
      'opt_out',
      'other',
      'positive',
      'question',
    ]);
  });
});
