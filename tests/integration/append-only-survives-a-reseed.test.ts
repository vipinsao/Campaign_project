/**
 * The append-only tables, from both sides.
 *
 * Migration 0011 narrowed `refuse_mutation()` so that a tenant can actually be
 * deleted. That is a change to a guarantee, which means it needs a test that
 * pins BOTH halves — the half that was loosened and, more importantly, the half
 * that must not have been.
 *
 * The bug it fixes was invisible in exactly the way that matters: seeding a
 * VIRGIN database worked, because the demo tenant did not exist, so the DELETE
 * matched nothing and no cascade fired. Only the second seed against the same
 * database failed. Nobody seeds twice by hand — but `demo-reset.yml` does, nightly,
 * and it had been failing every night while the deployed demo showed frozen data.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedTenant, seedContact } from '../support/fixtures.ts';

afterAll(closeTestDb);
beforeAll(resetDb);
beforeEach(resetDb);

async function consentRow(): Promise<{ tenantId: string; contactId: string; id: string }> {
  const db = testDb();
  const tenantId = await seedTenant(db, { name: 'Append Only Co' });
  const contactId = await seedContact(db, tenantId, { email: 'ledger@example.com' });
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source)
     VALUES ($1,$2,'email','opted_in','signup') RETURNING id`,
    [tenantId, contactId],
  );
  return { tenantId, contactId, id: rows[0]!.id };
}

describe('the guarantee that must NOT have been weakened', () => {
  it('still refuses an UPDATE while the tenant exists', async () => {
    const { id } = await consentRow();
    await expect(
      testDb().query(`UPDATE contact_consents SET state = 'opted_out' WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only: UPDATE is not permitted/);
  });

  it('still refuses a DELETE while the tenant exists', async () => {
    const { id } = await consentRow();
    await expect(
      testDb().query(`DELETE FROM contact_consents WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only: DELETE is not permitted/);
  });

  it('refuses to erase one contact’s consent history by deleting the contact', async () => {
    // contact_consents.contact_id is ON DELETE CASCADE too, and a contact delete
    // leaves the TENANT in place — so this is a rewrite of live history and must
    // still be refused. If this ever passes, 0011 was applied too broadly.
    const { contactId } = await consentRow();
    await expect(testDb().query(`DELETE FROM contacts WHERE id = $1`, [contactId])).rejects.toThrow(
      /append-only: DELETE is not permitted/,
    );
  });

  it('keeps `prompts` refused outright, because it has no tenant to cascade from', async () => {
    const db = testDb();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO prompts (name, version, content, content_hash, model_id, output_schema)
       VALUES ('append-only-probe',1,'hello','hash-append-only-probe','claude-sonnet-5','{}'::jsonb)
       RETURNING id`,
    );
    await expect(db.query(`DELETE FROM prompts WHERE id = $1`, [rows[0]!.id])).rejects.toThrow(
      /append-only: DELETE is not permitted/,
    );
  });
});

describe('the case that was impossible before 0011', () => {
  it('deletes a tenant, cascading through every append-only table', async () => {
    const db = testDb();
    const { tenantId } = await consentRow();

    // Before 0011 this threw, so a tenant could not be removed by any means — the
    // ON DELETE CASCADE the schema declares was a promise it could not keep.
    await expect(db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId])).resolves.toBeDefined();

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM contact_consents WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows[0]!.n, 'the cascade should have taken the consent rows with it').toBe('0');
  });
});
