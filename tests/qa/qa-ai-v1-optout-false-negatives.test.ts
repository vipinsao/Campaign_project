/**
 * QA / REGRESSION — V1, direction 1: opt-outs that must be recognised WITHOUT a
 * model, and the shapes that are still allowed to reach one.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE GUARDS. An adversarial pass found `detectOptOut` matching the
 * WHOLE normalised message, so any opt-out carrying one extra token fell through
 * to the model — where the budget ceiling (V7), a vendor 503 and a schema
 * violation (V5) all apply. That is fixed (D20), and this file is the guard.
 *
 * V1 as literally written — "the deterministic path never calls the model" — was
 * always true: `detectOptOut` has no model client in scope. What was NOT true was
 * the claim V1 is actually FOR, from
 * v1-deterministic-paths-never-call-the-model.ts:
 *
 *   "an outage, a rate limit, an exhausted token budget, a timeout ... every one
 *    of them is a customer who typed STOP and kept receiving messages."
 *
 * That guarantee only exists for messages the keyword matcher recognises, and the
 * two shapes it used to miss were not exotic:
 *
 *   "STOP\n\nSent from my iPhone"  — the default signature on every iOS reply
 *   "STOP\n> On 25 Aug 2026 ..."   — the quoted original, which essentially every
 *                                    desktop and webmail client appends
 *
 * The third was funnier and equally real: repeating the keyword defeated it.
 * "STOP" was an opt-out; "STOP STOP STOP" — a person who is now annoyed — was not.
 *
 * Matching now runs on the FIRST LINE of the human-typed portion (signatures,
 * quoted replies and forwarded headers stripped) and succeeds when every token on
 * that line is a keyword. Every fixture in NOW_DETERMINISTIC below is run through
 * the real `classifyReply` with `ThrowingModelClient` installed — the exact
 * simulation of "the vendor is down" — and every one of them must suppress anyway.
 *
 * The failure this prevents: a vendor outage during which customers who typed STOP
 * keep receiving marketing. In the UK/EU that is PECR/GDPR; in the US it is TCPA,
 * priced per message.
 *
 * STILL_REACHES_THE_MODEL is the other half, and it is deliberate rather than
 * missing — see the comment on that list.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { activeSuppression, FakeClock } from '@campaign/core';
import {
  classifyReply,
  detectOptOut,
  ModelCalledError,
  ThrowingModelClient,
} from '@campaign/triage';
import {
  CLOCK_START,
  seedReply,
  seedTriageTenant,
  syncedPrompt,
  triageDeps,
} from '../invariants/triage-harness.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

/**
 * The physical shapes a real opt-out arrives in. Every one of these used to fall
 * through to the model; every one of them must now be decided by the keyword
 * matcher, on a channel where the keyword applies.
 */
const NOW_DETERMINISTIC: readonly { body: string; why: string }[] = [
  {
    body: 'STOP\n\nSent from my iPhone',
    why: 'the iOS default signature — the single most common shape of a mobile email reply',
  },
  {
    body: 'STOP\n\n> On 25 Aug 2026, at 09:14, Acme <hello@acme.example> wrote:\n> Your 20% off code is inside.',
    why: 'the quoted original, appended by essentially every desktop and webmail client',
  },
  {
    body: 'UNSUBSCRIBE\nThanks',
    why: 'one polite word of trailing courtesy on the line after the instruction',
  },
  {
    body: 'STOP STOP STOP',
    why: 'repeating the keyword must not DEFEAT it — the annoyed second attempt',
  },
  {
    body: 'STOP.\n\n--\nJane Smith\nSent from my phone',
    why: 'signature separator plus a name block',
  },
  {
    body: 'STOP\n\n-----Original Message-----\nFrom: Acme <hello@acme.example>\nSubject: 20% off',
    why: 'the Outlook forwarded-header block',
  },
];

/**
 * CHARACTERISATION, not a gap that was left open by accident.
 *
 * These are prose, or they are English keywords in another alphabet. Prose is
 * exactly what the model is for: "unsubscribe me" is a sentence, and acting on a
 * sentence deterministically is how "Please cancel my order #4471, but keep
 * sending me the newsletter" becomes a permanent suppression. The matcher's rule
 * is "every token on the first line is a keyword", so a sentence goes to the
 * classifier, comes back with a confidence, and — because the classifier's only
 * consent capability is add-only `addSuppression` (V9) — the worst outcome is
 * suppressing someone who half-asked for it, never the reverse.
 *
 * The non-English fixtures are a real coverage limit and are recorded as one: NFKC
 * folds compatibility forms, not confusables, so Cyrillic С/Т/О/Р never normalise
 * to STOP, and the keyword list is English-only. A UK/EU deployment does receive
 * these. They reach the model, which is a degradation under a vendor outage rather
 * than a silent drop — but it is still a degradation, and it is the reason this
 * list is asserted rather than deleted.
 */
const STILL_REACHES_THE_MODEL: readonly { body: string; why: string }[] = [
  { body: 'Please STOP sending', why: 'the keyword with a verb around it' },
  { body: 'stop please', why: 'the keyword with one word of politeness' },
  { body: 'Unsubscribe me', why: 'the emailed form with an object' },
  { body: 'Please unsubscribe me', why: 'the emailed form, politely' },
  { body: 'Stop it', why: 'terse and unambiguous to a human, still a sentence' },
  { body: 'RE: your order — STOP', why: 'a subject line carried into the body' },
  { body: 'СТОП', why: 'Cyrillic STOP (a real Russian-language opt-out)' },
  { body: 'SТOP', why: 'Latin S, Cyrillic Т, Latin OP — a homoglyph mix' },
  { body: 'ЅТОР', why: 'all four characters Cyrillic lookalikes' },
  { body: 'ARRÊTER', why: 'French' },
  { body: 'ARRET', why: 'French, unaccented — the SMS form' },
  { body: 'BAJA', why: 'Spanish — the standard Spanish carrier keyword' },
  { body: 'DESUSCRIBIR', why: 'Spanish' },
  { body: 'ABBESTELLEN', why: 'German' },
  { body: 'STOPP', why: 'German/Swedish' },
];

/** Inputs the normaliser already got right, kept so a regression in the
 *  normaliser is not mistaken for a regression in the first-line rule. */
const CORRECTLY_DETERMINISTIC: readonly { body: string; why: string }[] = [
  { body: 'stop.', why: 'trailing punctuation is stripped' },
  { body: 'STOP?', why: 'any punctuation, in fact' },
  { body: 'ＳＴＯＰ', why: 'fullwidth — NFKC folds compatibility forms' },
  { body: 'ＳＴＯＰ ＡＬＬ', why: 'fullwidth compound, collapsed to STOPALL' },
  { body: '​STOP​', why: 'zero-width space on both sides' },
  { body: '﻿stop', why: 'leading byte-order mark' },
  { body: '#stop', why: 'a hashtag: the symbol becomes a space and is trimmed' },
  { body: '🛑 STOP', why: 'emoji is a symbol, stripped' },
  { body: 'unsubscribe', why: 'exactly the keyword' },
];

describe('QA/V1 — the deterministic pass covers the shapes an opt-out arrives in', () => {
  it('the normaliser handles the shapes it claims to', () => {
    for (const fixture of CORRECTLY_DETERMINISTIC) {
      expect(
        detectOptOut(fixture.body).optedOut,
        `${JSON.stringify(fixture.body)} (${fixture.why})`,
      ).toBe(true);
    }
  });

  it('GUARD: signatures, quoted replies and repeated keywords do not defeat an opt-out', () => {
    const missed = NOW_DETERMINISTIC.filter(
      (f) => !detectOptOut(f.body, 'email').optedOut || !detectOptOut(f.body, 'sms').optedOut,
    );
    expect(
      missed.map((m) => `${JSON.stringify(m.body)} (${m.why})`),
      'every one of these used to fall through to the model, on both channels',
    ).toEqual([]);
  });

  it('CHARACTERISATION: prose and non-English keywords still go to the model', () => {
    // Deliberate. A sentence is the model's job; see the comment on the list. If
    // one of these ever starts matching deterministically, that is a false-positive
    // risk and this test failing is the right place to argue about it.
    const matched = STILL_REACHES_THE_MODEL.filter((f) => detectOptOut(f.body, 'email').optedOut);
    expect(matched.map((m) => m.body)).toEqual([]);
  });

  it('GUARD: with the vendor down, an emailed STOP + signature IS suppressed', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const model = new ThrowingModelClient();
    const deps = triageDeps({ db, prompt, model, clock });

    const address = 'iphone-user@example.com';
    const reply = await seedReply(db, tenantId, 'STOP\n\nSent from my iPhone', {
      channel: 'email',
      fromAddress: address,
    });

    // ThrowingModelClient IS the outage: any call at all throws. The pipeline must
    // not need it, because this decision is a keyword table lookup.
    const result = await classifyReply(deps, reply);
    expect(result.decidedBy).toBe('deterministic');
    expect(result.label).toBe('opt_out');
    expect(result.suppressed).toBe(true);
    expect(model.attempts, 'the model was not consulted, so it cannot fail').toHaveLength(0);

    expect(
      await activeSuppression(db, { tenantId, channel: 'email', address, clock }),
      'a customer who typed STOP is suppressed even when the vendor is unreachable',
    ).toBeDefined();

    // Provable from SQL alone: a deterministic decision, with no prompt behind it.
    const { rows } = await db.query<{ decided_by: string; prompt_id: string | null }>(
      `SELECT decided_by, prompt_id FROM classifications WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decided_by).toBe('deterministic');
    expect(rows[0]!.prompt_id).toBeNull();
  });

  it('GUARD: every real-world shape suppresses under a total vendor outage', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const model = new ThrowingModelClient();
    const deps = triageDeps({ db, prompt, model });

    for (const fixture of NOW_DETERMINISTIC) {
      const reply = await seedReply(db, tenantId, fixture.body, { channel: 'email' });
      const result = await classifyReply(deps, reply);
      expect(result.suppressed, `${JSON.stringify(fixture.body)} (${fixture.why})`).toBe(true);
    }

    expect(model.attempts, 'not one of them reached the model').toHaveLength(0);

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM suppressions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(NOW_DETERMINISTIC.length);
  });

  it('GUARD: prose still reaches the model, and an outage there is visible, not silent', async () => {
    // The other side of the same boundary: a sentence is NOT decided by keyword, so
    // under an outage it raises rather than being quietly dropped or quietly acted
    // on. Losing this would mean either a silent drop or a deterministic guess.
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const model = new ThrowingModelClient();
    const deps = triageDeps({ db, prompt, model });

    const reply = await seedReply(db, tenantId, 'Please unsubscribe me', { channel: 'email' });
    await expect(classifyReply(deps, reply)).rejects.toBeInstanceOf(ModelCalledError);
    expect(model.attempts).toHaveLength(1);
  });

  it('GUARD: "STOP" is an opt-out, and so is "STOP STOP STOP"', () => {
    // The clearest single demonstration that the rule is conservative in both
    // directions: a repeated keyword is a strictly stronger statement of the same
    // intent, and used to be weaker than a single one.
    expect(detectOptOut('STOP').optedOut).toBe(true);
    expect(detectOptOut('STOP STOP STOP').optedOut).toBe(true);
    expect(detectOptOut('stop stop').optedOut).toBe(true);
    // ...and non-keyword tokens still carry the meaning, so these do not fire.
    expect(detectOptOut("don't stop sending me these").optedOut).toBe(false);
    expect(detectOptOut('stop by our store').optedOut).toBe(false);
  });
});
