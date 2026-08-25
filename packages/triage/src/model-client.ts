import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { Clock } from '@campaign/core';
import { withModelSpan } from './telemetry.ts';

/**
 * The model client  (V2).
 *
 * One narrow interface with four implementations, and the reason there are four is
 * the reason the eval harness in src/eval/ can be run rather than merely described:
 *
 *   AnthropicModelClient  — the real thing.
 *   MockModelClient       — recorded fixtures keyed by content hash. The demo and
 *                           the whole test suite run on this, with ZERO API keys.
 *   RecordingModelClient  — proxies a real client and writes what it saw to a
 *                           fixture file, so a fixture set is CAPTURED, not
 *                           imagined.
 *   ThrowingModelClient   — throws on any call. This is the instrument that makes
 *                           V1 a proof rather than a claim.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The contract
// ─────────────────────────────────────────────────────────────────────────────

export type ModelRequest = {
  readonly tenantId: string;
  readonly promptName: string;
  readonly promptVersion: number;
  readonly modelId: string;
  readonly system: string;
  readonly userContent: string;
  /** JSON Schema. Constrains generation; it is not a suggestion in the prompt text. */
  readonly outputSchema: Record<string, unknown>;
  /** Content hash of the reply body. The fixture key and the cache key (V8). */
  readonly inputHash: string;
  readonly maxOutputTokens: number;
};

export type ModelResponse = {
  readonly modelId: string;
  /** The raw text the model returned, persisted verbatim to model_calls.raw_output. */
  readonly raw: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
};

export type ModelClient = {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
};

/**
 * Model ids, current as of August 2026.
 *
 * Two of them on purpose. Haiku is a cheap first pass — most inbound replies are
 * three words long and unambiguous, and paying Sonnet prices to read "thanks!" is
 * how an AI feature's unit economics quietly stop working. Sonnet handles the
 * prompts whose front matter asks for it.
 */
export const MODEL_IDS = {
  classification: 'claude-sonnet-5',
  cheapTriage: 'claude-haiku-4-5-20251001',
} as const;

/**
 * USD per million tokens. A price table in the repository is not a nicety: without
 * it `cost_usd` is null, the spend query returns nothing, and the budget ledger
 * (V7) is counting tokens it cannot convert into money.
 */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function costUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICES[modelId];
  // An unknown model id costs zero only if we say so. Returning 0 silently would
  // make a newly-introduced model look free on every dashboard in the system.
  if (!price) return Number.NaN;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Rough token estimate for the pre-call budget reservation (V7). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// The real client
// ─────────────────────────────────────────────────────────────────────────────

export type AnthropicModelClientOptions = {
  readonly client: Anthropic;
  readonly clock: Clock;
};

export class AnthropicModelClient implements ModelClient {
  readonly name = 'anthropic';
  readonly #client: Anthropic;
  readonly #clock: Clock;

  constructor(options: AnthropicModelClientOptions) {
    this.#client = options.client;
    this.#clock = options.clock;
  }

  /** Build from the environment. Throws rather than defaulting, so a missing key
   *  fails at startup instead of at 3am on the first reply of the day. */
  static fromEnv(clock: Clock, apiKey = process.env['ANTHROPIC_API_KEY']): AnthropicModelClient {
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. The demo and the test suite run on ' +
          'MockModelClient and need no key; only the live path needs one.',
      );
    }
    return new AnthropicModelClient({ client: new Anthropic({ apiKey }), clock });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return withModelSpan('anthropic.messages.create', async (report) => {
      const startedAt = this.#clock.now().getTime();

      /**
       * STRUCTURED OUTPUTS, not JSON.parse-and-retry.
       *
       * `output_config.format` constrains DECODING: the server will not emit a
       * token that cannot lead to a document valid against this schema. The
       * common alternative — "reply with JSON only", then parse, then retry on
       * failure — is worse in three specific ways, and every one of them shows up
       * in production rather than in development:
       *
       *   1. The retry is billed. A 3% malformed-output rate on a prompt-and-pray
       *      loop is a 3% cost increase that nobody attributes to the parser.
       *   2. The retry is a SECOND sample, so the failures cluster on exactly the
       *      inputs that were hardest in the first place — the long, angry,
       *      multi-topic replies that most need to be right.
       *   3. It teaches the codebase to coerce. Once there is a retry loop, the
       *      next commit adds a "just take the first {...} we can find" fallback,
       *      and now a permission-adjacent decision is being made by a regex over
       *      a chat completion.
       *
       * The zod re-validation in classifier.ts is still there, and still matters:
       * it covers the Mock and Recording clients, it covers a schema change that
       * outruns a cached fixture, and it is the thing that turns an unexpected
       * field into an escalation rather than a stripped key.
       *
       * `effort: 'low'` because this is a classification, not a proof. Adaptive
       * thinking is left on (the default) — a disabled-thinking classifier on this
       * model family occasionally writes its reasoning into the visible answer.
       */
      const message = await this.#client.messages.create({
        model: request.modelId,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.userContent }],
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: request.outputSchema },
        },
      });

      const raw = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');

      const inputTokens = message.usage.input_tokens;
      const outputTokens = message.usage.output_tokens;
      const response: ModelResponse = {
        modelId: message.model,
        raw,
        inputTokens,
        outputTokens,
        costUsd: costUsd(message.model, inputTokens, outputTokens),
        latencyMs: this.#clock.now().getTime() - startedAt,
      };

      report({
        modelId: response.modelId,
        promptName: request.promptName,
        promptVersion: request.promptVersion,
        tenantId: request.tenantId,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: response.costUsd,
        latencyMs: response.latencyMs,
        cacheHit: false,
      });

      return response;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

export type ModelFixture = {
  readonly raw: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Free-text provenance. "Recorded from claude-sonnet-5 on 2026-08-12", not "made up". */
  readonly recordedFrom?: string;
};

/** Fixture key: prompt name + version + input hash. A fixture recorded against
 *  v1 must not be replayed for v2 — that would make prompt regressions invisible,
 *  which is the exact thing the eval harness exists to catch. */
export function fixtureKey(request: Pick<ModelRequest, 'promptName' | 'promptVersion' | 'inputHash'>): string {
  return `${request.promptName}/v${request.promptVersion}/${request.inputHash}`;
}

export const DEFAULT_FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/model-responses.json', import.meta.url),
);

export async function loadFixtures(file = DEFAULT_FIXTURE_PATH): Promise<Record<string, ModelFixture>> {
  try {
    const text = await readFile(file, 'utf8');
    return JSON.parse(text) as Record<string, ModelFixture>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export class MissingFixtureError extends Error {
  readonly key: string;

  constructor(key: string, file: string) {
    super(
      `No recorded model response for ${key}.\n` +
        `MockModelClient refuses to invent one. Record it with RecordingModelClient ` +
        `(ANTHROPIC_API_KEY required, once) and commit ${path.basename(file)}.`,
    );
    this.name = 'MissingFixtureError';
    this.key = key;
  }
}

/**
 * Deterministic replay.
 *
 * The default on a missing fixture is to THROW. A mock that quietly synthesises a
 * plausible answer is the single most effective way to build an eval suite that
 * reports 100% and measures nothing: every uncovered case silently passes, and the
 * number on the dashboard is a number about the mock.
 *
 * `synthesise` exists as an explicit opt-in for the zero-credential demo, where the
 * point is to watch the pipeline move rather than to measure quality. Nothing in
 * src/eval/ is allowed to pass it.
 */
export class MockModelClient implements ModelClient {
  readonly name = 'mock';
  readonly #fixtures: Record<string, ModelFixture>;
  readonly #file: string;
  readonly #synthesise: ((request: ModelRequest) => ModelFixture) | undefined;
  #calls = 0;

  constructor(options: {
    readonly fixtures: Record<string, ModelFixture>;
    readonly file?: string;
    readonly synthesise?: (request: ModelRequest) => ModelFixture;
  }) {
    this.#fixtures = options.fixtures;
    this.#file = options.file ?? DEFAULT_FIXTURE_PATH;
    this.#synthesise = options.synthesise;
  }

  static async fromDisk(file = DEFAULT_FIXTURE_PATH): Promise<MockModelClient> {
    return new MockModelClient({ fixtures: await loadFixtures(file), file });
  }

  get calls(): number {
    return this.#calls;
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    return withModelSpan('mock.messages.create', async (report) => {
      this.#calls += 1;
      const key = fixtureKey(request);
      const fixture = this.#fixtures[key] ?? this.#synthesise?.(request);
      if (!fixture) throw new MissingFixtureError(key, this.#file);

      const response: ModelResponse = {
        modelId: fixture.modelId,
        raw: fixture.raw,
        inputTokens: fixture.inputTokens,
        outputTokens: fixture.outputTokens,
        // Replay is free, and saying so is what makes an eval run's total cost
        // honest: the first capture cost money, every run since has cost nothing.
        costUsd: 0,
        latencyMs: 0,
      };

      report({
        modelId: response.modelId,
        promptName: request.promptName,
        promptVersion: request.promptVersion,
        tenantId: request.tenantId,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: 0,
        latencyMs: 0,
        cacheHit: false,
      });

      return Promise.resolve(response);
    });
  }
}

/**
 * Record once, replay forever.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This class is the difference between an eval suite you actually run and one you
 * run twice.
 *
 * An eval set that calls the live API costs money and wall-clock time on every
 * execution. That sounds like an accounting detail and it is not: it decides where
 * the suite runs. A suite that costs $4 and four minutes does not run on every
 * pull request — it runs on the branch where somebody remembered, which is to say
 * it runs after the regression has shipped. A suite replayed from fixtures costs
 * nothing and finishes in milliseconds, so it runs in CI on every commit, and a
 * prompt change that drops recall on `complaint` from 0.91 to 0.68 fails the build
 * instead of surfacing as a support backlog three weeks later.
 *
 * The fixtures are real model behaviour, captured once. That is the property that
 * hand-written mocks cannot have and that makes the replayed numbers mean
 * something. When the prompt version changes, the key changes, the fixture misses,
 * and you are told to re-record — which is correct, because a new prompt version
 * genuinely is a new set of behaviours to measure.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class RecordingModelClient implements ModelClient {
  readonly name: string;
  readonly #inner: ModelClient;
  readonly #file: string;
  readonly #recorded: Record<string, ModelFixture>;
  readonly #stamp: string;

  constructor(options: {
    readonly inner: ModelClient;
    readonly file?: string;
    readonly existing?: Record<string, ModelFixture>;
    /** Provenance stamp written into every fixture, e.g. an ISO date from the Clock. */
    readonly stamp: string;
  }) {
    this.#inner = options.inner;
    this.#file = options.file ?? DEFAULT_FIXTURE_PATH;
    this.#recorded = { ...options.existing };
    this.#stamp = options.stamp;
    this.name = `recording(${options.inner.name})`;
  }

  static async wrap(inner: ModelClient, stamp: string, file = DEFAULT_FIXTURE_PATH): Promise<RecordingModelClient> {
    return new RecordingModelClient({ inner, file, existing: await loadFixtures(file), stamp });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.#inner.complete(request);
    this.#recorded[fixtureKey(request)] = {
      raw: response.raw,
      modelId: response.modelId,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      recordedFrom: `${response.modelId} @ ${this.#stamp}`,
    };
    return response;
  }

  /** Keys sorted, two-space indent: a fixture file that reorders itself on every
   *  capture produces a diff nobody can review. */
  async flush(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const ordered = Object.fromEntries(
      Object.entries(this.#recorded).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    await writeFile(this.#file, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The instrument that makes V1 provable
// ─────────────────────────────────────────────────────────────────────────────

export class ModelCalledError extends Error {
  readonly inputHash: string;

  constructor(request: ModelRequest) {
    super(
      `A model call was attempted on a path that must be deterministic ` +
        `(prompt ${request.promptName} v${request.promptVersion}, input ${request.inputHash.slice(0, 12)}). ` +
        `Opt-out detection, identity matching and duplicate detection are not ` +
        `allowed to depend on a vendor being reachable.`,
    );
    this.name = 'ModelCalledError';
    this.inputHash = request.inputHash;
  }
}

/**
 * Throws on any call, and counts the attempts so a test can report WHICH input
 * reached for the model rather than just that something did.
 *
 * tests/invariants/v1-deterministic-paths-never-call-the-model.test.ts runs the
 * whole pipeline with this client installed. If any of the 30-odd deterministic
 * fixtures ever needs a model, the suite does not degrade — it fails.
 */
export class ThrowingModelClient implements ModelClient {
  readonly name = 'throwing';
  readonly attempts: ModelRequest[] = [];

  complete(request: ModelRequest): Promise<ModelResponse> {
    this.attempts.push(request);
    return Promise.reject(new ModelCalledError(request));
  }
}
