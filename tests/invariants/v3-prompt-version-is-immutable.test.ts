/**
 * V3 — A PROMPT VERSION IS IMMUTABLE.
 *
 * Failure it prevents: "it worked last week" with nothing to point at.
 *
 * Prompts drift by edit. Somebody softens a line, complaint recall falls four
 * points, and three weeks later there is no record of what the prompt said when
 * the last good eval ran — so the regression cannot be bisected, reproduced, or
 * even confirmed. Versioning is what makes `classifications.prompt_id` mean
 * something.
 *
 * Two independent mechanisms, asserted separately because either alone leaves a
 * hole:
 *
 *   the database  — an append-only trigger refuses UPDATE and DELETE on `prompts`
 *   the sync      — `syncPrompts` refuses to proceed if a FILE has changed under
 *                   an existing version number
 *
 * Without the second, the trigger is satisfied (nothing tried to UPDATE) while the
 * file and the row silently disagree — which is worse than either failure alone,
 * because the version number now means two different prompts depending on when you
 * asked.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import {
  getPrompt,
  listPrompts,
  PromptEditedInPlaceError,
  readPromptFiles,
  syncPrompts,
} from '@campaign/triage';

afterAll(closeTestDb);
beforeEach(resetDb);

const FRONT_MATTER = '---\nmodel: claude-sonnet-5\nschema: reply-classification\n---\n\n';

async function promptDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ce-prompts-'));
  await mkdir(path.join(root, 'reply-classification'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(
      path.join(root, 'reply-classification', name),
      `${FRONT_MATTER}${body}`,
      'utf8',
    );
  }
  return root;
}

describe('V3 — a prompt version is immutable', () => {
  it('refuses an UPDATE at the database, not just in application code', async () => {
    const db = testDb();
    await syncPrompts(db);
    await expect(
      db.query(
        `UPDATE prompts SET content = 'edited' WHERE name = 'reply-classification' AND version = 1`,
      ),
    ).rejects.toThrow();
  });

  it('refuses a DELETE too, so history cannot be tidied away', async () => {
    const db = testDb();
    await syncPrompts(db);
    await expect(
      db.query(`DELETE FROM prompts WHERE name = 'reply-classification'`),
    ).rejects.toThrow();
  });

  it('throws when a file is edited under an existing version number', async () => {
    const db = testDb();
    const dir = await promptDir({ 'v1.md': 'Classify the reply.' });
    try {
      await syncPrompts(db, dir);
      // The edit that ought to have been v2.
      await writeFile(
        path.join(dir, 'reply-classification', 'v1.md'),
        `${FRONT_MATTER}Classify the reply, and be more decisive.`,
        'utf8',
      );
      await expect(syncPrompts(db, dir)).rejects.toThrow(PromptEditedInPlaceError);
      await expect(syncPrompts(db, dir)).rejects.toThrow(/new version/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts the same file twice — syncing is idempotent, not append-happy', async () => {
    const db = testDb();
    const first = await syncPrompts(db);
    const second = await syncPrompts(db);
    expect(second.map((p) => p.id)).toEqual(first.map((p) => p.id));

    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM prompts`);
    expect(Number(rows[0]!.n)).toBe(first.length);
  });

  it('content-addresses the WHOLE file, so changing the model id is a new version', async () => {
    const dir = await promptDir({ 'v1.md': 'Classify the reply.' });
    try {
      const [before] = await readPromptFiles(dir);
      await writeFile(
        path.join(dir, 'reply-classification', 'v1.md'),
        '---\nmodel: claude-haiku-4-5-20251001\nschema: reply-classification\n---\n\nClassify the reply.',
        'utf8',
      );
      const [after] = await readPromptFiles(dir);
      // Identical instructions, different model. Same words to a different model is
      // a different prompt, so it must not hash the same.
      expect(after!.body).toBe(before!.body);
      expect(after!.contentHash).not.toBe(before!.contentHash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps both shipped versions side by side, which is what the eval harness compares', async () => {
    const db = testDb();
    await syncPrompts(db);
    const versions = await listPrompts(db, 'reply-classification');
    expect(versions.map((p) => p.version)).toEqual([1, 2]);
    expect(versions[0]!.contentHash).not.toBe(versions[1]!.contentHash);

    // v1 carries the bar; v2 deliberately does not, so it inherits v1's and fails it.
    expect(versions[0]!.baselineMetrics).toBeDefined();
    expect(versions[1]!.baselineMetrics).toBeUndefined();
  });

  it('reconstructs an old version from the stored row, not from the file on disk', async () => {
    const db = testDb();
    await syncPrompts(db);
    const v1 = await getPrompt(db, 'reply-classification', 1);
    expect(v1).toBeDefined();
    // The row is the authority for what was SENT. If this read the file, a
    // classification made months ago would be described by today's file.
    const { rows } = await db.query<{ content: string }>(
      `SELECT content FROM prompts WHERE name = 'reply-classification' AND version = 1`,
    );
    expect(v1!.content).toBe(rows[0]!.content);
    expect(v1!.body).toContain('Choose exactly one label');
  });
});
