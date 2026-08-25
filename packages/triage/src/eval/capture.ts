import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock } from '@campaign/core';
import { type Db, query } from '@campaign/core';
import { contentHash } from '../deterministic.ts';
import type { TriageOutcome } from '../classifier.ts';

/**
 * Trace capture  (V4, step one of four).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The order of this directory is the argument it is making.
 *
 *   capture.ts        → error-analysis.ts → golden-set.ts → runner.ts
 *   real traces         open + axial coding   the OUTPUT     CI gate
 *
 * Writing the golden set FIRST — sitting down and inventing forty examples of
 * what you imagine goes wrong — is the thing that marks somebody who has not
 * shipped an LLM feature. It cannot work, for a reason that is structural rather
 * than a matter of effort: an LLM has effectively infinite surface area for
 * failure, so a set assembled from imagination samples the failures you already
 * knew about. Those are, by definition, the ones already handled. The failures
 * that cost money are the ones nobody thought of — the out-of-office
 * auto-responder that quotes the original email back and gets classified from the
 * quoted text; the customer who writes "cancel" meaning cancel an ORDER; the
 * two-topic reply where the complaint is in the second paragraph.
 *
 * None of those are guessable. All of them are visible in twenty minutes of
 * reading real traces. So the traces come first, and the golden set is what error
 * analysis produces — not what it starts from.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DEFAULT_TRACE_DIR = fileURLToPath(new URL('../../traces', import.meta.url));

export type Trace = {
  readonly capturedAt: string;
  readonly tenantId: string;
  readonly replyId: string | null;
  readonly channel: string;
  readonly body: string;
  readonly bodyHash: string;
  readonly promptName: string;
  readonly promptVersion: number;
  readonly label: string | null;
  readonly confidence: number | null;
  readonly status: string;
  readonly decidedBy: string;
  readonly parseStatus: string | null;
  readonly cacheHit: boolean;
  readonly costUsd: number;
  readonly extracted: Record<string, unknown>;
};

export function traceOf(args: {
  readonly clock: Clock;
  readonly tenantId: string;
  readonly replyId: string | null;
  readonly channel: string;
  readonly body: string;
  readonly promptName: string;
  readonly promptVersion: number;
  readonly outcome: TriageOutcome;
}): Trace {
  return {
    capturedAt: args.clock.now().toISOString(),
    tenantId: args.tenantId,
    replyId: args.replyId,
    channel: args.channel,
    body: args.body,
    bodyHash: contentHash(args.body),
    promptName: args.promptName,
    promptVersion: args.promptVersion,
    label: args.outcome.label,
    confidence: args.outcome.confidence,
    status: args.outcome.status,
    decidedBy: args.outcome.decidedBy,
    parseStatus: args.outcome.parseStatus,
    cacheHit: args.outcome.cacheHit,
    costUsd: args.outcome.costUsd,
    extracted: args.outcome.extracted,
  };
}

/** JSONL, appended. A trace file you can `grep`, `wc -l` and `tail -f` while the
 *  worker runs is one that actually gets read; a database table you have to write
 *  a query against is one that gets read once, on the day it is built. */
export async function appendTrace(
  trace: Trace,
  file = path.join(DEFAULT_TRACE_DIR, 'traces.jsonl'),
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(trace)}\n`, 'utf8');
}

export async function loadTraces(
  file = path.join(DEFAULT_TRACE_DIR, 'traces.jsonl'),
): Promise<Trace[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Trace);
}

/**
 * Pull traces back out of the database for a tenant that has been running.
 *
 * Deliberately biased towards the interesting rows. Sampling uniformly from a
 * production stream gives you two hundred variations of "thanks!", which teaches
 * you nothing and burns the annotation budget that error analysis actually needs.
 * `needs_review`, escalations and low-confidence answers are where the failure
 * modes live.
 */
export async function captureFromDatabase(
  db: Db,
  opts: { readonly tenantId: string; readonly limit?: number; readonly onlyInteresting?: boolean },
): Promise<Trace[]> {
  const rows = await query<{
    created_at: Date;
    reply_id: string;
    channel: string;
    body: string;
    name: string | null;
    version: number | null;
    label: string | null;
    confidence: string | null;
    status: string;
    decided_by: string;
    extracted: Record<string, unknown>;
  }>(
    db,
    `SELECT c.created_at, c.reply_id, r.channel, r.body,
            p.name, p.version, c.label, c.confidence::text, c.status, c.decided_by, c.extracted
       FROM classifications c
       JOIN inbound_replies r ON r.id = c.reply_id
       LEFT JOIN prompts p     ON p.id = c.prompt_id
      WHERE c.tenant_id = $1
        AND ($2::boolean IS NOT TRUE OR c.status = 'needs_review' OR c.label IS NULL)
      ORDER BY c.created_at DESC
      LIMIT $3`,
    [opts.tenantId, opts.onlyInteresting ?? false, opts.limit ?? 200],
  );

  return rows.map((row) => ({
    capturedAt: row.created_at.toISOString(),
    tenantId: opts.tenantId,
    replyId: row.reply_id,
    channel: row.channel,
    body: row.body,
    bodyHash: contentHash(row.body),
    promptName: row.name ?? 'deterministic',
    promptVersion: row.version ?? 0,
    label: row.label,
    confidence: row.confidence === null ? null : Number(row.confidence),
    status: row.status,
    decidedBy: row.decided_by,
    parseStatus: null,
    cacheHit: false,
    costUsd: 0,
    extracted: row.extracted,
  }));
}
