/**
 * V2 — EVERY MODEL CALL IS RECORDED. NO EXCEPTIONS.
 *
 * Failure it prevents: an unattributable invoice and an invisible error rate.
 *
 * The natural implementation records the successes, because the success path is
 * the one you write first. A `model_calls` table containing only successes cannot
 * answer either of the two questions it exists for — what does this actually cost,
 * and how often is it wrong — because both answers live entirely in the rows that
 * implementation drops: the schema violations, the repaired retries, the
 * escalations and the cache hits.
 *
 * So this suite drives every branch and counts rows.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { classifyReply, contentHash, MockModelClient } from '@campaign/triage';
import {
  fixtureFor,
  seedReply,
  seedTriageTenant,
  syncedPrompt,
  triageDeps,
  validAnswer,
} from './triage-harness.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

type CallRow = {
  prompt_id: string;
  model_id: string;
  input_hash: string;
  raw_output: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null;
  cache_hit: boolean;
  parse_status: string;
  error: string | null;
};

async function calls(): Promise<CallRow[]> {
  const { rows } = await testDb().query<CallRow>(
    `SELECT prompt_id, model_id, input_hash, raw_output, input_tokens, output_tokens,
            cost_usd::text, cache_hit, parse_status, error
       FROM model_calls ORDER BY id ASC`,
  );
  return rows;
}

describe('V2 — every model call lands in model_calls', () => {
  it('records a successful call with its tokens, cost and prompt version', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const body = 'When will my parcel arrive?';
    const model = new MockModelClient({ fixtures: fixtureFor(prompt, body, validAnswer()) });
    const reply = await seedReply(db, tenantId, body);

    await classifyReply(triageDeps({ db, prompt, model }), reply);

    const recorded = await calls();
    expect(recorded).toHaveLength(1);
    const call = recorded[0]!;
    expect(call.prompt_id).toBe(prompt.id);
    expect(call.input_hash).toBe(contentHash(body));
    expect(call.parse_status).toBe('ok');
    expect(call.cache_hit).toBe(false);
    expect(call.input_tokens).toBe(400);
    expect(call.output_tokens).toBe(60);
    // The raw output is kept verbatim. A paraphrase is useless three months later
    // when the question is "what exactly did the model say".
    expect(JSON.parse(call.raw_output!)).toMatchObject({ label: 'question' });
  });

  it('records a cache hit as a call, so the hit rate is computable', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const body = 'Do you restock the navy one?';
    const model = new MockModelClient({ fixtures: fixtureFor(prompt, body, validAnswer()) });
    const deps = triageDeps({ db, prompt, model });

    await classifyReply(deps, await seedReply(db, tenantId, body));
    await classifyReply(deps, await seedReply(db, tenantId, body));

    const recorded = await calls();
    expect(recorded, 'a hit rate derived only from the misses is not a hit rate').toHaveLength(2);
    expect(recorded.map((c) => c.cache_hit)).toEqual([false, true]);
    expect(recorded[1]!.cost_usd).toBe('0.000000');
    expect(model.calls, 'the second reply must not reach the client').toBe(1);
  });

  it('records the schema violation AND the repair attempt as two separate rows', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const body = 'Two of the three arrived, where is the third?';

    // The mock answers the first call with something invalid; the retry appends the
    // validation error to the user content, so its fixture key is a different hash —
    // which is why a synthesiser is used here rather than two static fixtures.
    let call = 0;
    const model = new MockModelClient({
      fixtures: {},
      synthesise: () => {
        call += 1;
        return {
          raw:
            call === 1
              ? '{"label":"complaint"}'
              : JSON.stringify(validAnswer({ label: 'complaint' })),
          modelId: 'claude-sonnet-5',
          inputTokens: 400,
          outputTokens: 40,
        };
      },
    });

    const result = await classifyReply(
      triageDeps({ db, prompt, model }),
      await seedReply(db, tenantId, body),
    );
    expect(result.label).toBe('complaint');
    expect(result.parseStatus).toBe('retry_ok');

    const recorded = await calls();
    expect(recorded.map((c) => c.parse_status)).toEqual(['schema_violation', 'retry_ok']);
    // The failed attempt keeps its error text and its tokens: a retry that is not
    // recorded is a cost increase nobody attributes to the parser.
    expect(recorded[0]!.error).toMatch(/confidence|summary|urgency|entities/);
    expect(recorded[0]!.input_tokens).toBe(400);
  });

  it('records an escalation when both attempts fail', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const model = new MockModelClient({
      fixtures: {},
      synthesise: () => ({
        raw: 'sorry, I cannot do that',
        modelId: 'claude-sonnet-5',
        inputTokens: 400,
        outputTokens: 8,
      }),
    });

    const result = await classifyReply(
      triageDeps({ db, prompt, model }),
      await seedReply(db, tenantId, 'This is a genuinely ambiguous message.'),
    );
    expect(result.status).toBe('needs_review');

    const recorded = await calls();
    expect(recorded.map((c) => c.parse_status)).toEqual(['schema_violation', 'escalated']);
    expect(recorded.every((c) => c.raw_output === 'sorry, I cannot do that')).toBe(true);
  });

  it('writes no model_calls row for a deterministic decision, because there was no call', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const model = new MockModelClient({ fixtures: {} });

    await classifyReply(triageDeps({ db, prompt, model }), await seedReply(db, tenantId, 'STOP'));

    expect(await calls()).toHaveLength(0);
    // The schema makes the distinction queryable: a model decision must name its
    // prompt version, a deterministic one must not pretend to have had one.
    const { rows } = await testDb().query<{ decided_by: string; prompt_id: string | null }>(
      `SELECT decided_by, prompt_id FROM classifications`,
    );
    expect(rows).toEqual([{ decided_by: 'deterministic', prompt_id: null }]);
  });

  it('records the spend against the tenant, so the month can be totalled from SQL', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    for (const body of ['Question one?', 'Question two?', 'Question three?']) {
      const model = new MockModelClient({ fixtures: fixtureFor(prompt, body, validAnswer()) });
      await classifyReply(triageDeps({ db, prompt, model }), await seedReply(db, tenantId, body));
    }

    const { rows } = await db.query<{ n: string; tokens: string }>(
      `SELECT count(*)::text AS n,
              COALESCE(sum(input_tokens + output_tokens), 0)::text AS tokens
         FROM model_calls WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows[0]!.n).toBe('3');
    expect(rows[0]!.tokens).toBe('1380');
  });
});
