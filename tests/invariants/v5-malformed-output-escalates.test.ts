/**
 * V5 — MALFORMED OUTPUT ESCALATES. IT IS NEVER COERCED.
 *
 * Failure it prevents: a made-up label that is indistinguishable in the database
 * from a real one.
 *
 * There are three coercions this suite exists to keep out of the codebase, and
 * every one of them is a reasonable-looking line of TypeScript:
 *
 *   `label ?? 'other'`                       — invents an answer
 *   `JSON.parse(raw.match(/\{[\s\S]*\}/))`   — invents a document
 *   `z.object(...)` instead of strictObject  — silently DROPS an unexpected key
 *
 * The third is the dangerous one, because it does not look like a coercion at all.
 * `z.object` strips unknown keys, so a model that returned an extra field would
 * parse cleanly and the extra field would vanish with no record that it was ever
 * asked for. That is the exact mechanism by which a model asking for something it
 * is not allowed to ask for would become invisible — see V9.
 *
 * The retry is bounded at exactly one, and it is a REPAIR (the validation error is
 * shown to the model), not a resample. "Retry until it parses" converges on
 * whichever sample happened to be well-formed, which on a hard input is
 * uncorrelated with whichever sample was right.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { classifyReply, MockModelClient, ReplyClassification } from '@campaign/triage';
import {
  seedReply,
  seedTriageTenant,
  syncedPrompt,
  triageDeps,
  validAnswer,
} from './triage-harness.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

/** A client that answers each successive call from the list. */
function scripted(raws: readonly string[]): MockModelClient {
  let index = 0;
  return new MockModelClient({
    fixtures: {},
    synthesise: () => {
      const raw = raws[Math.min(index, raws.length - 1)] ?? '';
      index += 1;
      return { raw, modelId: 'claude-sonnet-5', inputTokens: 300, outputTokens: 30 };
    },
  });
}

const MALFORMED: readonly { raw: string; why: string }[] = [
  { raw: 'I think this is a complaint.', why: 'prose instead of JSON' },
  { raw: '{"label":"complaint"}', why: 'missing required fields' },
  {
    raw: '{"label":"annoyed","confidence":0.9,"summary":"x","urgency":"low","entities":{"order_number_mentioned":null,"product_mentioned":null}}',
    why: 'a label outside the closed set',
  },
  {
    raw: '{"label":"complaint","confidence":1.7,"summary":"x","urgency":"low","entities":{"order_number_mentioned":null,"product_mentioned":null}}',
    why: 'confidence out of range',
  },
  {
    raw: '{"label":"complaint","confidence":"high","summary":"x","urgency":"low","entities":{"order_number_mentioned":null,"product_mentioned":null}}',
    why: 'confidence as a string',
  },
  {
    raw: 'Here is the JSON: {"label":"complaint"} hope that helps',
    why: 'JSON wrapped in chatter',
  },
  {
    raw: '{"label":"complaint","confidence":0.9,"summary":"x","urgency":"low","entities":{"order_number_mentioned":null,"product_mentioned":null},"action":"resubscribe"}',
    why: 'an extra key the contract does not allow',
  },
];

describe('V5 — a schema violation escalates rather than being coerced', () => {
  for (const { raw, why } of MALFORMED) {
    it(`escalates on ${why}`, async () => {
      const db = testDb();
      const tenantId = await seedTriageTenant(db);
      const prompt = await syncedPrompt(db, 1);
      const model = scripted([raw, raw]);

      const result = await classifyReply(
        triageDeps({ db, prompt, model }),
        await seedReply(db, tenantId, `A reply that provokes: ${why}`),
      );

      // No label at all. Not 'other', not the nearest legal value.
      expect(result.label, why).toBeNull();
      expect(result.confidence).toBeNull();
      expect(result.status).toBe('needs_review');
      expect(result.parseStatus).toBe('escalated');
      expect(result.reason).toMatch(/escalated to human review/);

      const { rows } = await db.query<{ label: string | null; status: string }>(
        `SELECT label, status FROM classifications`,
      );
      expect(rows[0]).toEqual({ label: null, status: 'needs_review' });
    });
  }

  it('retries exactly once, and the retry is a repair rather than a resample', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);

    const seen: string[] = [];
    const model = new MockModelClient({
      fixtures: {},
      synthesise: (request) => {
        seen.push(request.userContent);
        return {
          raw:
            seen.length === 1
              ? '{"label":"complaint"}'
              : JSON.stringify(validAnswer({ label: 'complaint' })),
          modelId: 'claude-sonnet-5',
          inputTokens: 300,
          outputTokens: 30,
        };
      },
    });

    const body = 'The strap snapped on the second day.';
    const result = await classifyReply(
      triageDeps({ db, prompt, model }),
      await seedReply(db, tenantId, body),
    );

    expect(model.calls).toBe(2);
    expect(result.label).toBe('complaint');
    expect(result.parseStatus).toBe('retry_ok');
    // The second attempt carries the validation error. Asking again with the same
    // input is a lottery ticket; asking again with the error is a repair.
    expect(seen[0]).toBe(body);
    expect(seen[1]).toContain('rejected by the output schema');
  });

  it('gives up after the second failure instead of looping', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const model = scripted(['nope', 'still nope', 'third answer that must never be requested']);

    await classifyReply(
      triageDeps({ db, prompt, model }),
      await seedReply(db, tenantId, 'Anything at all'),
    );
    expect(model.calls, 'an unbounded retry loop is a cost incident, not a fallback').toBe(2);
  });

  it('rejects an unexpected key rather than silently dropping it', () => {
    // The schema-level assertion behind the V9 behavioural test: `strictObject`,
    // not `object`. With `object`, this would parse and `action` would vanish.
    const result = ReplyClassification.safeParse({
      ...validAnswer({ label: 'positive' }),
      action: 'resubscribe',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid answer unchanged, so the strictness is not just refusing everything', () => {
    const result = ReplyClassification.safeParse(validAnswer());
    expect(result.success).toBe(true);
  });
});
