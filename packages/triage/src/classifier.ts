import type { Clock } from '@campaign/core';
import { type Db, queryOne } from '@campaign/core';
import type { Channel } from '@campaign/shared';
import { contentHash, detectOptOut } from './deterministic.ts';
import {
  estimateTokens,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from './model-client.ts';
import type { PromptRecord } from './prompts.ts';
import { protectionReasonFor, type ProtectionCapability } from './protection.ts';
import { OUTPUT_SCHEMAS, type ReplyClassification, type ReplyLabel } from './schema.ts';
import { releaseTokens, reserveTokens, settleTokens } from './budget.ts';

/**
 * The classifier  (V2, V5, V6, V7, V8, V9, V10).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The order of the steps below IS the design. Reading it top to bottom:
 *
 *   1. deterministic pass   — an opt-out never reaches the model, at all (V1/V9)
 *   2. cache                — same content, same prompt version, same answer (V8)
 *   3. budget               — refuse BEFORE spending, never after (V7)
 *   4. call + validate      — schema violation escalates, never coerces (V5)
 *   5. confidence gate      — below the tenant's threshold means a human (V6)
 *   6. record               — every call, no exceptions (V2)
 *
 * Note what this file does NOT import: the consent module. It cannot record
 * consent, it cannot remove a suppression, it cannot cancel an opt-out, because
 * none of those functions are in scope. It holds a `ProtectionCapability` with one
 * add-only method. See protection.ts for the argument (V9).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type TenantTriageSettings = {
  readonly id: string;
  readonly confidenceThreshold: number;
  readonly autoSend: boolean;
  readonly monthlyTokenBudget: number;
};

export type TriageDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly model: ModelClient;
  readonly prompt: PromptRecord;
  /** Add-only. This is the entire consent surface the classifier is given (V9). */
  readonly protection: ProtectionCapability;
  readonly maxOutputTokens?: number;
};

export type TriageInput = {
  readonly tenantId: string;
  readonly channel: Channel;
  /** The address the reply came FROM. What gets suppressed on an opt-out. */
  readonly fromAddress: string;
  readonly body: string;
  /** Present when triaging a stored reply; absent when running the eval harness. */
  readonly replyId?: string;
};

export type ParseStatus = 'ok' | 'schema_violation' | 'retry_ok' | 'escalated';

export type TriageOutcome = {
  /** null only when nothing valid was produced. A null label is never a guess. */
  readonly label: ReplyLabel | null;
  readonly confidence: number | null;
  readonly status: 'auto' | 'needs_review';
  readonly decidedBy: 'deterministic' | 'model';
  readonly extracted: Record<string, unknown>;
  readonly cacheHit: boolean;
  readonly promptId: string | null;
  readonly parseStatus: ParseStatus | null;
  readonly costUsd: number;
  readonly tokens: number;
  /** One sentence for an operator, in the house style of the decision log. */
  readonly reason: string;
};

export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export async function loadTenantTriageSettings(
  db: Db,
  tenantId: string,
): Promise<TenantTriageSettings> {
  const row = await queryOne<{
    id: string;
    confidence_threshold: string;
    auto_send: boolean;
    monthly_token_budget: string;
  }>(
    db,
    `SELECT id, confidence_threshold::text, auto_send, monthly_token_budget::text
       FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (!row)
    throw new Error(`Unknown tenant ${tenantId}: cannot triage a reply without its thresholds.`);
  return {
    id: row.id,
    confidenceThreshold: Number(row.confidence_threshold),
    autoSend: row.auto_send,
    monthlyTokenBudget: Number(row.monthly_token_budget),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// V2 — every call is recorded
// ─────────────────────────────────────────────────────────────────────────────

type ModelCallRecord = {
  readonly tenantId: string;
  readonly replyId: string | undefined;
  readonly promptId: string;
  readonly modelId: string;
  readonly inputHash: string;
  readonly rawOutput: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number | null;
  readonly cacheHit: boolean;
  readonly parseStatus: ParseStatus;
  readonly error: string | null;
};

/**
 * One insert, called from every branch — success, cache hit, schema violation,
 * repaired retry, escalation and vendor error alike.
 *
 * The temptation is to record only successes, because that is the path you are
 * writing when you write the happy case. A `model_calls` table that contains only
 * successes cannot answer the two questions it exists for: what is the real error
 * rate, and what did this month actually cost. Both of those live entirely in the
 * rows a "log the result" implementation drops on the floor.
 */
async function recordModelCall(db: Db, call: ModelCallRecord): Promise<void> {
  await db.query(
    `INSERT INTO model_calls
       (tenant_id, reply_id, prompt_id, model_id, input_hash, raw_output,
        input_tokens, output_tokens, cost_usd, latency_ms, cache_hit, parse_status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      call.tenantId,
      call.replyId ?? null,
      call.promptId,
      call.modelId,
      call.inputHash,
      call.rawOutput,
      call.inputTokens,
      call.outputTokens,
      Number.isFinite(call.costUsd) ? call.costUsd : null,
      call.latencyMs,
      call.cacheHit,
      call.parseStatus,
      call.error,
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// V8 — the cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keyed on (prompt_id, input_hash). No TTL, and the absence of a TTL is the point.
 *
 * A wall-clock cache expiry says "this answer goes stale on Thursday", which is
 * only true if the inputs changed — and if the inputs changed, the hash changed
 * and the entry was never going to be hit again anyway. What a TTL actually buys
 * you is paying twice for the same answer on a schedule.
 *
 * The prompt id is half the key, so a new prompt version invalidates everything at
 * once, exactly and immediately. That is the correct invalidation trigger, and it
 * is a content hash rather than a timestamp.
 *
 * Only `parse_status = 'ok'` is served. A `retry_ok` answer came from a call that
 * needed a repair round-trip; caching it would make one awkward interaction
 * permanent and free, and would hide from the eval harness that the prompt has an
 * input it cannot answer first time.
 */
async function cacheLookup(
  db: Db,
  promptId: string,
  inputHash: string,
): Promise<{ raw_output: string; model_id: string } | undefined> {
  return queryOne<{ raw_output: string; model_id: string }>(
    db,
    `SELECT raw_output, model_id FROM model_calls
      WHERE prompt_id = $1 AND input_hash = $2 AND parse_status = 'ok' AND raw_output IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [promptId, inputHash],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The pipeline
// ─────────────────────────────────────────────────────────────────────────────

function buildRequest(
  deps: TriageDeps,
  input: TriageInput,
  inputHash: string,
  repair?: string,
): ModelRequest {
  const userContent = repair
    ? `${input.body}\n\n---\nYour previous answer was rejected by the output schema:\n${repair}\nAnswer again, valid this time.`
    : input.body;
  return {
    tenantId: input.tenantId,
    promptName: deps.prompt.name,
    promptVersion: deps.prompt.version,
    modelId: deps.prompt.modelId,
    system: deps.prompt.body,
    userContent,
    outputSchema: deps.prompt.outputSchema,
    inputHash,
    maxOutputTokens: deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

/**
 * Reserve, call, settle.
 *
 * The reservation is released if the vendor throws before returning usage. Without
 * that, an afternoon of 503s silently consumes a tenant's monthly budget and
 * produces nothing — and the symptom the following week is "classification stopped
 * working", with a full ledger and an empty model_calls table to explain it.
 */
async function callWithBudget(deps: TriageDeps, request: ModelRequest): Promise<ModelResponse> {
  const reserved =
    estimateTokens(request.system) + estimateTokens(request.userContent) + request.maxOutputTokens;
  await reserveTokens(deps.db, { tenantId: request.tenantId, tokens: reserved, clock: deps.clock });

  let response: ModelResponse;
  try {
    response = await deps.model.complete(request);
  } catch (error) {
    await releaseTokens(deps.db, {
      tenantId: request.tenantId,
      tokens: reserved,
      clock: deps.clock,
    });
    throw error;
  }

  await settleTokens(deps.db, {
    tenantId: request.tenantId,
    reserved,
    actualTokens: response.inputTokens + response.outputTokens,
    costUsd: response.costUsd,
    clock: deps.clock,
  });
  return response;
}

function validate(
  deps: TriageDeps,
  raw: string,
): { ok: true; value: ReplyClassification } | { ok: false; error: string } {
  const schema = OUTPUT_SCHEMAS[deps.prompt.schemaName];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'response was not valid JSON' };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; '),
  };
}

function outcomeFromOutput(
  settings: TenantTriageSettings,
  promptId: string,
  value: ReplyClassification,
  meta: { cacheHit: boolean; parseStatus: ParseStatus; costUsd: number; tokens: number },
): TriageOutcome {
  /**
   * V6 — below the tenant's threshold is `needs_review`, and the LABEL IS KEPT.
   *
   * Discarding the label would throw away the most useful thing in the row: a
   * reviewer opening the queue wants "probably a complaint, not sure" rather than
   * a blank. What must not happen is the other direction — a 0.42-confidence guess
   * rendered in the UI identically to a 0.99 one. The uncertainty travels with the
   * answer instead of being rounded off at the point where it was still cheap to
   * act on.
   */
  const uncertain = value.confidence < settings.confidenceThreshold;
  return {
    label: value.label,
    confidence: value.confidence,
    status: uncertain ? 'needs_review' : 'auto',
    decidedBy: 'model',
    extracted: {
      summary: value.summary,
      urgency: value.urgency,
      entities: value.entities,
    },
    cacheHit: meta.cacheHit,
    promptId,
    parseStatus: meta.parseStatus,
    costUsd: meta.costUsd,
    tokens: meta.tokens,
    reason: uncertain
      ? `Model returned '${value.label}' at ${value.confidence} confidence, below the ` +
        `tenant threshold of ${settings.confidenceThreshold}; queued for human review.`
      : `Model classified the reply as '${value.label}' at ${value.confidence} confidence.`,
  };
}

/**
 * Triage one reply body. Writes model_calls and the budget ledger; does NOT write
 * classifications or suppressions — see `classifyReply` for that.
 *
 * Split this way so the eval harness can run the exact production pipeline against
 * a golden case without manufacturing an inbound_replies row for something nobody
 * ever sent. An eval that runs a reimplementation of the pipeline measures the
 * reimplementation.
 */
export async function triage(deps: TriageDeps, input: TriageInput): Promise<TriageOutcome> {
  const settings = await loadTenantTriageSettings(deps.db, input.tenantId);
  const inputHash = contentHash(input.body);

  // ── 1. Deterministic pass. No model, no budget, no network. ─────────────────
  const optOut = detectOptOut(input.body);
  if (optOut.optedOut) {
    // No model_calls row is written here, and that is not an omission: there was
    // no call. `SELECT count(*) FROM classifications WHERE decided_by='model'`
    // versus `'deterministic'` is the query that proves V1 from SQL alone.
    return {
      label: 'opt_out',
      confidence: 1,
      status: 'auto',
      decidedBy: 'deterministic',
      extracted: { keyword: optOut.keyword, normalised: optOut.normalised },
      cacheHit: false,
      promptId: null,
      parseStatus: null,
      costUsd: 0,
      tokens: 0,
      reason: `Carrier opt-out keyword '${optOut.keyword}' matched the whole message; no model was consulted.`,
    };
  }

  // ── 2. Cache (V8) ──────────────────────────────────────────────────────────
  const cached = await cacheLookup(deps.db, deps.prompt.id, inputHash);
  if (cached) {
    const validated = validate(deps, cached.raw_output);
    if (validated.ok) {
      // A served cache hit is still a call as far as the ledger of what happened
      // is concerned: it is how the hit RATE is computed, and a hit rate derived
      // only from the misses is not a hit rate.
      await recordModelCall(deps.db, {
        tenantId: input.tenantId,
        replyId: input.replyId,
        promptId: deps.prompt.id,
        modelId: cached.model_id,
        inputHash,
        rawOutput: cached.raw_output,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        cacheHit: true,
        parseStatus: 'ok',
        error: null,
      });
      return outcomeFromOutput(settings, deps.prompt.id, validated.value, {
        cacheHit: true,
        parseStatus: 'ok',
        costUsd: 0,
        tokens: 0,
      });
    }
    // A cached answer that no longer validates means the schema moved under it.
    // Fall through and re-ask rather than serving something the current contract
    // rejects.
  }

  // ── 3 & 4. Budget, call, validate (V7, V5) ─────────────────────────────────
  const first = await callWithBudget(deps, buildRequest(deps, input, inputHash));
  const firstCheck = validate(deps, first.raw);

  if (firstCheck.ok) {
    await recordModelCall(deps.db, {
      tenantId: input.tenantId,
      replyId: input.replyId,
      promptId: deps.prompt.id,
      modelId: first.modelId,
      inputHash,
      rawOutput: first.raw,
      inputTokens: first.inputTokens,
      outputTokens: first.outputTokens,
      costUsd: first.costUsd,
      latencyMs: first.latencyMs,
      cacheHit: false,
      parseStatus: 'ok',
      error: null,
    });
    return outcomeFromOutput(settings, deps.prompt.id, firstCheck.value, {
      cacheHit: false,
      parseStatus: 'ok',
      costUsd: first.costUsd,
      tokens: first.inputTokens + first.outputTokens,
    });
  }

  /**
   * V5 — a schema violation is a FAILURE, not a hint.
   *
   * The retry is bounded at exactly one, and it is a repair attempt: the model is
   * shown its own validation error and asked again. What it is not is a resampling
   * loop. "Retry until it parses" converges on whichever sample happened to be
   * well-formed, which on a hard input is uncorrelated with whichever sample was
   * right — and it bills you for each attempt while doing it.
   *
   * There is deliberately no coercion path anywhere below. No "take the first
   * label-shaped substring", no `label ?? 'other'`, no dropping the unknown key and
   * carrying on. An answer that does not satisfy the contract produces a row a
   * human has to look at, because the alternative is a made-up label that is
   * indistinguishable in the database from a real one.
   */
  await recordModelCall(deps.db, {
    tenantId: input.tenantId,
    replyId: input.replyId,
    promptId: deps.prompt.id,
    modelId: first.modelId,
    inputHash,
    rawOutput: first.raw,
    inputTokens: first.inputTokens,
    outputTokens: first.outputTokens,
    costUsd: first.costUsd,
    latencyMs: first.latencyMs,
    cacheHit: false,
    parseStatus: 'schema_violation',
    error: firstCheck.error,
  });

  const second = await callWithBudget(deps, buildRequest(deps, input, inputHash, firstCheck.error));
  const secondCheck = validate(deps, second.raw);
  const totalCost = first.costUsd + second.costUsd;
  const totalTokens =
    first.inputTokens + first.outputTokens + second.inputTokens + second.outputTokens;

  await recordModelCall(deps.db, {
    tenantId: input.tenantId,
    replyId: input.replyId,
    promptId: deps.prompt.id,
    modelId: second.modelId,
    inputHash,
    rawOutput: second.raw,
    inputTokens: second.inputTokens,
    outputTokens: second.outputTokens,
    costUsd: second.costUsd,
    latencyMs: second.latencyMs,
    cacheHit: false,
    parseStatus: secondCheck.ok ? 'retry_ok' : 'escalated',
    error: secondCheck.ok ? null : secondCheck.error,
  });

  if (secondCheck.ok) {
    return outcomeFromOutput(settings, deps.prompt.id, secondCheck.value, {
      cacheHit: false,
      parseStatus: 'retry_ok',
      costUsd: totalCost,
      tokens: totalTokens,
    });
  }

  return {
    label: null,
    confidence: null,
    status: 'needs_review',
    decidedBy: 'model',
    extracted: { schema_error: secondCheck.error },
    cacheHit: false,
    promptId: deps.prompt.id,
    parseStatus: 'escalated',
    costUsd: totalCost,
    tokens: totalTokens,
    reason:
      `The model's output failed the schema twice (${secondCheck.error}); escalated to ` +
      `human review with no label rather than coercing a guess.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

export type StoredReply = {
  readonly id: string;
  readonly tenantId: string;
  readonly channel: Channel;
  readonly fromAddress: string;
  readonly body: string;
};

export type ClassificationResult = TriageOutcome & {
  readonly classificationId: string;
  readonly suppressed: boolean;
  readonly autoSendAllowed: boolean;
};

/**
 * V10 — an autonomous system does not email customers until somebody decides it
 * should.
 *
 * Four conditions, and every one of them is a veto. The tenant flag defaults to
 * false in the schema rather than in a config file, so a fresh clone, a demo and a
 * newly-provisioned tenant all start silent. The extra three are not belt and
 * braces: an uncertain classification and a null label have no business generating
 * a customer-facing reply at any setting, and auto-replying to somebody who just
 * said STOP is the single worst message this system could send.
 */
export function autoSendAllowed(settings: TenantTriageSettings, outcome: TriageOutcome): boolean {
  if (!settings.autoSend) return false;
  if (outcome.status !== 'auto') return false;
  if (outcome.label === null) return false;
  if (outcome.label === 'opt_out') return false;
  return true;
}

/**
 * Triage a stored reply and persist the result.
 *
 * The only consent side effect available here is `addSuppression`, and it fires
 * only on the DETERMINISTIC opt-out path — the model's label never reaches it.
 * Even a model that returns `label: 'opt_out'` writes a classification and nothing
 * else; a suppression is a legal artefact and it is created by a keyword match
 * that gives the same answer every time, not by a probability.
 */
export async function classifyReply(
  deps: TriageDeps,
  reply: StoredReply,
): Promise<ClassificationResult> {
  const settings = await loadTenantTriageSettings(deps.db, reply.tenantId);
  const outcome = await triage(deps, {
    tenantId: reply.tenantId,
    channel: reply.channel,
    fromAddress: reply.fromAddress,
    body: reply.body,
    replyId: reply.id,
  });

  let suppressed = false;
  if (outcome.decidedBy === 'deterministic' && outcome.label === 'opt_out') {
    await deps.protection.addSuppression({
      tenantId: reply.tenantId,
      channel: reply.channel,
      address: reply.fromAddress,
      reason: protectionReasonFor(reply.channel),
      evidence: {
        source: 'inbound_reply',
        reply_id: reply.id,
        matched: outcome.extracted['keyword'],
        detected_at: deps.clock.now().toISOString(),
      },
    });
    suppressed = true;
  }

  const classificationId = await persistClassification(deps, reply, outcome);
  return {
    ...outcome,
    classificationId,
    suppressed,
    autoSendAllowed: autoSendAllowed(settings, outcome),
  };
}

/**
 * `classifications` is UNIQUE on (reply_id, prompt_id), which in Postgres treats
 * NULLs as distinct — so the ON CONFLICT clause covers model decisions and cannot
 * cover deterministic ones, whose prompt_id is NULL by construction. The
 * deterministic branch therefore looks first. See the note in the report: the
 * schema wants `UNIQUE NULLS NOT DISTINCT` here, and changing it is a migration.
 */
async function persistClassification(
  deps: TriageDeps,
  reply: StoredReply,
  outcome: TriageOutcome,
): Promise<string> {
  if (outcome.promptId === null) {
    const existing = await queryOne<{ id: string }>(
      deps.db,
      `SELECT id FROM classifications WHERE reply_id = $1 AND prompt_id IS NULL`,
      [reply.id],
    );
    if (existing) return existing.id;
  }

  const inserted = await queryOne<{ id: string }>(
    deps.db,
    `INSERT INTO classifications
       (tenant_id, reply_id, prompt_id, label, confidence, extracted, status, decided_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (reply_id, prompt_id) DO UPDATE
        SET label = EXCLUDED.label,
            confidence = EXCLUDED.confidence,
            extracted = EXCLUDED.extracted,
            status = EXCLUDED.status
     RETURNING id`,
    [
      reply.tenantId,
      reply.id,
      outcome.promptId,
      outcome.label,
      outcome.confidence,
      JSON.stringify(outcome.extracted),
      outcome.status,
      outcome.decidedBy,
      deps.clock.now(),
    ],
  );
  if (!inserted) throw new Error(`Failed to persist a classification for reply ${reply.id}.`);
  return inserted.id;
}
