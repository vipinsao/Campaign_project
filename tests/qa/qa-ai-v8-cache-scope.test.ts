/**
 * QA / ADVERSARIAL — V8: the cache key.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * (6) CROSS-TENANT CACHE — VERDICT: SAFE, but only just, and for a reason the
 *     code does not state.
 *
 *     `cacheLookup` filters on `(prompt_id, input_hash)` and nothing else. There
 *     is no `tenant_id` predicate, so tenant B is genuinely served a row written
 *     by and billed to tenant A. The existing suite calls this a deliberate
 *     choice ("scopes the cache to the prompt, not to the tenant that paid for
 *     it"). Is it defensible?
 *
 *     It is, for content — but the argument is narrower than it looks. It holds
 *     ONLY because every input to the cached answer is in the key: the answer is
 *     a pure function of (prompt content, body), the prompt is content-addressed
 *     and immutable (V3), and `input_hash` is a SHA-256 of the whole body. A hash
 *     collision aside, tenant B receives an answer about a byte-identical body it
 *     already possesses. Nothing of tenant A's crosses.
 *
 *     Three things that WOULD break it, none of which is currently guarded:
 *       - any per-tenant input to the prompt (a tenant name, a brand voice, a
 *         glossary, a few-shot example set). The key does not cover it, so the
 *         first such feature silently serves tenant A's tailored answer to
 *         tenant B. Nothing in the code or the tests would notice.
 *       - a prompt whose output includes anything tenant-derived.
 *       - `raw_output` being served without re-validation. It IS re-validated,
 *         which is what stops a stale-schema row leaking through.
 *
 *     What DOES cross today is a membership oracle and a small amount of money:
 *     tenant B learns, from `model_calls.cache_hit`, that some other tenant has
 *     classified a byte-identical message under the same prompt version. Not
 *     currently exposed on any API route (grep: no `cache_hit` in packages/api),
 *     so it is a latent disclosure rather than a live one.
 *
 * (7) CASE IS NOT FOLDED — VERDICT: SAFE and correct.
 *     Two model calls for "THIS IS UNACCEPTABLE" and "this is unacceptable" is
 *     the right answer, not waste. The output includes `urgency` and a sentiment
 *     judgement, and shouting is evidence for both. Folding case would serve the
 *     wrong urgency for free, forever, with no TTL to age it out.
 *
 * (BONUS) THE CACHE BYPASSES THE BUDGET ENTIRELY — VERDICT: SAFE but worth
 *     stating: a tenant sitting on an exhausted budget still gets classifications
 *     for any body already in the cache, including bodies only ever paid for by
 *     another tenant. Correct (no call was made, so nothing to refuse), but it
 *     means "budget exhausted" is not a hard stop on classification volume.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { FakeClock } from '@campaign/core';
import {
  budgetState,
  classifyReply,
  contentHash,
  MockModelClient,
  ThrowingModelClient,
  triage,
} from '@campaign/triage';
import {
  CLOCK_START,
  fixtureFor,
  seedReply,
  seedTriageTenant,
  syncedPrompt,
  triageDeps,
  validAnswer,
} from '../invariants/triage-harness.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

const SHARED_BODY = 'The parcel says delivered but it is not here. Third time this has happened.';

describe('QA/V8 — cache scope', () => {
  it('FINDING: tenant B is served the raw_output row that tenant A paid for', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const prompt = await syncedPrompt(db, 1);
    const tenantA = await seedTriageTenant(db, { confidenceThreshold: 0.5 });
    const tenantB = await seedTriageTenant(db, { confidenceThreshold: 0.5 });

    const model = new MockModelClient({
      fixtures: fixtureFor(
        prompt,
        SHARED_BODY,
        validAnswer({ label: 'complaint', confidence: 0.88, summary: 'Missing parcel, repeat issue.' }),
      ),
    });

    const a = await classifyReply(
      triageDeps({ db, prompt, model, clock }),
      await seedReply(db, tenantA, SHARED_BODY),
    );
    expect(a.cacheHit).toBe(false);
    expect(model.calls).toBe(1);

    // Tenant B, different tenant entirely, with the model client REPLACED by one
    // that throws. If the cache were tenant-scoped this would blow up.
    const throwing = new ThrowingModelClient();
    const b = await classifyReply(
      triageDeps({ db, prompt, model: throwing, clock }),
      await seedReply(db, tenantB, SHARED_BODY),
    );

    expect(throwing.attempts, 'tenant B never called the model').toEqual([]);
    expect(b.cacheHit).toBe(true);
    expect(b.label).toBe('complaint');
    expect(b.extracted).toEqual(a.extracted);

    // The row tenant B was served is literally tenant A's.
    const { rows } = await db.query<{ tenant_id: string; cache_hit: boolean; raw_output: string }>(
      `SELECT tenant_id, cache_hit, raw_output FROM model_calls ORDER BY id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tenant_id).toBe(tenantA);
    expect(rows[0]!.cache_hit).toBe(false);
    expect(rows[1]!.tenant_id).toBe(tenantB);
    expect(rows[1]!.cache_hit).toBe(true);
    expect(rows[1]!.raw_output, 'byte-identical to the row A paid for').toBe(rows[0]!.raw_output);
  });

  it('DEFENSIBLE: nothing tenant-specific is in the answer, because nothing tenant-specific is in the request', async () => {
    // The whole safety argument reduces to this: the request the model sees is
    // (prompt body, reply body) and nothing else. If a tenant name or a brand
    // glossary is ever added to `buildRequest`, the key stops covering the input
    // and this test is the one that should start failing.
    const db = testDb();
    const prompt = await syncedPrompt(db, 1);
    const tenantA = await seedTriageTenant(db);
    const tenantB = await seedTriageTenant(db, { confidenceThreshold: 0.99 });

    const seen: { tenantId: string; system: string; userContent: string; inputHash: string }[] = [];
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, SHARED_BODY, validAnswer({ label: 'complaint', confidence: 0.88 })),
    });
    const spy = {
      name: 'spy',
      complete: (request: Parameters<typeof model.complete>[0]) => {
        seen.push({
          tenantId: request.tenantId,
          system: request.system,
          userContent: request.userContent,
          inputHash: request.inputHash,
        });
        return model.complete(request);
      },
    };

    for (const tenantId of [tenantA, tenantB]) {
      await triage(triageDeps({ db, prompt, model: spy }), {
        tenantId,
        channel: 'email',
        fromAddress: `x@example.com`,
        body: SHARED_BODY,
      });
    }

    // Only ONE call happened (the second was a cache hit), and the one request
    // that was built carries no tenant-derived content at all — tenantId is
    // metadata for the ledger, not part of the prompt.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.system).toBe(prompt.body);
    expect(seen[0]!.userContent).toBe(SHARED_BODY);
    expect(seen[0]!.inputHash).toBe(contentHash(SHARED_BODY));
    expect(seen[0]!.system).not.toContain(tenantA);
    expect(seen[0]!.system).not.toContain(tenantB);
  });

  it('FINDING: the tenant threshold is re-applied, so the two tenants can still disagree', async () => {
    // Mitigating: the cached raw_output is re-parsed and re-gated against the
    // READING tenant's threshold, so a cache hit does not import tenant A's
    // confidence policy along with the answer.
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const prompt = await syncedPrompt(db, 1);
    const lax = await seedTriageTenant(db, { confidenceThreshold: 0.5 });
    const strict = await seedTriageTenant(db, { confidenceThreshold: 0.99 });

    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, SHARED_BODY, validAnswer({ label: 'complaint', confidence: 0.88 })),
    });
    const deps = triageDeps({ db, prompt, model, clock });

    const a = await classifyReply(deps, await seedReply(db, lax, SHARED_BODY));
    const b = await classifyReply(deps, await seedReply(db, strict, SHARED_BODY));

    expect(a.status).toBe('auto');
    expect(b.cacheHit).toBe(true);
    expect(b.status).toBe('needs_review');
  });

  it('FINDING: an exhausted budget is not a stop — the cache still serves', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const prompt = await syncedPrompt(db, 1);
    const payer = await seedTriageTenant(db, { confidenceThreshold: 0.5 });
    // Tenant B has a budget of 1 token: no call it could make would be permitted.
    const broke = await seedTriageTenant(db, { confidenceThreshold: 0.5, monthlyTokenBudget: 1 });

    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, SHARED_BODY, validAnswer({ label: 'complaint', confidence: 0.88 })),
    });

    await classifyReply(triageDeps({ db, prompt, model, clock }), await seedReply(db, payer, SHARED_BODY));

    const result = await classifyReply(
      triageDeps({ db, prompt, model: new ThrowingModelClient(), clock }),
      await seedReply(db, broke, SHARED_BODY),
    );

    expect(result.cacheHit).toBe(true);
    expect(result.label).toBe('complaint');
    // Not a token spent, and the budget check was never reached: the cache sits
    // ABOVE the budget in the pipeline order.
    expect((await budgetState(db, broke, clock)).used).toBe(0);
  });

  it('ORACLE: cache_hit tells a tenant that someone else classified the same body', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const prompt = await syncedPrompt(db, 1);
    const victim = await seedTriageTenant(db, { confidenceThreshold: 0.5 });
    const prober = await seedTriageTenant(db, { confidenceThreshold: 0.5 });

    const probe = 'Confidential: our merger with Northwind closes on the 4th.';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, probe, validAnswer({ label: 'other', confidence: 0.9 })),
    });

    // Before: probing an unseen body costs a call and reports cacheHit false.
    const before = await classifyReply(
      triageDeps({ db, prompt, model, clock }),
      await seedReply(db, prober, probe),
    );
    expect(before.cacheHit).toBe(false);

    // After the victim classifies it, the same probe from the prober is a hit.
    await classifyReply(triageDeps({ db, prompt, model, clock }), await seedReply(db, victim, probe));
    const after = await classifyReply(
      triageDeps({ db, prompt, model: new ThrowingModelClient(), clock }),
      await seedReply(db, prober, probe),
    );
    expect(after.cacheHit).toBe(true);

    // Not currently reachable from any HTTP route — `cache_hit` appears nowhere in
    // packages/api — so this is latent, not live.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_calls WHERE cache_hit = true`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('SAFE: case is not folded, and paying twice for it is the right call', async () => {
    const shouted = 'THIS IS COMPLETELY UNACCEPTABLE';
    const quiet = 'this is completely unacceptable';
    expect(contentHash(shouted)).not.toBe(contentHash(quiet));

    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const prompt = await syncedPrompt(db, 1);
    const tenantId = await seedTriageTenant(db, { confidenceThreshold: 0.5 });

    const model = new MockModelClient({
      fixtures: {
        // Recorded reality: the same words at different volume get different
        // urgency. A case-folded cache would serve one of these for the other.
        ...fixtureFor(prompt, shouted, validAnswer({ label: 'complaint', confidence: 0.95, urgency: 'high' })),
        ...fixtureFor(prompt, quiet, validAnswer({ label: 'complaint', confidence: 0.8, urgency: 'normal' })),
      },
    });
    const deps = triageDeps({ db, prompt, model, clock });

    const a = await classifyReply(deps, await seedReply(db, tenantId, shouted));
    const b = await classifyReply(deps, await seedReply(db, tenantId, quiet));

    expect(model.calls, 'two calls, deliberately').toBe(2);
    expect(a.extracted['urgency']).toBe('high');
    expect(b.extracted['urgency']).toBe('normal');
    // Line endings and trailing whitespace DO fold, which is the variation that
    // genuinely is not information.
    expect(contentHash('a\r\nb  \n')).toBe(contentHash('a\nb'));
  });
});
