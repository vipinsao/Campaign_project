/**
 * V9 — THE MODEL CANNOT REDUCE PROTECTION.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * The headline invariant of packages/triage.
 *
 * The error is asymmetric in a way that no quality metric captures:
 *
 *   a hallucinated SUPPRESSION costs a marketing email — annoying, visible,
 *   reversible by a human with a reason and an audit trail;
 *
 *   a hallucinated UN-SUPPRESSION sends mail to somebody who said STOP — a
 *   PECR/GDPR matter in the UK/EU, TCPA exposure priced per message in the US.
 *
 * So this is not a question of accuracy. At 99.9% accuracy the second one is still
 * unacceptable, because it is not a quality problem — it is a category of action
 * the system must be structurally incapable of taking.
 *
 * The assertions below are therefore STRUCTURAL first and behavioural second:
 *
 *   1. the classifier module does not import the consent module at all
 *   2. the capability it is handed has exactly one method, and it is add-only
 *   3. the classifier never touches any property of it other than addSuppression
 *      (asserted with a Proxy that records every access)
 *   4. and then, behaviourally: a model returning {label:'positive',
 *      action:'resubscribe'} leaves the suppression exactly where it was.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { addSuppression, activeSuppression, consentState, FakeClock } from '@campaign/core';
import {
  classifyReply,
  MockModelClient,
  protectionCapability,
  protectionReasonFor,
} from '@campaign/triage';
import {
  CLOCK_START,
  fixtureFor,
  seedReply,
  seedTriageTenant,
  syncedPrompt,
  triageDeps,
  validAnswer,
} from './triage-harness.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

const CLASSIFIER = fileURLToPath(
  new URL('../../packages/triage/src/classifier.ts', import.meta.url),
);
const PROTECTION = fileURLToPath(
  new URL('../../packages/triage/src/protection.ts', import.meta.url),
);

/** Code only: block comments, line comments and the doc prose all come out. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('V9 — structurally, the model cannot weaken a protection', () => {
  it('never imports the consent module into the classifier', async () => {
    const source = await readFile(CLASSIFIER, 'utf8');
    const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1]);

    // The one core import the classifier is allowed is the pool/clock surface.
    // `consent/consent.ts` is not on the list, so `recordConsent` and `optOut` are
    // not merely unused here — they are not in scope.
    expect(imports).not.toContain('@campaign/core/consent/consent.ts');
    for (const forbidden of ['recordConsent', 'optOut(', 'consentState', 'contact_consents']) {
      expect(source, `classifier.ts must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('has no un-suppress path anywhere in the codebase to expose', async () => {
    // Comments are stripped before matching: protection.ts spends most of its
    // length ARGUING about un-suppression, and the file that explains why the verb
    // does not exist must not be the file that trips the check for it.
    const code = stripComments(await readFile(PROTECTION, 'utf8'));

    // There is no `removeSuppression` in @campaign/core, because there is no
    // legitimate machine-driven reason for one to exist. This asserts that the
    // narrowing file has not quietly grown one either.
    expect(code).not.toMatch(/removeSuppression|deleteSuppression|unsuppress/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+suppressions/i);
    expect(stripComments(await readFile(CLASSIFIER, 'utf8'))).not.toMatch(
      /removeSuppression|deleteSuppression|unsuppress|DELETE\s+FROM\s+suppressions/i,
    );
  });

  it('hands the classifier exactly one method, and it takes no database handle', () => {
    const capability = protectionCapability(testDb());
    expect(Object.keys(capability)).toEqual(['addSuppression']);
    // The pool is closed over, not passed through. Handing over a `Db` alongside a
    // "please only use addSuppression" comment would be a convention wearing a type.
    expect(Object.values(capability).every((v) => typeof v === 'function')).toBe(true);
    expect((capability as Record<string, unknown>)['db']).toBeUndefined();
  });

  it('touches no property of the capability other than addSuppression', async () => {
    const db = testDb();
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const model = new MockModelClient({ fixtures: {} });

    const accessed: string[] = [];
    const spy = new Proxy(protectionCapability(db), {
      get(target, property, receiver) {
        if (typeof property === 'string') accessed.push(property);
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    await classifyReply(
      triageDeps({ db, prompt, model, protection: spy }),
      await seedReply(db, tenantId, 'STOP', { channel: 'sms' }),
    );

    expect(new Set(accessed)).toEqual(new Set(['addSuppression']));
  });

  it('cannot un-suppress: a model returning {label:"positive", action:"resubscribe"}', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const address = 'already-stopped@example.com';

    // The contact said STOP last week and is suppressed.
    await addSuppression(db, {
      tenantId,
      channel: 'email',
      address,
      reason: 'unsubscribe',
      evidence: { source: 'sms_stop' },
    });

    const body = 'Actually I love these emails, put me back on the list!';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, {
        ...validAnswer({ label: 'positive', confidence: 0.99 }),
        action: 'resubscribe',
      }),
    });

    const result = await classifyReply(
      triageDeps({ db, prompt, model, clock }),
      await seedReply(db, tenantId, body, { fromAddress: address }),
    );

    // The extra key is a schema violation, so the answer is escalated rather than
    // silently stripped — see V5. `z.object` would have dropped `action` and left
    // no record that the model asked for something it is not allowed to ask for.
    expect(result.status).toBe('needs_review');
    expect(result.parseStatus).toBe('escalated');

    // And, whatever the model said, the suppression is exactly where it was.
    const still = await activeSuppression(db, { tenantId, channel: 'email', address, clock });
    expect(still?.reason).toBe('unsubscribe');
  });

  it('cannot un-suppress with a perfectly valid, perfectly confident answer either', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const address = 'stopped-then-cheerful@example.com';

    await addSuppression(db, { tenantId, channel: 'email', address, reason: 'unsubscribe' });

    const body = 'Wonderful service, thank you so much!';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ label: 'positive', confidence: 1 })),
    });

    const result = await classifyReply(
      triageDeps({ db, prompt, model, clock }),
      await seedReply(db, tenantId, body, { fromAddress: address }),
    );

    expect(result.status).toBe('auto');
    expect(result.label).toBe('positive');
    expect(result.suppressed).toBe(false);

    // The protection survives a valid answer at confidence 1.0. There is no
    // threshold at which the model becomes allowed to do this.
    const still = await activeSuppression(db, { tenantId, channel: 'email', address, clock });
    expect(still).toBeDefined();

    // And no consent row was written: the classifier cannot record `opted_in`,
    // because `recordConsent` is not in its scope.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM contact_consents WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('cannot record an opt-in even when the model labels the reply opt_out', async () => {
    // The mirror case. A model-decided `opt_out` writes a CLASSIFICATION and
    // nothing else — a suppression is a legal artefact created by a keyword match
    // that gives the same answer every time, not by a probability.
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const address = 'prose-optout@example.com';
    const body = 'Please take me off this list, I do not want any more of these.';
    const model = new MockModelClient({
      fixtures: fixtureFor(prompt, body, validAnswer({ label: 'opt_out', confidence: 0.96 })),
    });

    const result = await classifyReply(
      triageDeps({ db, prompt, model, clock }),
      await seedReply(db, tenantId, body, { fromAddress: address }),
    );

    expect(result.label).toBe('opt_out');
    expect(result.decidedBy).toBe('model');
    expect(result.suppressed, 'a model label is not a legal artefact').toBe(false);
    expect(
      await activeSuppression(db, { tenantId, channel: 'email', address, clock }),
    ).toBeUndefined();
  });

  it('CAN add protection, which is the one direction that is safe', async () => {
    const db = testDb();
    const clock = new FakeClock(CLOCK_START);
    const tenantId = await seedTriageTenant(db);
    const prompt = await syncedPrompt(db, 1);
    const address = '+447700900123';
    const model = new MockModelClient({ fixtures: {} });

    const result = await classifyReply(
      triageDeps({ db, prompt, model, clock }),
      await seedReply(db, tenantId, 'stop', { channel: 'sms', fromAddress: address }),
    );

    expect(result.suppressed).toBe(true);
    const suppression = await activeSuppression(db, { tenantId, channel: 'sms', address, clock });
    expect(suppression?.reason).toBe(protectionReasonFor('sms'));

    // The consent ledger is untouched by the classifier: the suppression is
    // address-level and the ledger is written by the consent module on the
    // operator-driven opt-out path, not by an AI classification.
    const contact = await db.query<{ id: string }>(`SELECT id FROM contacts WHERE tenant_id = $1`, [
      tenantId,
    ]);
    const state = await consentState(db, {
      tenantId,
      contactId: contact.rows[0]!.id,
      channel: 'sms',
      category: 'promotional',
    });
    expect(state).toBeUndefined();
  });
});
