/**
 * V8 — IDENTICAL INPUT IS CACHED, ON CONTENT, NEVER ON WALL-CLOCK TIME.
 *
 * Failure it prevents: paying twice for the same answer on a schedule.
 *
 * The instinct is to give the cache a TTL. A TTL says "this answer goes stale on
 * Thursday", which is only true if the inputs changed — and if the inputs changed,
 * the hash changed and the entry was never going to be hit again anyway. What a
 * TTL actually buys is a recurring re-purchase of answers that had not changed.
 *
 * The key is (prompt_id, input_hash), so the correct invalidation trigger is a new
 * PROMPT VERSION, and it invalidates everything at once, exactly and immediately.
 * That is a content hash, not a timestamp. It also means a fixture recorded against
 * v1 can never be silently replayed for v2 — which is the property that keeps the
 * eval harness honest.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { classifyReply, contentHash, MockModelClient, triage } from '@campaign/triage';
import {
  fakeClock,
  fixtureFor,
  seedReply,
  seedTriageTenant,
  syncedPrompt,
  triageDeps,
  validAnswer,
} from './triage-harness.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

describe('V8 — the cache is keyed on content and prompt version', () => {
  it('serves the second identical reply without calling the model', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const body = 'Is the black one back in stock yet?';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ confidence: 0.91 })),
    });
    const deps = triageDeps({ db, prompt, model });

    const first = await classifyReply(deps, await seedReply(db, tenantId, body));
    const second = await classifyReply(deps, await seedReply(db, tenantId, body));

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(model.calls).toBe(1);
    // The cached answer is the SAME answer, not merely a similar one.
    expect(second.label).toBe(first.label);
    expect(second.confidence).toBe(first.confidence);
    expect(second.costUsd).toBe(0);
  });

  it('treats line-ending and trailing-whitespace variants as the same input', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const canonical = 'Line one\nLine two';
    const model = new MockModelClient({ fixtures: fixtureFor(prompt, canonical, validAnswer()) });
    const deps = triageDeps({ db, prompt, model });

    // Exactly how the same reply differs when it arrives via SMTP and via a webhook.
    await classifyReply(deps, await seedReply(db, tenantId, canonical));
    const viaWebhook = await classifyReply(
      deps,
      await seedReply(db, tenantId, 'Line one\r\nLine two   '),
    );

    expect(viaWebhook.cacheHit).toBe(true);
    expect(model.calls).toBe(1);
  });

  it('does NOT conflate different casing, because shouting is information', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const shouted = 'THIS IS COMPLETELY UNACCEPTABLE';
    const quiet = 'this is completely unacceptable';

    expect(contentHash(shouted)).not.toBe(contentHash(quiet));

    const model = new MockModelClient({
      fixtures: {
        ...fixtureFor(
          prompt,
          shouted,
          validAnswer({ label: 'complaint', urgency: 'high', confidence: 0.97 }),
        ),
        ...fixtureFor(
          prompt,
          quiet,
          validAnswer({ label: 'complaint', urgency: 'normal', confidence: 0.88 }),
        ),
      },
    });
    const deps = triageDeps({ db, prompt, model });

    const a = await classifyReply(deps, await seedReply(db, tenantId, shouted));
    const b = await classifyReply(deps, await seedReply(db, tenantId, quiet));

    expect(model.calls, 'a cache that folded case would serve the wrong urgency for free').toBe(2);
    expect(a.extracted['urgency']).toBe('high');
    expect(b.extracted['urgency']).toBe('normal');
  });

  it('invalidates on a new prompt version, which is the only correct trigger', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const v1 = await syncedPrompt(db, 1);
    const v2 = await syncedPrompt(db, 2);
    const body = 'Can I swap the size?';

    const model = new MockModelClient({
      fixtures: {
        ...fixtureFor(v1, body, validAnswer({ label: 'question', confidence: 0.9 })),
        ...fixtureFor(v2, body, validAnswer({ label: 'other', confidence: 0.97 })),
      },
    });

    const underV1 = await classifyReply(
      triageDeps({ db, prompt: v1, model }),
      await seedReply(db, tenantId, body),
    );
    const underV2 = await classifyReply(
      triageDeps({ db, prompt: v2, model }),
      await seedReply(db, tenantId, body),
    );

    expect(underV1.cacheHit).toBe(false);
    expect(underV2.cacheHit, 'a v1 answer must never be served for v2').toBe(false);
    expect(model.calls).toBe(2);
    expect(underV1.label).toBe('question');
    expect(underV2.label).toBe('other');
  });

  it('has no TTL: time moving forward does not expire an entry', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const body = 'Do you do gift wrapping?';
    const model = new MockModelClient({ fixtures: fixtureFor(prompt, body, validAnswer()) });

    const clock = fakeClock();
    await triage(triageDeps({ db, prompt, model, clock }), {
      tenantId,
      channel: 'email',
      fromAddress: 'a@example.com',
      body,
    });

    // A year later. The inputs have not changed, so neither has the right answer.
    clock.advanceDays(365);
    const result = await triage(triageDeps({ db, prompt, model, clock }), {
      tenantId,
      channel: 'email',
      fromAddress: 'a@example.com',
      body,
    });

    expect(result.cacheHit).toBe(true);
    expect(model.calls).toBe(1);
  });

  it('does not serve a repaired answer from the cache', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const body = 'An input that needs a second attempt.';

    let call = 0;
    const model = new MockModelClient({
      fixtures: {},
      synthesise: () => {
        call += 1;
        return {
          raw: call === 1 ? '{"label":"other"}' : JSON.stringify(validAnswer({ label: 'other' })),
          modelId: 'claude-sonnet-5',
          inputTokens: 200,
          outputTokens: 20,
        };
      },
    });
    const deps = triageDeps({ db, prompt, model });

    const first = await classifyReply(deps, await seedReply(db, tenantId, body));
    expect(first.parseStatus).toBe('retry_ok');

    // A retry_ok answer is deliberately not cached: making one awkward interaction
    // permanent and free would hide from the eval harness that this prompt has an
    // input it cannot answer first time.
    const second = await classifyReply(deps, await seedReply(db, tenantId, body));
    expect(second.cacheHit).toBe(false);
  });

  it('scopes the cache to the prompt, not to the tenant that paid for it', async () => {
    // Deliberate, and worth being explicit about: reply bodies are not
    // tenant-specific secrets, the entry stores only the model's judgement of the
    // text, and a shared cache is what makes "STOP" cost nothing across the estate.
    // If that ever stops being true, the key gains a tenant_id and the change is
    // one line — but it should be a decision, not a default.
    const db = testDb();
    const prompt = await syncedPrompt(db, 1);
    const body = 'Where is my refund?';
    const first = await seedTriageTenant(db);
    const second = await seedTriageTenant(db);
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ label: 'complaint' })),
    });
    const deps = triageDeps({ db, prompt, model });

    await classifyReply(deps, await seedReply(db, first, body));
    const across = await classifyReply(deps, await seedReply(db, second, body));

    expect(across.cacheHit).toBe(true);
    expect(model.calls).toBe(1);
  });
});
