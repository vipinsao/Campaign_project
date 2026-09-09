/**
 * QA / ADVERSARIAL — V5 (schema violations) and V6 (the confidence gate).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * (8) OUT-OF-RANGE CONFIDENCE — VERDICT: SAFE.
 *     `confidence: 1.5` and `confidence: -0.1` are rejected by
 *     `z.number().min(0).max(1)` before anything is stored. They are not clamped
 *     (which would silently invent certainty) and they never reach the
 *     `NUMERIC(4,3) CHECK (confidence BETWEEN 0 AND 1)` on `classifications`.
 *     The result is an escalation with a null confidence, not a 500 and not a
 *     constraint violation. I also confirmed the DB constraint is real and would
 *     have caught it — defence in depth, in the right order.
 *
 *     One genuinely interesting near-miss: `NUMERIC(4,3)` can hold values up to
 *     9.999, so the column TYPE would have accepted 1.5 quite happily. It is the
 *     CHECK that stops it, and zod that stops it before the CHECK. Both are load
 *     bearing.
 *
 * (9) LABEL OUTSIDE THE ENUM — VERDICT: SAFE, including case.
 *     `z.enum` is case-sensitive, so 'Complaint', 'COMPLAINT' and 'opt-out' are
 *     all violations, not near-misses. `z.strictObject` additionally refuses
 *     unknown keys rather than stripping them, so a model that invents a field
 *     leaves evidence instead of vanishing.
 *
 * (V6) A quieter observation, not a break: an escalated answer is persisted with
 *     `label = NULL`, and `classifications.label` is nullable with a CHECK that
 *     NULL satisfies vacuously. That is intended ("a null label is never a
 *     guess"), and the review queue index picks it up. Confirmed rather than
 *     assumed below.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { FakeClock } from '@campaign/core';
import { classifyReply, MockModelClient, ReplyClassification } from '@campaign/triage';
import {
  CLOCK_START,
  fixtureFor,
  seedReply,
  seedTriageTenant,
  syncedPrompt,
  triageDeps,
  validAnswer,
  type ModelAnswer,
} from '../invariants/triage-harness.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

/** Drive one hostile answer through the full pipeline and hand back the outcome. */
async function classifyWith(answer: ModelAnswer | string, body: string) {
  const db = testDb();
  const clock = new FakeClock(CLOCK_START);
  const tenantId = await seedTriageTenant(db, { confidenceThreshold: 0.5 });
  const prompt = await syncedPrompt(db, 1);
  const model = new MockModelClient({ fixtures: fixtureFor(prompt, body, answer) });
  const result = await classifyReply(
    triageDeps({ db, prompt, model, clock }),
    await seedReply(db, tenantId, body),
  );
  return { db, tenantId, result, calls: model.calls };
}

describe('QA/V5 — out-of-range confidence', () => {
  const OUT_OF_RANGE = [1.5, -0.1, 2, 1.0000001, -0] as const;

  it('SAFE: zod rejects every out-of-range confidence before it is stored', () => {
    for (const confidence of [1.5, -0.1, 2, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const parsed = ReplyClassification.safeParse(validAnswer({ confidence }));
      expect(parsed.success, String(confidence)).toBe(false);
    }
    // The boundaries themselves are inclusive and valid.
    expect(ReplyClassification.safeParse(validAnswer({ confidence: 0 })).success).toBe(true);
    expect(ReplyClassification.safeParse(validAnswer({ confidence: 1 })).success).toBe(true);
    // -0 is === 0 in JS and passes. Harmless: it stores as 0.000.
    expect(ReplyClassification.safeParse(validAnswer({ confidence: -0 })).success).toBe(true);
  });

  it('SAFE: confidence 1.5 escalates rather than being clamped, stored or 500ing', async () => {
    const body = 'Absolutely furious about this delivery.';
    const { db, tenantId, result, calls } = await classifyWith(
      validAnswer({ label: 'complaint', confidence: 1.5 }),
      body,
    );

    expect(result.parseStatus).toBe('escalated');
    expect(result.status).toBe('needs_review');
    // Not clamped to 1, not floored, not coerced.
    expect(result.confidence).toBeNull();
    expect(result.label).toBeNull();
    expect(String(result.extracted['schema_error'])).toMatch(/confidence/);
    expect(calls, 'one repair attempt, then it gives up').toBe(2);

    const { rows } = await db.query<{
      confidence: string | null;
      label: string | null;
      status: string;
    }>(`SELECT confidence::text, label, status FROM classifications WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confidence).toBeNull();
    expect(rows[0]!.label).toBeNull();
    expect(rows[0]!.status).toBe('needs_review');

    // And 1.5 never appears anywhere except the verbatim raw_output, which is the
    // point of keeping raw_output.
    const { rows: calls_ } = await db.query<{ parse_status: string; raw_output: string }>(
      `SELECT parse_status, raw_output FROM model_calls WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    );
    expect(calls_.map((c) => c.parse_status)).toEqual(['schema_violation', 'escalated']);
    expect(calls_[0]!.raw_output).toContain('1.5');
  });

  it('SAFE: -0.1 behaves the same way', async () => {
    const { result } = await classifyWith(
      validAnswer({ label: 'positive', confidence: -0.1 }),
      'Lovely, thanks!',
    );
    expect(result.parseStatus).toBe('escalated');
    expect(result.confidence).toBeNull();
  });

  it('the DB CHECK is real and would have caught it — but zod gets there first', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const reply = await seedReply(db, tenantId, 'anything');

    // NUMERIC(4,3) holds up to 9.999, so the TYPE would accept 1.5. The CHECK is
    // what refuses it.
    await expect(
      db.query(
        `INSERT INTO classifications (tenant_id, reply_id, prompt_id, label, confidence, status, decided_by)
         VALUES ($1,$2,NULL,'complaint',1.5,'auto','deterministic')`,
        [tenantId, reply.id],
      ),
    ).rejects.toThrow(/confidence/);

    await expect(
      db.query(
        `INSERT INTO classifications (tenant_id, reply_id, prompt_id, label, confidence, status, decided_by)
         VALUES ($1,$2,NULL,'complaint',-0.1,'auto','deterministic')`,
        [tenantId, reply.id],
      ),
    ).rejects.toThrow(/confidence/);

    // Everything zod lets through fits the column, so there is no value that
    // passes validation and then 500s on insert.
    for (const confidence of [0, 0.0004, 0.5, 0.9995, 1]) {
      const parsed = ReplyClassification.safeParse(validAnswer({ confidence }));
      expect(parsed.success, String(confidence)).toBe(true);
      const { rows } = await db.query<{ c: string }>(`SELECT $1::numeric(4,3)::text AS c`, [
        confidence,
      ]);
      expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(0);
      expect(Number(rows[0]!.c)).toBeLessThanOrEqual(1);
    }
    expect(OUT_OF_RANGE.length).toBe(5);
  });
});

describe('QA/V5 — labels outside the enum', () => {
  const BAD_LABELS = [
    'Complaint',
    'COMPLAINT',
    'complaints',
    'opt-out',
    'OPT_OUT',
    'Opt_Out',
    ' complaint',
    'complaint ',
    'resubscribe',
    'unsubscribe',
  ];

  it('SAFE: z.enum is case-sensitive — every near-miss is a violation', () => {
    for (const label of BAD_LABELS) {
      const parsed = ReplyClassification.safeParse(validAnswer({ label }));
      expect(parsed.success, label).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((i) => i.path.join('.') === 'label'),
          label,
        ).toBe(true);
      }
    }
    for (const label of ['question', 'complaint', 'opt_out', 'positive', 'other']) {
      expect(ReplyClassification.safeParse(validAnswer({ label })).success, label).toBe(true);
    }
  });

  it('SAFE: a case-only mismatch escalates end to end, it does not fall back to "other"', async () => {
    const body = 'You charged me twice and nobody has replied.';
    const { db, tenantId, result } = await classifyWith(
      validAnswer({ label: 'Complaint', confidence: 0.97 }),
      body,
    );

    expect(result.label, 'no `label ?? "other"` anywhere').toBeNull();
    expect(result.parseStatus).toBe('escalated');
    expect(String(result.extracted['schema_error'])).toMatch(/label/);

    const { rows } = await db.query<{
      label: string | null;
      decided_by: string;
      prompt_id: string | null;
    }>(`SELECT label, decided_by, prompt_id FROM classifications WHERE tenant_id = $1`, [tenantId]);
    expect(rows[0]!.label).toBeNull();
    // A null label is still a MODEL decision and still names its prompt version —
    // the CHECK `classifications_model_names_its_prompt` holds.
    expect(rows[0]!.decided_by).toBe('model');
    expect(rows[0]!.prompt_id).not.toBeNull();
  });

  it('SAFE: strictObject refuses an unknown key rather than stripping it', () => {
    const withExtra = { ...validAnswer(), action: 'resubscribe' };
    const parsed = ReplyClassification.safeParse(withExtra);
    expect(parsed.success).toBe(false);
    // Nested strictObject too — `entities` is where an invented field is most
    // likely to be smuggled in.
    expect(
      ReplyClassification.safeParse(
        validAnswer({
          entities: { order_number_mentioned: null, product_mentioned: null, contact_id: 'abc' },
        }),
      ).success,
    ).toBe(false);
  });

  it('SAFE: a JSON string for confidence is not coerced', () => {
    expect(ReplyClassification.safeParse(validAnswer({ confidence: '0.9' as never })).success).toBe(
      false,
    );
    expect(ReplyClassification.safeParse(validAnswer({ confidence: null as never })).success).toBe(
      false,
    );
  });
});

describe('QA/V6 — the confidence gate boundary', () => {
  it('SAFE: exactly AT the threshold is auto; a hair below is needs_review', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const prompt = await syncedPrompt(db, 1);
    const tenantId = await seedTriageTenant(db, { confidenceThreshold: 0.75 });

    const at = 'Is this jumper machine washable?';
    const below = 'Not sure how I feel about the new packaging honestly.';
    const model = new MockModelClient({
      fixtures: {
        ...fixtureFor(prompt, at, validAnswer({ confidence: 0.75 })),
        ...fixtureFor(prompt, below, validAnswer({ confidence: 0.749 })),
      },
    });
    const deps = triageDeps({ db, prompt, model, clock });

    expect((await classifyReply(deps, await seedReply(db, tenantId, at))).status).toBe('auto');
    const low = await classifyReply(deps, await seedReply(db, tenantId, below));
    expect(low.status).toBe('needs_review');
    // The label survives the escalation — the uncertainty travels with it.
    expect(low.label).toBe('question');
    expect(low.confidence).toBe(0.749);
  });

  it('SAFE: confidence 0 can never be auto, because the threshold CHECK forbids 0', async () => {
    const db = testDb();
    // tenants_confidence_threshold_valid: threshold > 0. So `0 < threshold` always.
    await expect(
      db.query(`INSERT INTO tenants (name, confidence_threshold) VALUES ('t', 0)`),
    ).rejects.toThrow(/confidence_threshold/);
  });
});
