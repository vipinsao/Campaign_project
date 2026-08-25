/**
 * V10 — AUTO-SEND DEFAULTS TO OFF, IN THE SCHEMA.
 *
 * Failure it prevents: an autonomous system that starts emailing customers because
 * nobody remembered to turn it off.
 *
 * The default lives in `tenants.auto_send BOOLEAN NOT NULL DEFAULT false`, not in a
 * config file, not in an env var, and not in a constant somewhere in the worker.
 * That placement is the whole point: a fresh clone, a CI run, a demo and a
 * newly-provisioned tenant are all silent, and turning it on takes a deliberate
 * write that leaves a row behind. A default in code is a default one careless
 * `?? true` away from being reversed for everybody at once.
 *
 * The flag is also only the FIRST of four vetoes. The other three are not belt and
 * braces — an uncertain classification, an unlabelled one, and an opt-out have no
 * business generating a customer-facing reply at any setting, and auto-replying to
 * somebody who just said STOP is the single worst message this system could send.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedTenant } from '../support/fixtures.ts';
import { autoSendAllowed, classifyReply, loadTenantTriageSettings, MockModelClient } from '@campaign/triage';
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

describe('V10 — auto-send is off until somebody decides otherwise', () => {
  it('defaults to false in the database for a tenant nobody configured', async () => {
    const db = testDb();
    // seedTenant sets nothing about triage. The default has to come from the schema.
    const tenantId = await seedTenant(db);
    const { rows } = await db.query<{ auto_send: boolean; confidence_threshold: string }>(
      `SELECT auto_send, confidence_threshold::text FROM tenants WHERE id = $1`,
      [tenantId],
    );
    expect(rows[0]!.auto_send).toBe(false);
    expect(rows[0]!.confidence_threshold).toBe('0.75');
  });

  it('refuses to auto-send a confident, valid, positive classification', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const body = 'Loved it, thank you!';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ label: 'positive', confidence: 0.99 })),
    });

    const result = await classifyReply(triageDeps({ db, prompt, model }), await seedReply(db, tenantId, body));

    expect(result.status).toBe('auto');
    expect(result.confidence).toBe(0.99);
    // Nothing about the answer's quality unlocks sending. Only the operator does.
    expect(result.autoSendAllowed).toBe(false);
  });

  it('permits auto-send only once the tenant flag is deliberately set', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db, { autoSend: true });
    const prompt = await syncedPrompt(db, 1);
    const body = 'Do you have a size guide?';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ label: 'question', confidence: 0.95 })),
    });

    const result = await classifyReply(triageDeps({ db, prompt, model }), await seedReply(db, tenantId, body));
    expect(result.autoSendAllowed).toBe(true);
  });

  it('never auto-sends in reply to an opt-out, at any setting', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db, { autoSend: true });
    const prompt = await syncedPrompt(db, 1);
    const model = new MockModelClient({ fixtures: {} });

    const deterministic = await classifyReply(
      triageDeps({ db, prompt, model }),
      await seedReply(db, tenantId, 'STOP', { channel: 'sms' }),
    );
    expect(deterministic.label).toBe('opt_out');
    expect(deterministic.autoSendAllowed).toBe(false);

    const body = 'please remove me from this list';
    const viaModel = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ label: 'opt_out', confidence: 0.99 })),
    });
    const modelDecided = await classifyReply(
      triageDeps({ db, prompt, model: viaModel }),
      await seedReply(db, tenantId, body),
    );
    expect(modelDecided.label).toBe('opt_out');
    expect(modelDecided.autoSendAllowed).toBe(false);
  });

  it('never auto-sends an escalation, because there is no label to reply to', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db, { autoSend: true });
    const prompt = await syncedPrompt(db, 1);
    const model = new MockModelClient({
      fixtures: {},
      synthesise: () => ({ raw: 'not json', modelId: 'claude-sonnet-5', inputTokens: 100, outputTokens: 5 }),
    });

    const result = await classifyReply(triageDeps({ db, prompt, model }), await seedReply(db, tenantId, 'anything'));
    expect(result.label).toBeNull();
    expect(result.autoSendAllowed).toBe(false);
  });

  it('is four independent vetoes, each of which is sufficient on its own', async () => {
    const db = testDb();
    const off = await loadTenantTriageSettings(db, await seedTriageTenant(db, { autoSend: false }));
    const on = await loadTenantTriageSettings(db, await seedTriageTenant(db, { autoSend: true }));

    const ok = {
      label: 'question',
      confidence: 0.99,
      status: 'auto',
      decidedBy: 'model',
      extracted: {},
      cacheHit: false,
      promptId: 'p',
      parseStatus: 'ok',
      costUsd: 0,
      tokens: 0,
      reason: '',
    } as const;

    expect(autoSendAllowed(on, ok)).toBe(true);
    expect(autoSendAllowed(off, ok), 'the tenant flag alone vetoes').toBe(false);
    expect(autoSendAllowed(on, { ...ok, status: 'needs_review' }), 'uncertainty vetoes').toBe(false);
    expect(autoSendAllowed(on, { ...ok, label: null }), 'a missing label vetoes').toBe(false);
    expect(autoSendAllowed(on, { ...ok, label: 'opt_out' }), 'an opt-out vetoes').toBe(false);
  });
});
