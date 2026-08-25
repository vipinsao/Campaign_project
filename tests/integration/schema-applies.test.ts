import { describe, it, expect, afterAll } from 'vitest';
import { testDb, closeTestDb } from '../support/db.ts';

afterAll(closeTestDb);

describe('the schema the invariants depend on', () => {
  it('applies every migration', async () => {
    const { rows } = await testDb().query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('generates dedup_key in the database, not in application code (I4)', async () => {
    const { rows } = await testDb().query<{ is_generated: string; generation_expression: string }>(
      `SELECT is_generated, generation_expression
         FROM information_schema.columns
        WHERE table_name = 'message_queue' AND column_name = 'dedup_key'`,
    );
    expect(rows[0]?.is_generated).toBe('ALWAYS');
    expect(rows[0]?.generation_expression).toContain('campaign_id');
    expect(rows[0]?.generation_expression).toContain('anchor_id');
  });

  it('treats NULL anchors as equal in the enrolment uniqueness rule', async () => {
    // Without NULLS NOT DISTINCT this index silently permits unlimited duplicate
    // enrolments for every contact_created and manual campaign.
    const { rows } = await testDb().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'enrollments' AND indexname = 'enrollments_one_per_anchor'`,
    );
    expect(rows[0]?.indexdef).toContain('NULLS NOT DISTINCT');
  });

  it('refuses to update a consent row (I6)', async () => {
    const db = testDb();
    const { rows: t } = await db.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('append-only probe') RETURNING id`,
    );
    const tenantId = t[0]!.id;
    const { rows: c } = await db.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, email) VALUES ($1,'probe@example.com') RETURNING id`,
      [tenantId],
    );
    const contactId = c[0]!.id;
    const { rows: k } = await db.query<{ id: string }>(
      `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source)
       VALUES ($1,$2,'email','opted_in','signup') RETURNING id`,
      [tenantId, contactId],
    );

    await expect(
      db.query(`UPDATE contact_consents SET state = 'opted_out' WHERE id = $1`, [k[0]!.id]),
    ).rejects.toThrow(/append-only/i);

    await expect(
      db.query(`DELETE FROM contact_consents WHERE id = $1`, [k[0]!.id]),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses overlapping consent pauses for one contact and channel', async () => {
    const db = testDb();
    const { rows: t } = await db.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('pause probe') RETURNING id`,
    );
    const tenantId = t[0]!.id;
    const { rows: c } = await db.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, email) VALUES ($1,'pause@example.com') RETURNING id`,
      [tenantId],
    );
    const contactId = c[0]!.id;

    await db.query(
      `INSERT INTO consent_pauses (tenant_id, contact_id, channel, period)
       VALUES ($1,$2,'email', tstzrange(now(), now() + interval '30 days'))`,
      [tenantId, contactId],
    );
    await expect(
      db.query(
        `INSERT INTO consent_pauses (tenant_id, contact_id, channel, period)
         VALUES ($1,$2,'email', tstzrange(now() + interval '5 days', now() + interval '40 days'))`,
        [tenantId, contactId],
      ),
    ).rejects.toThrow(/consent_pauses_no_overlap/);
  });
});
