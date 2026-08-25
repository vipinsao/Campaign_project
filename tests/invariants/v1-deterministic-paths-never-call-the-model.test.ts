/**
 * V1 — DETERMINISTIC PATHS NEVER CALL THE MODEL.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * This is the thesis of packages/triage, and this file is the proof rather than
 * the claim.
 *
 * The whole pipeline is wired up with `ThrowingModelClient`, which rejects on any
 * call. Every fixture below is then pushed through it. If ANY of them needs a
 * model — an opt-out written in an unexpected case, an order number, a
 * redelivered duplicate — the suite does not degrade, produce a worse answer, or
 * log a warning. It fails.
 *
 * The failure this prevents is the one that only appears when the vendor does:
 * an outage, a rate limit, an exhausted token budget, a timeout, a malformed
 * response. If opt-out detection sits behind any of those, then every one of them
 * is a customer who typed STOP and kept receiving messages — a PECR/GDPR matter in
 * the UK/EU and TCPA exposure per message in the US. The correct architecture is
 * not "the model is very accurate at detecting STOP". It is "the model is not in
 * the path at all", and that is only true if something checks.
 *
 * The three deterministic responsibilities exercised here are the three that must
 * give the same answer twice:
 *
 *   permission  — opt-out keyword detection      (32 fixtures)
 *   identity    — order-number resolution         (5 fixtures)
 *   idempotence — duplicate / cached input        (3 fixtures)
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedContact } from '../support/fixtures.ts';
import {
  classifyReply,
  contentHash,
  detectOptOut,
  extractOrderNumber,
  findDuplicateReply,
  ThrowingModelClient,
} from '@campaign/triage';
import { seedReply, seedTriageTenant, syncedPrompt, triageDeps } from './triage-harness.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

/**
 * Opt-out fixtures. Every one of these is a real shape a carrier or an email
 * client actually delivers: shouted, whispered, padded, punctuated, wrapped in
 * smart quotes, spaced out one letter at a time by a phone keyboard, or carrying
 * an invisible byte-order mark from a copy-paste.
 */
const OPT_OUT_FIXTURES: readonly { body: string; why: string }[] = [
  { body: 'STOP', why: 'the canonical carrier keyword' },
  { body: 'stop', why: 'lower case' },
  { body: 'Stop', why: 'sentence case' },
  { body: 'sToP', why: 'mixed case' },
  { body: '  STOP  ', why: 'leading and trailing spaces' },
  { body: '\n\nSTOP\n\n', why: 'wrapped in blank lines' },
  { body: '\tSTOP\t', why: 'tabs' },
  { body: 'STOP.', why: 'trailing full stop' },
  { body: 'stop!', why: 'trailing exclamation' },
  { body: 'STOP!!!', why: 'shouted with repeated punctuation' },
  { body: 'stop;', why: 'trailing semicolon' },
  { body: '"STOP"', why: 'straight quotes' },
  { body: '“STOP”', why: 'smart quotes from a phone keyboard' },
  { body: 'STOP​', why: 'trailing zero-width space' },
  { body: '﻿stop', why: 'leading byte-order mark from a copy-paste' },
  { body: 'S T O P', why: 'letters spaced out' },
  { body: 'UNSUBSCRIBE', why: 'the email-side keyword' },
  { body: 'unsubscribe', why: 'lower case' },
  { body: 'Unsubscribe.', why: 'sentence case with a full stop' },
  { body: '  UNSUBSCRIBE  ', why: 'padded' },
  { body: 'unsubscribe!!', why: 'punctuated' },
  { body: 'CANCEL', why: 'carrier keyword' },
  { body: 'cancel', why: 'lower case' },
  { body: 'Cancel!', why: 'sentence case, punctuated' },
  { body: 'END', why: 'carrier keyword' },
  { body: 'end', why: 'lower case' },
  { body: 'End.', why: 'sentence case' },
  { body: 'QUIT', why: 'carrier keyword' },
  { body: 'quit.', why: 'lower case with a full stop' },
  { body: 'STOPALL', why: 'the compound carrier keyword' },
  { body: 'STOP ALL', why: 'the compound keyword split by a space' },
  { body: 'stop  all', why: 'split with doubled whitespace' },
  { body: 'OPTOUT', why: 'the written-out form' },
  { body: 'opt out', why: 'the written-out form, spaced' },
  { body: 'REVOKE', why: 'the consent-revocation form' },
];

describe('V1 — the deterministic paths never call the model', () => {
  it(`resolves all ${OPT_OUT_FIXTURES.length} opt-out fixtures with the model client throwing`, async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const model = new ThrowingModelClient();
    const deps = triageDeps({ db, prompt, model });

    // Enough fixtures that this is a claim about the RULE, not about the examples.
    expect(OPT_OUT_FIXTURES.length).toBeGreaterThanOrEqual(30);

    for (const fixture of OPT_OUT_FIXTURES) {
      const reply = await seedReply(db, tenantId, fixture.body, { channel: 'sms' });
      const result = await classifyReply(deps, reply);

      expect(result.label, `'${fixture.body}' (${fixture.why})`).toBe('opt_out');
      expect(result.decidedBy, `'${fixture.body}' (${fixture.why})`).toBe('deterministic');
      expect(result.status).toBe('auto');
      expect(result.confidence).toBe(1);
      expect(result.promptId).toBeNull();
      expect(result.suppressed).toBe(true);
      // V10 leans on this too: an opt-out never produces an automatic reply.
      expect(result.autoSendAllowed).toBe(false);
    }

    expect(
      model.attempts,
      'a deterministic opt-out reached for the model:\n' +
        model.attempts.map((a) => a.inputHash).join('\n'),
    ).toEqual([]);

    // The invariant is also visible in SQL, which is the form an auditor can check
    // without reading any TypeScript.
    const { rows: decided } = await db.query<{ decided_by: string; n: string }>(
      `SELECT decided_by, count(*)::text AS n FROM classifications GROUP BY decided_by`,
    );
    expect(decided).toEqual([{ decided_by: 'deterministic', n: String(OPT_OUT_FIXTURES.length) }]);

    const { rows: calls } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_calls`,
    );
    expect(Number(calls[0]!.n), 'a deterministic decision must cost nothing').toBe(0);

    // And the suppressions are real rows, written by the add-only capability.
    const { rows: suppressed } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM suppressions WHERE reason = 'sms_stop'`,
    );
    expect(Number(suppressed[0]!.n)).toBe(OPT_OUT_FIXTURES.length);
  });

  it('resolves order numbers from a regex and a database check, never a model', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const contactId = await seedContact(db, tenantId, {});
    const otherContactId = await seedContact(db, tenantId, {});

    const { rows: stores } = await db.query<{ id: string }>(
      `INSERT INTO stores (tenant_id, name, code)
       VALUES ($1,'Main','main'), ($1,'Outlet','outlet') RETURNING id`,
      [tenantId],
    );
    const mainStore = stores[0]!.id;
    const outletStore = stores[1]!.id;

    const order = async (storeId: string, contact: string, number: string): Promise<void> => {
      await db.query(
        `INSERT INTO orders (tenant_id, store_id, contact_id, order_number, status, total, placed_at)
         VALUES ($1,$2,$3,$4,'placed',49.99,'2026-08-01T00:00:00Z')`,
        [tenantId, storeId, contact, number],
      );
    };
    await order(mainStore, contactId, '10041');
    await order(mainStore, contactId, 'ORD-88120');
    // The same order number in a second store, belonging to a DIFFERENT customer.
    // This is the case a model would resolve by picking one, and picking one sends
    // this customer's order details to the other one.
    await order(outletStore, otherContactId, '10041');
    await order(mainStore, contactId, '77123');

    const fixtures: readonly { body: string; kind: string; why: string }[] = [
      { body: 'Any update on order #77123?', kind: 'single', why: 'hash-prefixed, exists once' },
      { body: 'Chasing ORD-88120 please', kind: 'single', why: 'prefixed alphanumeric form' },
      {
        body: 'order number 99999 has not arrived',
        kind: 'none',
        why: 'well-formed but not in the database',
      },
      { body: 'Thanks, all good here!', kind: 'none', why: 'no candidate at all' },
      { body: 'Where is #10041?', kind: 'ambiguous', why: 'two stores, two customers, one number' },
    ];

    for (const fixture of fixtures) {
      const resolution = await extractOrderNumber(fixture.body, db, tenantId);
      expect(resolution.kind, `${fixture.body} (${fixture.why})`).toBe(fixture.kind);
    }

    // `ambiguous` is a distinct arm rather than "first match wins", and it carries
    // both candidates so a human can pick.
    const ambiguous = await extractOrderNumber('Where is #10041?', db, tenantId);
    expect(ambiguous.kind).toBe('ambiguous');
    if (ambiguous.kind === 'ambiguous') {
      expect(ambiguous.candidates).toHaveLength(2);
      expect(new Set(ambiguous.candidates.map((c) => c.store_id))).toEqual(
        new Set([mainStore, outletStore]),
      );
    }

    // A phone number, a postcode and a price must not be read as order numbers.
    for (const body of ['call me on 07700900123', 'my postcode is SW1A 2AA', 'it cost 129.99']) {
      expect((await extractOrderNumber(body, db, tenantId)).kind, body).toBe('none');
    }
  });

  it('detects duplicates and serves cached answers without a model', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const model = new ThrowingModelClient();
    const deps = triageDeps({ db, prompt, model });

    const body = 'Do you deliver to the Isle of Skye?';
    const hash = contentHash(body);

    // A webhook redelivery: identical body, second row.
    const first = await seedReply(db, tenantId, body);
    const second = await seedReply(db, tenantId, body);
    const duplicate = await findDuplicateReply(db, {
      tenantId,
      contentHash: hash,
      excludeReplyId: second.id,
    });
    expect(duplicate?.id).toBe(first.id);

    // Line-ending and trailing-whitespace variants are the SAME reply: SMTP and a
    // webhook differ by exactly that, and paying twice for it is not a feature.
    expect(contentHash('a\r\nb')).toBe(contentHash('a\nb'));
    expect(contentHash('hello   ')).toBe(contentHash('hello'));
    // Case is NOT folded: shouting is information a sentiment judgement uses.
    expect(contentHash('THIS IS UNACCEPTABLE')).not.toBe(contentHash('this is unacceptable'));

    // A previously recorded answer is served from the cache with the client still
    // throwing, which is what makes the redelivery free.
    await db.query(
      `INSERT INTO model_calls
         (tenant_id, prompt_id, model_id, input_hash, raw_output, input_tokens, output_tokens,
          cost_usd, latency_ms, cache_hit, parse_status)
       VALUES ($1,$2,'claude-sonnet-5',$3,$4,400,60,0.0021,850,false,'ok')`,
      [
        tenantId,
        prompt.id,
        hash,
        JSON.stringify({
          label: 'question',
          confidence: 0.94,
          summary: 'Asking whether delivery reaches the Isle of Skye.',
          urgency: 'low',
          entities: { order_number_mentioned: null, product_mentioned: null },
        }),
      ],
    );

    const result = await classifyReply(deps, second);
    expect(result.label).toBe('question');
    expect(result.cacheHit).toBe(true);
    expect(result.costUsd).toBe(0);
    expect(model.attempts).toEqual([]);
  });

  it('does not treat a keyword buried in prose as an opt-out', () => {
    // The other half of the invariant. Matching "contains CANCEL" would suppress
    // an address the customer never asked to suppress, and there is no machine
    // path in this system that can undo a suppression (V9) — so a false positive
    // here is permanent.
    for (const body of [
      'Please cancel my order #4471, but keep sending me the newsletter',
      'I want to stop by the shop on Saturday, are you open?',
      'The film we watched had a terrible end',
      'Can you quit sending them at 6am and send at noon instead?',
    ]) {
      expect(detectOptOut(body).optedOut, body).toBe(false);
    }
  });
});
