/**
 * ATTACK: POST /campaigns/:id/test-send must refuse to mail a real customer.
 *
 * The guard is one query:
 *
 *   SELECT id, tags FROM contacts WHERE tenant_id = $1 AND (email = $2::citext OR phone = $2)
 *
 * which is an EXACT match on a normalised-in-name-only address. The endpoint's own
 * comment says the mistake it exists to prevent is "fat-fingering a character that
 * lands on a customer's address" — so the interesting question is not whether the
 * exact string is caught (it is) but which strings reach the same mailbox without
 * matching the string.
 *
 * Every case here ends in the same place: a row in `message_queue` addressed to a
 * real customer, created by an endpoint whose entire purpose is to make that
 * impossible. The queue row is what is asserted, not the HTTP status — the send
 * path is the worker's, and by then the refusal has already been skipped.
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

  it('is bypassed by plus-addressing', async () => {
    // customer-alpha+anything@example.com is delivered to customer-alpha@example.com
    // by Gmail, Fastmail, Outlook and every RFC 5233 subaddressing implementation.
    // The contacts lookup is an exact citext compare, so it matches nothing.
    const [local, domain] = a.contactEmail.split('@');
    const response = await testSend(`${local}+qa@${domain}`);
    expect(response.status).toBe(202);
    expect(
      await queuedTo(),
      'an unfinished draft was queued for delivery to a real customer\'s mailbox',
    ).toEqual([]);
  });

  it('is bypassed by a dotted gmail local part', async () => {
    await testDb().query(`UPDATE contacts SET email = 'qa.reserved.probe@gmail.com' WHERE id = $1`, [a.contactId]);
    const response = await testSend('qareservedprobe@gmail.com');
    expect(response.status).toBe(202);
    expect(await queuedTo(), 'gmail ignores dots; the guard does not').toEqual([]);
  });

  it('is bypassed by a unicode homoglyph in the domain', async () => {
    // A Cyrillic 'е' looks identical in an operator's font and normalises to the
    // ASCII domain in any IDNA-aware MTA.
    const homoglyph = a.contactEmail.replace('example.com', 'examplе.com');
    expect(homoglyph).not.toBe(a.contactEmail);
    const response = await testSend(homoglyph);
    expect(response.status).toBe(202);
    expect(await queuedTo(), 'a homoglyph domain is a different string and the same inbox').toEqual([]);
  });

  it('misses a re-formatted phone number, and is saved only by a schema CHECK', async () => {
    await testDb().query(`UPDATE contacts SET phone = '+12025550123' WHERE id = $1`, [a.contactId]);
    await testDb().query(
      `UPDATE campaign_messages SET channel = 'sms', subject_template = NULL WHERE campaign_id = $1`,
      [a.campaignId],
    );

    // `phone = $2` is a plain text compare against an E.164 column, so none of these
    // match the contact — the endpoint's own guard does NOT refuse them. What stops
    // the send is `contacts_phone_is_e164` rejecting the test contact insert, which
    // is defence in depth in a layer that does not know it is defending anything.
    for (const to of ['+1 202 555 0123', '(202) 555-0123', '12025550123', '+1-202-555-0123']) {
      const response = await app.request(`/campaigns/${a.campaignId}/test-send`, {
        method: 'POST',
        headers: asA(),
        body: JSON.stringify({ to, channel: 'sms' }),
      });
      const body = (await response.json()) as { error?: { code: string; details?: unknown } };
      expect(response.status, to).toBe(422);
      // Not `test_send_would_reach_a_contact`: the refusal came from Postgres.
      expect(body.error?.code, to).toBe('constraint_violated');
    }
    expect(await queuedTo()).toEqual([]);
  });
});

describe('what the endpoint does with the addresses it lets through', () => {
  it('creates a permanent contact row and an opted_in consent record for it', async () => {
    // Every bypass above also leaves a real `contacts` row and an `opted_in`
    // ledger entry behind, tagged __test_recipient. The ledger is the audit trail,
    // so an operator can manufacture consent for an arbitrary address by typing it
    // into a test-send box.
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
