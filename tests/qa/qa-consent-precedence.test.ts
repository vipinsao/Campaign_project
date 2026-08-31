/**
 * QA — adversarial review of `consent_state()` precedence  (hypotheses 1 and 2).
 *
 * Two things were attacked:
 *
 *  1. the tiebreak, `ORDER BY occurred_at DESC, id DESC`, and whether `id DESC`
 *     over uuidv7 keys means anything;
 *  2. what the rule does to a per-category opt-out when a LATER wildcard opt-in
 *     arrives — which was not hypothetical, because a production endpoint wrote
 *     exactly that row on every suppression removal.
 *
 * (2) is fixed at the source (D24) and the guard for it is at the bottom of this
 * file: `DELETE /suppressions` no longer writes consent at all, and it refuses to
 * remove a suppression that records the person's own decision unless the caller
 * says so explicitly.
 *
 * The precedence RULE itself — most recent intent wins across wildcard and
 * category rows — is deliberate and unchanged (D6). What that costs is
 * characterised below rather than asserted away: any later wildcard opt-in still
 * outranks an earlier per-category opt-out, so what matters is which endpoints are
 * allowed to write one.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, seedContact, seedTenant } from '../support/fixtures.ts';
import { authHeaders, bootApp, loginToken, QA_CLOCK } from './qa-sec-helpers.ts';
import { addSuppression, consentState } from '@campaign/core';
import type { CampaignCategory } from '@campaign/shared';

afterAll(closeTestDb);
beforeEach(resetDb);

type Row = {
  category: CampaignCategory | null;
  state: 'opted_in' | 'opted_out';
  at: string;
  source?: string;
};

async function ledger(tenantId: string, contactId: string, rows: Row[]): Promise<void> {
  for (const row of rows) {
    await testDb().query(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, category, state, source, occurred_at)
       VALUES ($1,$2,'email',$3,$4,$5,$6::timestamptz)`,
      [tenantId, contactId, row.category, row.state, row.source ?? 'preference_center', row.at],
    );
  }
}

function resolve(tenantId: string, contactId: string, category: CampaignCategory) {
  return consentState(testDb(), { tenantId, contactId, channel: 'email', category });
}

describe('QA/consent — precedence across wildcard and category rows (SAFE)', () => {
  it('a category opt-in AFTER a wildcard opt-out wins for that category only', async () => {
    const s = await seedAll();
    await ledger(s.tenantId, s.contactId, [
      {
        category: null,
        state: 'opted_out',
        at: '2026-01-01T00:00:00Z',
        source: 'unsubscribe_link',
      },
      { category: 'promotional', state: 'opted_in', at: '2026-01-02T00:00:00Z' },
    ]);

    expect(await resolve(s.tenantId, s.contactId, 'promotional')).toBe('opted_in');
    expect(await resolve(s.tenantId, s.contactId, 'lifecycle')).toBe('opted_out');
    expect(await resolve(s.tenantId, s.contactId, 'operational')).toBe('opted_out');
  });

  it('three interleaved changes across two categories resolve independently', async () => {
    const s = await seedAll();
    await ledger(s.tenantId, s.contactId, [
      { category: null, state: 'opted_in', at: '2026-01-01T00:00:00Z', source: 'signup' },
      { category: 'promotional', state: 'opted_out', at: '2026-02-01T00:00:00Z' },
      { category: 'lifecycle', state: 'opted_out', at: '2026-03-01T00:00:00Z' },
      { category: 'promotional', state: 'opted_in', at: '2026-04-01T00:00:00Z' },
    ]);

    expect(await resolve(s.tenantId, s.contactId, 'promotional')).toBe('opted_in');
    expect(await resolve(s.tenantId, s.contactId, 'lifecycle')).toBe('opted_out');
    // Never touched by a category row, so the January wildcard still governs.
    expect(await resolve(s.tenantId, s.contactId, 'operational')).toBe('opted_in');
  });

  it('a category with no rows at all resolves to NULL, and the gate fails closed', async () => {
    const s = await seedAll();
    await ledger(s.tenantId, s.contactId, [
      { category: 'promotional', state: 'opted_in', at: '2026-01-01T00:00:00Z' },
    ]);
    expect(await resolve(s.tenantId, s.contactId, 'lifecycle')).toBeUndefined();
  });

  it('a NULL category argument matches wildcard rows only', async () => {
    const s = await seedAll();
    await ledger(s.tenantId, s.contactId, [
      { category: null, state: 'opted_in', at: '2026-01-01T00:00:00Z', source: 'signup' },
      { category: 'promotional', state: 'opted_out', at: '2026-02-01T00:00:00Z' },
    ]);
    const { rows } = await testDb().query<{ state: string | null }>(
      `SELECT consent_state($1,$2,'email',NULL) AS state`,
      [s.tenantId, s.contactId],
    );
    expect(rows[0]?.state, 'the later promotional opt-out is invisible to a NULL query').toBe(
      'opted_in',
    );
  });

  it('CHARACTERISATION: a category string that is not a real category also matches wildcards only', async () => {
    // `p_category` is untyped TEXT. A typo, or a category added to the app but not
    // to the CHECK, silently resolves to the wildcard state rather than erroring.
    const s = await seedAll();
    await ledger(s.tenantId, s.contactId, [
      { category: null, state: 'opted_in', at: '2026-01-01T00:00:00Z', source: 'signup' },
      { category: 'promotional', state: 'opted_out', at: '2026-02-01T00:00:00Z' },
    ]);
    const { rows } = await testDb().query<{ state: string | null }>(
      `SELECT consent_state($1,$2,'email','promotionl') AS state`,
      [s.tenantId, s.contactId],
    );
    expect(rows[0]?.state).toBe('opted_in');
  });
});

describe('QA/consent — the same-instant tiebreak', () => {
  it('`id DESC` over uuidv7 resolves same-timestamp rows in insertion order', async () => {
    // uuidv7() in PostgreSQL 18 carries sub-millisecond precision in rand_a, so two
    // rows inserted back to back inside one millisecond still order by insertion.
    // If that ever stops being true the tiebreak becomes a coin flip and a
    // wildcard opt-out can lose to a same-instant category opt-in at random.
    const s = await seedAll();
    const db = testDb();
    const wrong: string[] = [];

    for (let i = 0; i < 200; i++) {
      const { rows: c } = await db.query<{ id: string }>(
        `INSERT INTO contacts (tenant_id, email) VALUES ($1,$2) RETURNING id`,
        [s.tenantId, `tie${i}@example.com`],
      );
      const contactId = c[0]!.id;
      // Wildcard opt-OUT first, then the narrower opt-IN, at the identical instant.
      await db.query(
        `INSERT INTO contact_consents (tenant_id, contact_id, channel, category, state, source, occurred_at)
         VALUES ($1,$2,'email',NULL,'opted_out','unsubscribe_link','2026-05-01T12:00:00.000Z'),
                ($1,$2,'email','promotional','opted_in','preference_center','2026-05-01T12:00:00.000Z')`,
        [s.tenantId, contactId],
      );
      const state = await resolve(s.tenantId, contactId, 'promotional');
      if (state !== 'opted_in') wrong.push(`${contactId}: ${String(state)}`);
    }

    expect(
      wrong,
      `the id DESC tiebreak did not follow insertion order in ${wrong.length}/200 cases`,
    ).toEqual([]);
  });

  it('FINDING: the tiebreak follows INSERT order, not the order the events happened', async () => {
    // `occurred_at` is caller-supplied; `id` is minted at INSERT. Two webhooks
    // processed out of order — an SMS STOP and a preference-centre toggle both
    // stamped at the same second — resolve to whichever the database happened to
    // write second, which is the opposite of "most recent intent wins".
    const s = await seedAll();
    const db = testDb();
    // The customer sent STOP; the earlier preference-centre opt-in is replayed after it.
    await db.query(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, category, state, source, occurred_at)
       VALUES ($1,$2,'email',NULL,'opted_out','sms_stop','2026-05-01T12:00:00Z')`,
      [s.tenantId, s.contactId],
    );
    await db.query(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, category, state, source, occurred_at)
       VALUES ($1,$2,'email','promotional','opted_in','preference_center','2026-05-01T12:00:00Z')`,
      [s.tenantId, s.contactId],
    );
    expect(
      await resolve(s.tenantId, s.contactId, 'promotional'),
      'a same-instant tie must not be resolved in favour of continuing to send',
    ).toBe('opted_out');
  });
});

describe('QA/consent — a later wildcard opt-in outranks an explicit category opt-out', () => {
  it('CHARACTERISATION: any later wildcard opt-in outranks an earlier category opt-out', async () => {
    // D6, applied literally: most recent intent wins across wildcard and category
    // rows. This is the cost of the rule, and it is why D24 matters — the defence
    // is not in `consent_state`, it is in being strict about which endpoints may
    // write a category-less `opted_in` at all.
    //
    // A checkout tick is the remaining realistic writer of one. Whether "bought
    // something with the marketing box ticked" should outrank "unsubscribed from
    // promotional last month" is a product question, not a resolution bug — but
    // the blast radius belongs on the record.
    const s = await seedAll();
    await ledger(s.tenantId, s.contactId, [
      { category: 'promotional', state: 'opted_out', at: '2026-02-01T00:00:00Z' },
      { category: null, state: 'opted_in', at: '2026-03-01T00:00:00Z', source: 'checkout' },
    ]);
    expect(
      await resolve(s.tenantId, s.contactId, 'promotional'),
      'the later wildcard row wins the whole timeline, including categories it never named',
    ).toBe('opted_in');
  });
});

describe('QA/consent — removing a suppression must not rewrite consent (D24)', () => {
  it('GUARD: DELETE /suppressions writes no consent row, so category opt-outs survive', async () => {
    // This route used to record `{ category: null, state: 'opted_in', source:
    // 'operator' }` whenever an operator removed a suppression, on the reasoning
    // that lifting a block is a consent event. Under most-recent-intent-wins (D6)
    // that single row silently re-subscribed the contact to every category they
    // had explicitly switched off — an operator tidying up a bounce list
    // re-subscribing people to everything.
    //
    // The two tables answer different questions: `suppressions` is "is this ADDRESS
    // deliverable", `contact_consents` is "what did this PERSON say".
    const app = bootApp();
    const db = testDb();
    const tenantId = await seedTenant(db);
    const { token } = await loginToken(app, db, tenantId);
    const address = 'hard-bounced@example.com';
    const contactId = await seedContact(db, tenantId, { email: address });

    await ledger(tenantId, contactId, [
      { category: null, state: 'opted_in', at: '2026-01-01T00:00:00Z', source: 'signup' },
      { category: 'promotional', state: 'opted_out', at: '2026-02-01T00:00:00Z' },
      { category: 'lifecycle', state: 'opted_out', at: '2026-02-01T00:00:01Z' },
    ]);
    await addSuppression(db, {
      clock: QA_CLOCK,
      tenantId,
      channel: 'email',
      address,
      reason: 'invalid',
    });

    const response = await app.request(
      `/suppressions?channel=email&address=${encodeURIComponent(address)}`,
      { method: 'DELETE', headers: authHeaders(token) },
    );
    expect(response.status).toBe(200);

    const { rows: consents } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM contact_consents WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(Number(consents[0]!.n), 'the route wrote no consent row').toBe(3);
    expect(
      await resolve(tenantId, contactId, 'promotional'),
      'an explicit per-category opt-out survives an operator clearing a bounce',
    ).toBe('opted_out');
    expect(await resolve(tenantId, contactId, 'lifecycle')).toBe('opted_out');
  });

  it("GUARD: removing a suppression that records the recipient's own decision needs an acknowledgement", async () => {
    const app = bootApp();
    const db = testDb();
    const tenantId = await seedTenant(db);
    const { token } = await loginToken(app, db, tenantId);
    const address = 'said-stop@example.com';
    await addSuppression(db, {
      clock: QA_CLOCK,
      tenantId,
      channel: 'email',
      address,
      reason: 'unsubscribe',
    });

    const url = `/suppressions?channel=email&address=${encodeURIComponent(address)}`;
    const refused = await app.request(url, { method: 'DELETE', headers: authHeaders(token) });
    expect(refused.status, 'a bare DELETE of an unsubscribe is a 409, not a silent undo').toBe(409);

    const { rows: still } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM suppressions WHERE tenant_id = $1 AND address = $2`,
      [tenantId, address],
    );
    expect(Number(still[0]!.n), 'and the suppression is still there').toBe(1);

    const acknowledged = await app.request(`${url}&acknowledgeConsent=true`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    expect(acknowledged.status, 'an operator who says so explicitly can still do it').toBe(200);
  });
});
