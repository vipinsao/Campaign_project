/**
 * ATTACK: POST /campaigns/:id/test-send must refuse to mail a real customer.
 *
 * The guard is one query:
 *
 *   SELECT id, tags FROM contacts WHERE tenant_id = $1 AND (email = $2::citext OR phone = $2)
 *
 * which WAS an EXACT match on a normalised-in-name-only address. The endpoint's own
 * comment says the mistake it exists to prevent is "fat-fingering a character that
 * lands on a customer's address" — so the interesting question is not whether the
 * exact string is caught (it always was) but which strings reach the same mailbox
 * without matching the string.
 *
 * Four did, and every one of them ended in the same place: a row in
 * `message_queue` addressed to a real customer, created by an endpoint whose
 * entire purpose is to make that impossible.
 *
 * The guard now compares the MAILBOX an address reaches — `deliveryIdentity` —
 * rather than its bytes: subaddressing labels are stripped, Gmail's dot-insensitive
 * local parts are folded, confusable Cyrillic and Greek characters are mapped to
 * their ASCII skeletons, and a phone number is compared on its digits. The queue is
 * what is asserted, not just the status: the send path is the worker's, and a
 * refusal that returns 409 while still enqueuing would be no refusal at all.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import type { App } from '@campaign/api';
import { bootApp, seedWorld, authHeaders, type World } from './qa-sec-helpers.ts';

let app: App;
let a: World;

afterAll(closeTestDb);
beforeAll(resetDb);

beforeEach(async () => {
  await resetDb();
  app = bootApp();
  a = await seedWorld(app, 'Alpha');
});

const asA = () => authHeaders(a.token);

async function testSend(to: string): Promise<Response> {
  return app.request(`/campaigns/${a.campaignId}/test-send`, {
    method: 'POST',
    headers: asA(),
    body: JSON.stringify({ to, channel: 'email' }),
  });
}

async function queuedTo(): Promise<string[]> {
  const { rows } = await testDb().query<{ recipient_address: string }>(
    `SELECT recipient_address FROM message_queue WHERE scheduled_at >= '2026-06-15T00:00:00Z'`,
  );
  return rows.map((r) => r.recipient_address);
}

describe('the refusal that is the point of the endpoint', () => {
  it('catches the exact address, and catches it case-insensitively', async () => {
    for (const to of [a.contactEmail, a.contactEmail.toUpperCase(), `  ${a.contactEmail}  `]) {
      const response = await testSend(to);
      expect(response.status, `must refuse ${JSON.stringify(to)}`).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('test_send_would_reach_a_contact');
    }
    expect(await queuedTo()).toEqual([]);
  });

  it('catches plus-addressing, which every provider delivers to the base mailbox', async () => {
    // customer-alpha+anything@example.com is delivered to customer-alpha@example.com
    // by Gmail, Fastmail, Outlook and every RFC 5233 subaddressing implementation.
    // The contacts lookup is an exact citext compare, so it matches nothing.
    const [local, domain] = a.contactEmail.split('@');
    const response = await testSend(`${local}+qa@${domain}`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'test_send_would_reach_a_contact',
    );
    expect(
      await queuedTo(),
      "an unfinished draft was queued for delivery to a real customer's mailbox",
    ).toEqual([]);
  });

  it('catches a dotted gmail local part', async () => {
    await testDb().query(
      `UPDATE contacts SET email = 'qa.reserved.probe@gmail.com' WHERE id = $1`,
      [a.contactId],
    );
    const response = await testSend('qareservedprobe@gmail.com');
    expect(response.status).toBe(409);
    expect(await queuedTo(), 'gmail ignores dots, and so does the guard').toEqual([]);
  });

  it('catches a unicode homoglyph in the domain', async () => {
    // A Cyrillic 'е' looks identical in an operator's font and normalises to the
    // ASCII domain in any IDNA-aware MTA.
    const homoglyph = a.contactEmail.replace('example.com', 'examplе.com');
    expect(homoglyph).not.toBe(a.contactEmail);
    const response = await testSend(homoglyph);
    expect(response.status).toBe(409);
    expect(await queuedTo(), 'a homoglyph domain is a different string and the same inbox').toEqual(
      [],
    );
  });

  it('catches a re-formatted phone number in the guard, not in a schema CHECK', async () => {
    await testDb().query(`UPDATE contacts SET phone = '+12025550123' WHERE id = $1`, [a.contactId]);
    await testDb().query(
      `UPDATE campaign_messages SET channel = 'sms', subject_template = NULL WHERE campaign_id = $1`,
      [a.campaignId],
    );

    // `phone = $2` was a plain text compare against an E.164 column, so none of
    // these matched the contact and the endpoint's own guard did NOT refuse them.
    // What stopped the send was `contacts_phone_is_e164` rejecting the test contact
    // insert — defence in depth in a layer that does not know it is defending
    // anything, and which would have let the send through the moment somebody typed
    // an address that happened to be valid E.164.
    //
    // The guard now compares digits, so the refusal comes from the endpoint that
    // exists to make it, with the reason code that says so.
    for (const to of ['+1 202 555 0123', '(202) 555-0123', '12025550123', '+1-202-555-0123']) {
      const response = await app.request(`/campaigns/${a.campaignId}/test-send`, {
        method: 'POST',
        headers: asA(),
        body: JSON.stringify({ to, channel: 'sms' }),
      });
      const body = (await response.json()) as { error?: { code: string; details?: unknown } };
      expect(response.status, to).toBe(409);
      expect(body.error?.code, to).toBe('test_send_would_reach_a_contact');
    }
    expect(await queuedTo()).toEqual([]);
  });
});

describe('what the endpoint does with the addresses it lets through', () => {
  it('creates a test contact WITHOUT writing consent it never received', async () => {
    // This endpoint used to write an `opted_in` ledger entry sourced 'operator' for
    // every address it accepted, reasoning that the operator asking for the test is
    // the consent for it. `contact_consents` is the append-only audit trail this
    // system answers compliance questions from, so that made /test-send a machine
    // for manufacturing consent nobody gave.
    //
    // The test recipient is now exempted at the consent GATE instead, which records
    // the exemption in `send_decisions` — "sent without consent, on purpose, to an
    // internal address" is true and auditable; "they opted in" was neither.
    const response = await testSend('someone-who-never-signed-up@example.org');
    expect(response.status).toBe(202);

    const { rows } = await testDb().query<{ state: string; source: string }>(
      `SELECT cc.state, cc.source
         FROM contact_consents cc JOIN contacts c ON c.id = cc.contact_id
        WHERE c.email = 'someone-who-never-signed-up@example.org'`,
    );
    expect(
      rows.map((r) => `${r.state}/${r.source}`),
      'an opt-in was written for an address that never opted in',
    ).toEqual([]);
  });
});
