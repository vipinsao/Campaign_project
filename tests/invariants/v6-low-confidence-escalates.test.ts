/**
 * V6 — BELOW THE TENANT'S THRESHOLD IS A HUMAN'S PROBLEM.
 *
 * Failure it prevents: a 0.42-confidence guess rendered in the UI identically to a
 * 0.99 one.
 *
 * A classifier that reports only its label has thrown away the most actionable
 * thing it knew. The uncertainty has to travel with the answer to the place where
 * something is done about it, because that is the last moment it is still cheap to
 * act on — after that, an unsure "complaint" and a confident "complaint" are the
 * same row.
 *
 * Two details that are easy to get wrong and are asserted here:
 *
 *   - the LABEL IS KEPT on an uncertain answer. A reviewer wants "probably a
 *     complaint, not sure" rather than a blank; discarding it makes the queue
 *     harder to work, which makes it worked less.
 *   - the threshold is PER TENANT. A retailer whose replies are mostly order
 *     chasers and one whose replies are mostly regulated complaints do not want
 *     the same bar, and hard-coding 0.75 makes that a code change.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { classifyReply, MockModelClient } from '@campaign/triage';
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

describe('V6 — low confidence routes to a human', () => {
  it('marks an answer below the threshold needs_review, keeping the label', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db, { confidenceThreshold: 0.75 });
    const prompt = await syncedPrompt(db, 1);
    const body = 'I think there may be something wrong with the order but I am not sure.';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ label: 'complaint', confidence: 0.42 })),
    });

    const result = await classifyReply(
      triageDeps({ db, prompt, model }),
      await seedReply(db, tenantId, body),
    );

    expect(result.status).toBe('needs_review');
    expect(result.label, 'the label is kept — a blank row is harder to review').toBe('complaint');
    expect(result.confidence).toBe(0.42);
    expect(result.reason).toMatch(/below the tenant threshold/);

    const { rows } = await db.query<{ label: string; confidence: string; status: string }>(
      `SELECT label, confidence::text, status FROM classifications`,
    );
    expect(rows[0]).toEqual({ label: 'complaint', confidence: '0.420', status: 'needs_review' });
  });

  it('marks an answer at or above the threshold auto', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db, { confidenceThreshold: 0.75 });
    const prompt = await syncedPrompt(db, 1);
    const body = 'The parcel never arrived and support have not replied.';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ label: 'complaint', confidence: 0.75 })),
    });

    const result = await classifyReply(
      triageDeps({ db, prompt, model }),
      await seedReply(db, tenantId, body),
    );
    // Exactly at the threshold passes: the tenant's number is a floor they set, and
    // a strict `>` would make 0.75 mean "0.7500001" in a way nobody expects.
    expect(result.status).toBe('auto');
  });

  it('reads the threshold from the tenant, so two tenants disagree about the same answer', async () => {
    const db = testDb();
    const prompt = await syncedPrompt(db, 1);
    const body = 'Not totally happy with the fit, is that a common thing?';
    const answer = validAnswer({ label: 'complaint', confidence: 0.8 });

    const relaxed = await seedTriageTenant(db, { confidenceThreshold: 0.6 });
    const strict = await seedTriageTenant(db, { confidenceThreshold: 0.95 });

    const relaxedResult = await classifyReply(
      triageDeps({
        db,
        prompt,
        model: new MockModelClient({ fixtures: fixtureFor(prompt, body, answer) }),
      }),
      await seedReply(db, relaxed, body),
    );
    const strictResult = await classifyReply(
      triageDeps({
        db,
        prompt,
        model: new MockModelClient({ fixtures: fixtureFor(prompt, body, answer) }),
      }),
      await seedReply(db, strict, body),
    );

    expect(relaxedResult.status).toBe('auto');
    expect(strictResult.status).toBe('needs_review');
    expect(relaxedResult.label).toBe(strictResult.label);
  });

  it('puts uncertain rows on the review queue index the schema provides', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db, { confidenceThreshold: 0.9 });
    const prompt = await syncedPrompt(db, 1);

    for (const [body, confidence] of [
      ['First uncertain reply', 0.3],
      ['Second uncertain reply', 0.6],
      ['A confident reply', 0.99],
    ] as const) {
      const model = new MockModelClient({
        fixtures: fixtureFor(prompt, body, validAnswer({ confidence })),
      });
      await classifyReply(triageDeps({ db, prompt, model }), await seedReply(db, tenantId, body));
    }

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM classifications
        WHERE tenant_id = $1 AND status = 'needs_review'`,
      [tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('never auto-sends an uncertain answer, whatever the tenant flag says (V10)', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db, { confidenceThreshold: 0.9, autoSend: true });
    const prompt = await syncedPrompt(db, 1);
    const body = 'Maybe a question, maybe a complaint.';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ confidence: 0.5 })),
    });

    const result = await classifyReply(
      triageDeps({ db, prompt, model }),
      await seedReply(db, tenantId, body),
    );
    expect(result.status).toBe('needs_review');
    expect(result.autoSendAllowed).toBe(false);
  });
});
