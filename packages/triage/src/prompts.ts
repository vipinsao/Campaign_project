import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Db, query, queryOne } from '@campaign/core';
import { isOutputSchemaName, jsonSchemaFor, type OutputSchemaName } from './schema.ts';

/**
 * Versioned prompts  (V3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The file on disk is the source of truth. The `prompts` table is a synced,
 * content-addressed index of it, and migrations/0009_triage.sql puts an
 * append-only trigger on that table so the database itself refuses UPDATE and
 * DELETE.
 *
 * A changed prompt is a NEW VERSION, never an edit, and the failure that prevents
 * is the most common one in this whole area: three weeks after a prompt was
 * tweaked, complaint recall is down, and nobody can say what the prompt said when
 * the last good eval ran. `classifications.prompt_id` points at an immutable row;
 * `model_calls.prompt_id` does too. "It worked last week" has an answer, and the
 * answer is a row you can SELECT.
 *
 * `syncPrompts` does not merely insert — it VERIFIES. If a file's hash differs
 * from the hash already stored under the same (name, version), that is an
 * in-place edit and it throws. Without that check the append-only trigger would
 * still be satisfied (nothing tried to UPDATE) while the file and the row silently
 * disagreed, which is worse than either alone: you would have a version number
 * that means two different prompts depending on when you asked.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));

export type PromptFile = {
  readonly name: string;
  readonly version: number;
  readonly modelId: string;
  readonly schemaName: OutputSchemaName;
  /** The bar this version must clear in CI (V4), declared in the file's front matter. */
  readonly baselineMetrics: BaselineMetrics | undefined;
  /** The complete file, front matter included. What gets hashed. */
  readonly content: string;
  /** The instruction text below the front matter. What gets sent. */
  readonly body: string;
  readonly contentHash: string;
};

export type PromptRecord = PromptFile & {
  readonly id: string;
  readonly outputSchema: Record<string, unknown>;
};

/**
 * The bar a prompt version has to clear before it can ship (V4).
 *
 * It lives in the prompt's own front matter, and that placement is load-bearing.
 * `prompts` is append-only, so there is no UPDATE path that could raise or lower
 * the bar after the fact — the only way to change a threshold is to open a pull
 * request that changes a file, where a reviewer can see the prompt edit and the
 * loosened threshold in the same diff. A bar stored anywhere mutable gets quietly
 * lowered on the afternoon the build is red.
 *
 * `perLabel` recall floors are the part that matters. A single accuracy number
 * cannot fail a change that trades away complaint recall for gains on the majority
 * label, and that trade is the most common way a prompt "improves" while getting
 * worse at the only job anybody cared about.
 */
export type BaselineMetrics = {
  readonly accuracy: number;
  readonly macroF1: number;
  readonly perLabel?: Readonly<Record<string, { readonly precision?: number; readonly recall?: number }>>;
};

export class PromptEditedInPlaceError extends Error {
  constructor(name: string, version: number) {
    super(
      `Prompt '${name}' v${version} was edited in place: the file no longer hashes to ` +
        `the content already recorded in the prompts table. A changed prompt is a new ` +
        `version — add v${version + 1}.md instead. Otherwise every classification, ` +
        `model_call and eval_run already pointing at v${version} now cites a prompt ` +
        `that never produced them.`,
    );
    this.name = 'PromptEditedInPlaceError';
  }
}

/**
 * Front matter is two keys and no YAML parser, deliberately.
 *
 * `model` lives in the prompt file rather than in code because the model id is part
 * of the behaviour being versioned: the same words sent to a different model are a
 * different prompt, and pinning them together means an eval_runs row identifies
 * both at once.
 */
function parseFrontMatter(raw: string, file: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match?.[1]) {
    throw new Error(`${file}: missing front matter. Expected '---' then 'model:' and 'schema:'.`);
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.+?)\s*$/.exec(line);
    if (kv?.[1] !== undefined && kv[2] !== undefined) fields[kv[1]] = kv[2];
  }
  return { fields, body: raw.slice(match[0].length).trim() };
}

export function parsePromptFile(name: string, version: number, raw: string, file: string): PromptFile {
  const { fields, body } = parseFrontMatter(raw, file);
  const modelId = fields['model'];
  const schemaName = fields['schema'];
  const baselineRaw = fields['baseline'];
  if (!modelId) throw new Error(`${file}: front matter is missing 'model'.`);
  if (!schemaName) throw new Error(`${file}: front matter is missing 'schema'.`);
  if (!isOutputSchemaName(schemaName)) {
    throw new Error(
      `${file}: unknown output schema '${schemaName}'. Schemas are registered in ` +
        `packages/triage/src/schema.ts so the prompt and the parser cannot disagree.`,
    );
  }
  let baselineMetrics: BaselineMetrics | undefined;
  if (baselineRaw !== undefined) {
    try {
      baselineMetrics = JSON.parse(baselineRaw) as BaselineMetrics;
    } catch {
      throw new Error(`${file}: 'baseline' front matter is not valid JSON: ${baselineRaw}`);
    }
  }

  return {
    name,
    version,
    modelId,
    schemaName,
    baselineMetrics,
    content: raw,
    body,
    // The WHOLE file, front matter included: changing the model id changes the
    // behaviour, so it has to change the hash.
    contentHash: createHash('sha256').update(raw, 'utf8').digest('hex'),
  };
}

/** Every prompt version on disk, ordered by name then version. */
export async function readPromptFiles(dir = PROMPTS_DIR): Promise<PromptFile[]> {
  const out: PromptFile[] = [];
  const names = await readdir(dir, { withFileTypes: true });
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const versionDir = path.join(dir, entry.name);
    for (const file of await readdir(versionDir)) {
      const match = /^v(\d+)\.md$/.exec(file);
      if (!match?.[1]) continue;
      const full = path.join(versionDir, file);
      out.push(parsePromptFile(entry.name, Number(match[1]), await readFile(full, 'utf8'), full));
    }
  }
  return out.sort((a, b) => (a.name === b.name ? a.version - b.version : a.name < b.name ? -1 : 1));
}

type PromptRow = {
  id: string;
  name: string;
  version: number;
  content: string;
  content_hash: string;
  model_id: string;
  output_schema: Record<string, unknown>;
  baseline_metrics: BaselineMetrics | null;
};

function toRecord(row: PromptRow, file: PromptFile): PromptRecord {
  return { ...file, id: row.id, outputSchema: row.output_schema };
}

/**
 * Re-parse the stored content rather than re-reading the file.
 *
 * The row is the authority for what was actually SENT. Reading v1.md off disk to
 * describe a classification made months ago would describe today's v1.md, which is
 * the exact confusion versioning exists to remove.
 */
function hydrate(row: PromptRow | undefined, dir: string): PromptRecord | undefined {
  if (!row) return undefined;
  const file = parsePromptFile(row.name, row.version, row.content, `${dir}/${row.name}/v${row.version}.md`);
  return toRecord(row, file);
}

/**
 * Sync the files on disk into the table, and refuse to proceed if any of them has
 * been edited under an existing version number.
 */
export async function syncPrompts(db: Db, dir = PROMPTS_DIR): Promise<PromptRecord[]> {
  const files = await readPromptFiles(dir);
  const records: PromptRecord[] = [];

  for (const file of files) {
    const existing = await queryOne<PromptRow>(
      db,
      `SELECT id, name, version, content, content_hash, model_id, output_schema, baseline_metrics
         FROM prompts WHERE name = $1 AND version = $2`,
      [file.name, file.version],
    );

    if (existing) {
      if (existing.content_hash !== file.contentHash) {
        throw new PromptEditedInPlaceError(file.name, file.version);
      }
      records.push(toRecord(existing, file));
      continue;
    }

    const inserted = await queryOne<PromptRow>(
      db,
      `INSERT INTO prompts (name, version, content, content_hash, model_id, output_schema, baseline_metrics)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, version, content, content_hash, model_id, output_schema, baseline_metrics`,
      [
        file.name,
        file.version,
        file.content,
        file.contentHash,
        file.modelId,
        JSON.stringify(jsonSchemaFor(file.schemaName)),
        file.baselineMetrics === undefined ? null : JSON.stringify(file.baselineMetrics),
      ],
    );
    if (!inserted) throw new Error(`Failed to insert prompt ${file.name} v${file.version}.`);
    records.push(toRecord(inserted, file));
  }

  return records;
}

const SELECT_PROMPT = `SELECT id, name, version, content, content_hash, model_id, output_schema, baseline_metrics
   FROM prompts`;

export async function getPrompt(
  db: Db,
  name: string,
  version: number,
  dir = PROMPTS_DIR,
): Promise<PromptRecord | undefined> {
  return hydrate(await queryOne<PromptRow>(db, `${SELECT_PROMPT} WHERE name = $1 AND version = $2`, [name, version]), dir);
}

export async function getLatestPrompt(db: Db, name: string, dir = PROMPTS_DIR): Promise<PromptRecord | undefined> {
  return hydrate(
    await queryOne<PromptRow>(db, `${SELECT_PROMPT} WHERE name = $1 ORDER BY version DESC LIMIT 1`, [name]),
    dir,
  );
}

export async function listPrompts(db: Db, name: string, dir = PROMPTS_DIR): Promise<PromptRecord[]> {
  const rows = await query<PromptRow>(db, `${SELECT_PROMPT} WHERE name = $1 ORDER BY version ASC`, [name]);
  const out: PromptRecord[] = [];
  for (const row of rows) {
    const record = hydrate(row, dir);
    if (record) out.push(record);
  }
  return out;
}

export function promptSummary(record: PromptRecord): string {
  return `${record.name} v${record.version} (${record.modelId}, ${record.contentHash.slice(0, 12)})`;
}

/**
 * The bar a version is actually judged against  (V4).
 *
 * It is the baseline carried by the most recent EARLIER version that declares one
 * — not the version's own. A new prompt version must be at least as good as the
 * one it is replacing, which is the only comparison that catches a regression: a
 * version that gets to declare its own bar can always declare one it clears, and
 * that is how "all evals green" and "complaint recall fell twenty points" end up
 * being true at the same time.
 *
 * v1 is the only version in this repository that declares a baseline. v2 is
 * deliberately worse, inherits v1's bar, and fails it — which is the demonstration.
 */
export async function regressionBaseline(db: Db, prompt: PromptRecord): Promise<BaselineMetrics | undefined> {
  const earlier = await query<PromptRow>(
    db,
    `${SELECT_PROMPT} WHERE name = $1 AND version < $2 AND baseline_metrics IS NOT NULL
      ORDER BY version DESC LIMIT 1`,
    [prompt.name, prompt.version],
  );
  const previous = earlier[0];
  if (previous?.baseline_metrics) return previous.baseline_metrics;
  return prompt.baselineMetrics;
}
