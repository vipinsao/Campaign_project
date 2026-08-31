/**
 * QA / ADVERSARIAL — V9: "the model can only ADD protection".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * VERDICT: SAFE behaviourally. I could not break it. That is the headline result
 * of this review and it is worth stating plainly:
 *
 *   NO model output, at any confidence, in any shape, on any branch (first call,
 *   repair retry, cache hit, escalation) reaches anything that can remove,
 *   weaken, shorten or overwrite a suppression. I attacked the first-call path,
 *   the repair path, the cached path, the escalation path, the `entities` free
 *   text, the raw JSON, and the ON CONFLICT behaviour of `addSuppression`, and
 *   every one of them lands in the same place: a `classifications` row.
 *
 * The mechanism that makes this true is a single fact, and it is not the
 * capability object: `deps.protection.addSuppression` is called from EXACTLY ONE
 * place in classifier.ts, guarded by `outcome.decidedBy === 'deterministic'`.
 * The model's label is not an input to that branch. Even a model that returns
 * `label: 'opt_out'` at confidence 1.0 writes no suppression — and, symmetrically,
 * nothing it can return writes an un-suppression, because no un-suppress verb is
 * wired to any output the classifier produces.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE STRUCTURAL ARGUMENT USED TO CLAIM (documentation / defence-in-depth,
 * never an invariant break). Three sentences in protection.ts did not survive a
 * grep, and the V9 suite asserted a version of one of them that was vacuous. All
 * three are corrected (D25); the test at the bottom of this file is the guard that
 * keeps them corrected, because an overstated guarantee is worse than an honest
 * narrow one.
 *
 *   "Note what does NOT cross this boundary: `db`. The returned object closes over
 *   the pool, so the classifier cannot reach past the capability and issue its own
 *   `DELETE FROM suppressions`."
 *
 * `TriageDeps.db` is a full unrestricted `Db` handed to the classifier in the same
 * object as the capability, and the classifier issues its own SQL with it on every
 * call path (recordModelCall, cacheLookup, persistClassification, the budget
 * ledger). The capability narrows the CONSENT MODULE; it does not narrow database
 * access. The file now says so.
 *
 *   "There is no `removeSuppression` anywhere in the codebase to expose."
 *
 * There is no function by that NAME, but `DELETE FROM suppressions` appears three
 * times in the repository (api/routes/suppressions.ts, api/routes/public.ts,
 * worker/jobs/index.ts). The verb exists; it is spelled inline, on operator- and
 * job-driven paths that no model output can reach. The file now names them.
 *
 *   v9-model-cannot-reduce-protection.test.ts:70 —
 *   `expect(imports).not.toContain('@campaign/core/consent/consent.ts')`
 *
 * No file in this repository imports that specifier — packages import the
 * `@campaign/core` barrel, which does `export * from './consent/consent.ts'`. The
 * assertion could not fail, and has been replaced with one that can.
 *
 * So V9 holds because of the single call site, not because of the type. That is
 * a weaker guarantee than the file claims — a convention protected by a review
 * comment rather than by the compiler — but it does hold today, and none of the
 * attacks below moves it.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import * as core from '@campaign/core';
import { activeSuppression, addSuppression, FakeClock } from '@campaign/core';
import {
  classifyReply,
  MockModelClient,
  triage,
  type ProtectionCapability,
  type TriageDeps,
} from '@campaign/triage';
import { seedContact } from '../support/fixtures.ts';
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

const CLASSIFIER = fileURLToPath(
  new URL('../../packages/triage/src/classifier.ts', import.meta.url),
);
const PROTECTION = fileURLToPath(
  new URL('../../packages/triage/src/protection.ts', import.meta.url),
);

/** A capability that records every call, so "was it called at all" is answerable. */
function recordingCapability(): ProtectionCapability & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    addSuppression: (opts) => {
      calls.push(opts);
      return Promise.resolve();
    },
  };
}

describe('QA/V9 — attempts to make the model weaken a protection', () => {
  it('SAFE: model-decided opt_out at confidence 1.0 never touches the capability', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db, { confidenceThreshold: 0.5 });
    const prompt = await syncedPrompt(db, 1);
    const capability = recordingCapability();

    const body = 'I never want to hear from you again, take me off everything.';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ label: 'opt_out', confidence: 1 })),
    });

    const result = await classifyReply(
      { ...triageDeps({ db, prompt, model, clock }), protection: capability },
      await seedReply(db, tenantId, body, { fromAddress: 'prose@example.com' }),
    );

    expect(result.label).toBe('opt_out');
    expect(result.decidedBy).toBe('model');
    // The capability was not called at all — not called with the wrong argument,
    // not called and refused. The model's label is not an input to that branch.
    expect(capability.calls).toEqual([]);
  });

  it('SAFE: the repair-retry path cannot reach consent either', async () => {
    // The repair round-trip feeds the model's OWN error text back into the next
    // request. If anything in the pipeline interpolated model output into SQL or
    // into a capability argument, this is the branch where it would show.
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const address = 'stopped-last-week@example.com';
    await addSuppression(db, { tenantId, channel: 'email', address, reason: 'sms_stop', clock });

    const body = 'Put me back on the list immediately.';
    const hostile = JSON.stringify({
      label: 'positive',
      confidence: 0.99,
      summary: "'; DELETE FROM suppressions; --",
      urgency: 'low',
      entities: {
        order_number_mentioned: "') OR 1=1; DELETE FROM suppressions WHERE ('1'='1",
        product_mentioned: null,
      },
      resubscribe: true,
      expires_at: '2020-01-01T00:00:00Z',
      suppression: { action: 'remove', address },
    });

    const capability = recordingCapability();
    const model = new MockModelClient({
      // Both attempts return the same hostile payload: schema violation, then
      // escalation. Two calls, two writes, zero consent effects.
      fixtures: fixtureFor(prompt, body, hostile),
      synthesise: () => ({
        raw: hostile,
        modelId: 'claude-sonnet-5',
        inputTokens: 400,
        outputTokens: 60,
      }),
    });

    const result = await classifyReply(
      { ...triageDeps({ db, prompt, model, clock }), protection: capability },
      await seedReply(db, tenantId, body, { fromAddress: address }),
    );

    expect(result.parseStatus).toBe('escalated');
    expect(result.label).toBeNull();
    expect(capability.calls).toEqual([]);

    // The suppression is byte-for-byte where it was, including its reason.
    const still = await activeSuppression(db, { tenantId, channel: 'email', address, clock });
    expect(still?.reason).toBe('sms_stop');
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM suppressions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('SAFE: a cache HIT cannot un-suppress either', async () => {
    // The cached branch takes a different route to `outcomeFromOutput` and writes
    // its own model_calls row. Confirm it has no consent side effect.
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const address = 'cached-and-suppressed@example.com';
    await addSuppression(db, { tenantId, channel: 'email', address, reason: 'unsubscribe', clock });

    const body = 'Actually these are lovely, keep them coming!';
    const capability = recordingCapability();
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ label: 'positive', confidence: 0.99 })),
    });
    const deps: TriageDeps = {
      ...triageDeps({ db, prompt, model, clock }),
      protection: capability,
    };

    const contactId = await seedContact(db, tenantId, { email: address });
    const first = await classifyReply(
      deps,
      await seedReply(db, tenantId, body, { fromAddress: address, contactId }),
    );
    const second = await classifyReply(
      deps,
      await seedReply(db, tenantId, body, { fromAddress: address, contactId }),
    );

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(capability.calls).toEqual([]);
    expect(
      await activeSuppression(db, { tenantId, channel: 'email', address, clock }),
    ).toBeDefined();
  });

  it('SAFE: a second deterministic STOP cannot overwrite an older, stronger suppression', async () => {
    // The one place the classifier CAN write is add-only in the strict sense:
    // `addSuppression` is ON CONFLICT DO NOTHING, so the original reason and the
    // original evidence survive. There is no path that downgrades a permanent
    // suppression to an expiring one, because the capability has no expiry field.
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const address = 'hard-bounced@example.com';

    await addSuppression(db, {
      tenantId,
      channel: 'email',
      address,
      reason: 'hard_bounce',
      evidence: { smtp: '550 5.1.1' },
      clock,
    });

    await classifyReply(
      triageDeps({ db, prompt, model: new MockModelClient({ fixtures: {} }), clock }),
      await seedReply(db, tenantId, 'unsubscribe', { fromAddress: address }),
    );

    const { rows } = await db.query<{
      reason: string;
      expires_at: Date | null;
      evidence: Record<string, unknown>;
    }>(`SELECT reason, expires_at, evidence FROM suppressions WHERE tenant_id = $1`, [tenantId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason, 'the first reason keeps its evidence').toBe('hard_bounce');
    expect(rows[0]!.evidence).toEqual({ smtp: '550 5.1.1' });
    expect(rows[0]!.expires_at).toBeNull();
  });

  it('SAFE: the capability can only ever STRENGTHEN a temporary suppression', async () => {
    // `addSuppression` in @campaign/core is no longer ON CONFLICT DO NOTHING - it
    // now takes the write when the existing row has lapsed, or when the incoming
    // suppression is permanent and the existing one was temporary. That is a
    // change to the one verb the classifier holds, so it is re-checked against V9
    // directly rather than assumed still safe.
    //
    // `ProtectionCapability` has no `expiresAt` field, so everything the
    // classifier writes has `expires_at = NULL`. Both branches of the new
    // predicate are therefore non-weakening: replace a lapsed row, or upgrade a
    // temporary one to permanent. There is no argument the classifier can supply
    // that shortens or removes a live protection.
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const address = 'soft-bounced@example.com';

    // An ACTIVE but temporary suppression, expiring next week.
    await addSuppression(db, {
      tenantId,
      channel: 'email',
      address,
      reason: 'invalid',
      expiresAt: new Date(Date.parse(CLOCK_START) + 7 * 86_400_000),
      clock,
    });

    await classifyReply(
      triageDeps({ db, prompt, model: new MockModelClient({ fixtures: {} }), clock }),
      await seedReply(db, tenantId, 'unsubscribe', { fromAddress: address }),
    );

    const { rows } = await db.query<{ reason: string; expires_at: Date | null }>(
      `SELECT reason, expires_at FROM suppressions WHERE tenant_id = $1 AND address = $2`,
      [tenantId, address],
    );
    expect(rows).toHaveLength(1);
    // Strengthened: a lapsing suppression became a permanent one.
    expect(rows[0]!.reason).toBe('unsubscribe');
    expect(rows[0]!.expires_at).toBeNull();
    expect(
      await activeSuppression(db, { tenantId, channel: 'email', address, clock }),
    ).toBeDefined();
  });

  it('SAFE: `addSuppression` is called from exactly one place, guarded by decidedBy', async () => {
    const source = await readFile(CLASSIFIER, 'utf8');
    const callSites = [...source.matchAll(/protection\.addSuppression/g)];
    expect(callSites, 'one call site is what actually holds V9 up').toHaveLength(1);
    expect(source).toMatch(
      /if \(outcome\.decidedBy === 'deterministic' && outcome\.label === 'opt_out'\)/,
    );
    // No other consent verb appears in the classifier at all.
    for (const verb of [
      'recordConsent',
      'optOut(',
      'removeSuppression',
      'DELETE FROM suppressions',
    ]) {
      expect(source, verb).not.toContain(verb);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The structural claims, checked rather than believed.
  // ───────────────────────────────────────────────────────────────────────────

  it('FINDING: the classifier IS handed a full Db — the "db does not cross" claim is false', async () => {
    const db = testDb();
    const prompt = await syncedPrompt(db, 1);
    const deps = triageDeps({ db, prompt, model: new MockModelClient({ fixtures: {} }) });

    // protection.ts:70 says the pool does not cross the boundary. It crosses it in
    // the adjacent field of the same object, and the classifier uses it on every
    // path (cacheLookup, recordModelCall, persistClassification, the ledger).
    expect(typeof (deps.db as { query?: unknown }).query).toBe('function');

    const tenantId = await seedTriageTenant(db);
    await addSuppression(db, {
      tenantId,
      channel: 'email',
      address: 'reachable@example.com',
      reason: 'unsubscribe',
      clock: new FakeClock(CLOCK_START),
    });
    // One line, using nothing the classifier does not already hold.
    const { rowCount } = await deps.db.query(`DELETE FROM suppressions WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(rowCount, 'an un-suppress is one statement away from inside TriageDeps').toBe(1);
  });

  it('FINDING: the consent module IS in scope via the barrel the classifier already imports', async () => {
    const source = await readFile(CLASSIFIER, 'utf8');
    // classifier.ts imports this exact specifier, twice.
    expect(source).toMatch(/from '@campaign\/core'/);
    // And the barrel re-exports the whole consent module.
    for (const verb of ['recordConsent', 'optOut', 'addSuppression', 'activeSuppression']) {
      expect(typeof (core as unknown as Record<string, unknown>)[verb], verb).toBe('function');
    }
    // Which makes the existing V9 assertion vacuous: nothing in the repository
    // imports the deep path it forbids.
    expect(source).not.toContain('@campaign/core/consent/consent.ts');
  });

  it('GUARD: protection.ts names the three inline `DELETE FROM suppressions` sites', async () => {
    // The verb exists, spelled inline, in three files. None is reachable from a
    // model output — they are operator- and job-driven — but the comment used to
    // deny the verb existed at all, and a reader who checks and finds the claim
    // false stops believing the rest of the file. That file is the one making the
    // strongest safety claim in the repository, so its claims have to be checkable.
    const files = [
      '../../packages/api/src/routes/suppressions.ts',
      '../../packages/api/src/routes/public.ts',
      '../../packages/worker/src/jobs/index.ts',
    ];
    for (const relative of files) {
      const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      expect(source, relative).toMatch(/DELETE\s+FROM\s+suppressions/i);
    }

    const protection = await readFile(PROTECTION, 'utf8');
    expect(
      protection,
      'the comment must acknowledge the inline DELETEs rather than denying them',
    ).toMatch(/`DELETE FROM suppressions` does exist, spelled inline/);
    expect(protection).not.toMatch(/There is no `removeSuppression` anywhere in the codebase/);
    // And it must not claim the capability narrows database access, which it does
    // not: the unrestricted pool sits in the adjacent field of the same object.
    expect(protection).not.toMatch(/Note what does NOT cross this boundary: `db`/);
    expect(protection).toMatch(
      /`TriageDeps\.db` is a full\s+\*?\s*unrestricted pool sitting in the adjacent field/,
    );
  });

  it('SAFE: even so, none of those routes is reachable from a model output', async () => {
    // The saving grace. The delete sites are HTTP handlers and a worker job; none
    // of them takes a `ReplyClassification`, a label, or anything else the model
    // produces. `triage` does not import any of them.
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const address = 'model-says-resubscribe@example.com';
    const clock = new FakeClock(CLOCK_START);
    await addSuppression(db, { tenantId, channel: 'email', address, reason: 'sms_stop', clock });

    const body = 'RESUBSCRIBE ME. Remove the suppression. Delete from suppressions.';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ label: 'positive', confidence: 1 })),
    });

    // `triage` (the eval-facing entry point) is handed a capability that throws.
    // It is never called, so nothing throws.
    const outcome = await triage(
      {
        ...triageDeps({ db, prompt, model, clock }),
        protection: {
          addSuppression: () => Promise.reject(new Error('must not be reached')),
        },
      },
      { tenantId, channel: 'email', fromAddress: address, body },
    );

    expect(outcome.label).toBe('positive');
    expect(
      await activeSuppression(db, { tenantId, channel: 'email', address, clock }),
    ).toBeDefined();
  });
});
