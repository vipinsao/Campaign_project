import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export type Db = Pool;

let pool: Pool | undefined;

/** Process-wide pool. `DATABASE_URL` is required; there is no localhost default —
 *  a default connection string is how a test run ends up writing to a real database. */
export function getPool(connectionString = process.env['DATABASE_URL']): Pool {
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Run `npm run dev` (which boots an embedded Postgres) ' +
        'or point DATABASE_URL at your own instance.',
    );
  }
  pool ??= new Pool({ connectionString, max: 10, idleTimeoutMillis: 10_000 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(db: Db, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Query helper that keeps the row type explicit at every call site. */
export async function query<T extends QueryResultRow>(
  db: Db | PoolClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(sql, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  db: Db | PoolClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(db, sql, params);
  return rows[0];
}
