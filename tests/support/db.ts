import { Pool } from 'pg';

let pool: Pool | undefined;

export function testDb(): Pool {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('global-setup did not provide DATABASE_URL');
  pool ??= new Pool({ connectionString: url, max: 16 });
  return pool;
}

export async function closeTestDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Every table except the migration ledger, emptied. TRUNCATE bypasses the
 *  append-only row triggers on contact_consents and campaign_versions, which is
 *  exactly why teardown uses it rather than DELETE. */
export async function resetDb(): Promise<void> {
  const db = testDb();
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await db.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
