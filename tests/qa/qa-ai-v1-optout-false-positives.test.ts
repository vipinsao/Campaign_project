/**
 * QA / REGRESSION — V1, direction 2: messages that are NOT opt-outs and must not
 * be turned into a permanent suppression.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE GUARDS. An adversarial pass found the SMS carrier keywords —
 * CANCEL / END / QUIT / REVOKE — being applied to EMAIL replies as well. That is
 * fixed (D20): the carrier list now applies where the carrier requires it, and
 * nowhere else. These tests are the guard.
 *
 * This is the dangerous direction. `classifyReply` writes a suppression on the
 * deterministic branch with `expires_at = NULL` (permanent — the capability type
 * has no `expiresAt` field to set), and there is no machine un-suppress path.
 * `notSuppressed` in the delivery orchestrator has NO transactional exemption
 * (contrast the consent gate, which does — D5), so a false positive silently
 * blocks that address from order confirmations, refund notices and shipping
 * updates as well as marketing — permanently, for the whole tenant, on that
 * channel.
 *
 * The failure this prevents, concretely: "Your order #10041 is confirmed. Reply
 * CANCEL within 30 minutes to cancel it." The customer replies exactly as told,
 * and used to be permanently suppressed — which then stopped their own refund
 * confirmation, because the suppression gate has no transactional exemption.
 *
 * The three the reviewer asked about were always SAFE:
 *   "don't stop sending me these"  → not matched
 *   "stop by our store"            → not matched
 *   "I'll stop in tomorrow"        → not matched
 *
 * STOP / STOPALL / UNSUBSCRIBE / OPTOUT remain universal, and the argument for
 * them is sound on both channels: a customer who replies "UNSUBSCRIBE" to an email
 * means it just as much as one who texts it. What does not transfer is CANCEL,
 * which on email far more often means "cancel my order".
 *
 * What remains, and is asserted below rather than deleted: on SMS a bare "Cancel"
 * IS a permanent, self-service-proof `sms_stop` suppression, because that is what
 * the carriers require; and the whitespace-collapsing rule still turns "Can cel"
 * into one. Both are characterised, not celebrated.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { activeSuppression, FakeClock } from '@campaign/core';
import {
  classifyReply,
  detectOptOut,
  ModelCalledError,
  SMS_CARRIER_OPT_OUT_KEYWORDS,
  ThrowingModelClient,
  UNIVERSAL_OPT_OUT_KEYWORDS,
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

const ORCHESTRATOR = fileURLToPath(
  new URL('../../packages/core/src/delivery/orchestrator.ts', import.meta.url),
);

describe('QA/V1 — deterministic false positives', () => {
  it('SAFE: the three obvious traps are handled correctly', () => {
    // The whole-message rule earns its keep here. These all contain a keyword and
    // none of them fires.
    for (const body of [
      "don't stop sending me these",
      'Please don’t stop sending me these!',
      'stop by our store',
      "I'll stop in tomorrow",
      'Stop it, these are great',
      'quit smoking ads please',
      'END OF MESSAGE',
      'CANCEL MY ORDER',
      'cancel order 10041',
      'Please cancel my order #4471, but keep sending me the newsletter',
      'Can you cancel the second one?',
      'we had to end the call early',
    ]) {
      expect(detectOptOut(body).optedOut, body).toBe(false);
    }
  });

  it('GUARD: a bare "Cancel" on EMAIL is not an opt-out, and writes no suppression', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    // ThrowingModelClient proves where the decision now goes: this is prose as far
    // as the deterministic layer is concerned, so it reaches the model — which is
    // the only place a judgement about ambiguous intent belongs.
    const deps = triageDeps({ db, prompt, model: new ThrowingModelClient(), clock });

    const address = 'wants-to-cancel-an-order@example.com';
    // The realistic provenance: "Your order #10041 is confirmed. Reply CANCEL
    // within 30 minutes to cancel it." The customer replies exactly as told.
    const reply = await seedReply(db, tenantId, 'Cancel', {
      channel: 'email',
      fromAddress: address,
    });

    expect(detectOptOut('Cancel', 'email').optedOut).toBe(false);
    await expect(
      classifyReply(deps, reply),
      'no longer decided by a keyword table: it goes to the model',
    ).rejects.toBeInstanceOf(ModelCalledError);

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM suppressions WHERE tenant_id = $1 AND address = $2`,
      [tenantId, address],
    );
    expect(
      Number(rows[0]!.n),
      'a permanent suppression, unreachable by any machine undo, for an order cancellation',
    ).toBe(0);
    expect(
      await activeSuppression(db, { tenantId, channel: 'email', address, clock }),
    ).toBeUndefined();
  });

  it('CHARACTERISATION: on SMS the same word IS a permanent suppression, as the carriers require', async () => {
    // Not a regression — the point of the split. On a short code a bare "Cancel"
    // unambiguously means stop texting me, and the carrier requires it to be
    // honoured. It is still permanent and still not self-serviceable (see the
    // RECOVERY test below), which is the cost of honouring it.
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const deps = triageDeps({ db, prompt, model: new ThrowingModelClient(), clock });

    const phone = '+447700900123';
    const result = await classifyReply(
      deps,
      await seedReply(db, tenantId, 'Cancel', { channel: 'sms', fromAddress: phone }),
    );

    expect(result.label).toBe('opt_out');
    expect(result.decidedBy).toBe('deterministic');
    expect(result.suppressed).toBe(true);

    const { rows } = await db.query<{ reason: string; expires_at: Date | null }>(
      `SELECT reason, expires_at FROM suppressions WHERE tenant_id = $1 AND address = $2`,
      [tenantId, phone],
    );
    expect(rows).toHaveLength(1);
    // NULL expiry = permanent. `ProtectionCapability.addSuppression` has no
    // `expiresAt` parameter, so nothing on this path can create a lapsing one.
    expect(rows[0]!.expires_at, 'nothing on this path can create a lapsing row').toBeNull();
    expect(
      await activeSuppression(db, { tenantId, channel: 'sms', address: phone, clock }),
    ).toBeDefined();
  });

  it('CHARACTERISATION: on SMS the outcome still depends on the word count', () => {
    expect(detectOptOut('Cancel', 'sms').optedOut).toBe(true);
    expect(detectOptOut('cancel.', 'sms').optedOut).toBe(true);
    expect(detectOptOut('Cancel!', 'sms').optedOut).toBe(true);
    // Identical intent, one extra word, opposite and irreversible consequence. On
    // SMS that asymmetry is the carriers' rule rather than this system's choice;
    // on email it no longer exists, because the keyword no longer applies there.
    expect(detectOptOut('Cancel it', 'sms').optedOut).toBe(false);
    expect(detectOptOut('Cancel please', 'sms').optedOut).toBe(false);
    expect(detectOptOut('Cancel my order', 'sms').optedOut).toBe(false);
  });

  it('GUARD: END / QUIT / REVOKE / CANCEL are SMS carrier keywords, and fire on SMS only', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const deps = triageDeps({ db, prompt, model: new ThrowingModelClient(), clock });

    // The keyword split, stated as data so a word cannot quietly move between the
    // two lists: universal words bind on both channels, carrier words on SMS only.
    expect([...UNIVERSAL_OPT_OUT_KEYWORDS]).toEqual(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'OPTOUT']);
    expect([...SMS_CARRIER_OPT_OUT_KEYWORDS]).toEqual(['CANCEL', 'END', 'QUIT', 'REVOKE']);

    const cases = [
      ['End', 'end@example.com', '+447700900001'],
      ['Quit', 'quit@example.com', '+447700900002'],
      ['Revoke', 'revoke@example.com', '+447700900003'],
      ['Cancel', 'cancel@example.com', '+447700900004'],
    ] as const;

    for (const [body, address, phone] of cases) {
      // On EMAIL: not a keyword, so the reply is prose and the model decides.
      expect(detectOptOut(body, 'email').optedOut, `${body} on email`).toBe(false);
      await expect(
        classifyReply(
          deps,
          await seedReply(db, tenantId, body, { channel: 'email', fromAddress: address }),
        ),
        `${body} on email`,
      ).rejects.toBeInstanceOf(ModelCalledError);
      expect(
        await activeSuppression(db, { tenantId, channel: 'email', address, clock }),
        `${body} on email must not suppress`,
      ).toBeUndefined();

      // On SMS: the carrier keyword, honoured deterministically, as required.
      const result = await classifyReply(
        deps,
        await seedReply(db, tenantId, body, { channel: 'sms', fromAddress: phone }),
      );
      expect(result.suppressed, `${body} on sms`).toBe(true);
      expect(
        (await activeSuppression(db, { tenantId, channel: 'sms', address: phone, clock }))?.reason,
        `${body} on sms`,
      ).toBe('sms_stop');
    }
  });

  it('CHARACTERISATION: the collapsed-whitespace rule turns a stray space into a suppression', () => {
    // `detectOptOut` compares the normalised message AND its whitespace-stripped
    // form. That is what makes "S T O P" and "opt out" work — and what makes a
    // typo indistinguishable from a carrier keyword.
    expect(detectOptOut('Can cel', 'sms').optedOut).toBe(true);
    expect(detectOptOut('e n d', 'sms').optedOut).toBe(true);
    expect(detectOptOut('q u i t', 'sms').optedOut).toBe(true);
    expect(detectOptOut('un subscribe', 'email').optedOut).toBe(true);
    expect(detectOptOut('C a n c e l', 'sms').optedOut).toBe(true);
    // On email the carrier words no longer reach this rule at all.
    expect(detectOptOut('Can cel', 'email').optedOut).toBe(false);
  });

  it('there is no machine un-suppress path, so every false positive above is terminal', async () => {
    const db = testDb();
    const source = await readFile(
      fileURLToPath(new URL('../../packages/triage/src/protection.ts', import.meta.url)),
      'utf8',
    );
    // The capability the classifier holds is add-only and has no expiry parameter.
    expect(source).not.toMatch(/expiresAt/);

    // And the suppressions table has no expiry set on this path, so the nightly
    // expiry sweep will never touch these rows either.
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const deps = triageDeps({ db, prompt, model: new ThrowingModelClient() });
    // SMS, because that is where a bare carrier keyword still writes a suppression
    // without a model in the loop. The point being made is about the ROW it writes.
    await classifyReply(
      deps,
      await seedReply(db, tenantId, 'Cancel', { channel: 'sms', fromAddress: '+447700900999' }),
    );
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM suppressions
        WHERE tenant_id = $1 AND expires_at IS NOT NULL`,
      [tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('RECOVERY: an EMAIL false positive is self-serviceable; an SMS one is not', async () => {
    // The public preference centre removes a suppression when a recipient
    // re-enables any category — but only `reason = 'unsubscribe'`.
    const publicRoutes = await readFile(
      fileURLToPath(new URL('../../packages/api/src/routes/public.ts', import.meta.url)),
      'utf8',
    );
    expect(publicRoutes).toMatch(
      /DELETE FROM suppressions\s*\n\s*WHERE tenant_id = \$1 AND channel = \$2 AND address = \$3 AND reason = 'unsubscribe'/,
    );

    // `protectionReasonFor` writes 'unsubscribe' on email and 'sms_stop' on SMS.
    // So a wrongly-suppressed EMAIL address can undo it from the preference
    // centre; a wrongly-suppressed PHONE NUMBER cannot, and needs an operator
    // hitting the authenticated DELETE /suppressions route.
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const deps = triageDeps({ db, prompt, model: new ThrowingModelClient(), clock });

    const phone = '+447700900456';
    await classifyReply(
      deps,
      await seedReply(db, tenantId, 'Cancel', { channel: 'sms', fromAddress: phone }),
    );

    const { rows } = await db.query<{ reason: string }>(
      `SELECT reason FROM suppressions WHERE tenant_id = $1 AND address = $2`,
      [tenantId, phone],
    );
    expect(rows[0]!.reason).toBe('sms_stop');

    // The preference-centre statement, run verbatim, does not match it.
    const { rowCount } = await db.query(
      `DELETE FROM suppressions
        WHERE tenant_id = $1 AND channel = $2 AND address = $3 AND reason = 'unsubscribe'`,
      [tenantId, 'sms', phone],
    );
    expect(rowCount, 'the SMS false positive survives the self-service undo').toBe(0);
  });

  it('BLAST RADIUS: the notSuppressed gate has no transactional exemption', async () => {
    const source = await readFile(ORCHESTRATOR, 'utf8');
    const start = source.indexOf('const notSuppressed');
    const end = source.indexOf('const withinQuietHours');
    expect(start).toBeGreaterThan(-1);
    const gate = source.slice(start, end);

    // The consent gate DOES exempt transactional mail (orchestrator.ts:184).
    expect(source).toMatch(/ctx\.campaign\.category === 'transactional'\) return pass/);
    // The suppression gate does not. A falsely-suppressed address stops receiving
    // its own order confirmations, refunds and shipping notices, permanently.
    expect(gate).not.toMatch(/transactional/);
    expect(gate).not.toMatch(/isQuietHoursExempt|category/);
  });
});
