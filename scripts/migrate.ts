/**
 * Migration runner. Plain numbered .sql files, forward-only, applied in one
 * transaction each, recorded with a content hash.
 *
 * The hash is not decoration: it catches the case where a migration that has
 * already been applied is edited afterwards. That edit silently produces two
 * different schemas from the same migration number — one on the machine that
 * applied the old version, one on every machine that applies it fresh.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export async function migrate(connectionString: string, opts: { silent?: boolean } = {}) {
  const log = (m: string) => {
    if (!opts.silent) console.log(m);
  };
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name         TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        applied_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows: applied } = await client.query<{ name: string; content_hash: string }>(
      'SELECT name, content_hash FROM schema_migrations',
    );
    const seen = new Map(applied.map((r) => [r.name, r.content_hash]));

    let ran = 0;
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      const previous = seen.get(file);

      if (previous !== undefined) {
        if (previous !== hash) {
          throw new Error(
            `Migration ${file} has been edited since it was applied ` +
              `(recorded ${previous}, now ${hash}). Migrations are forward-only: ` +
              `add a new numbered file instead of editing this one.`,
          );
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, content_hash) VALUES ($1,$2)', [
          file,
          hash,
        ]);
        await client.query('COMMIT');
        log(`  applied ${file}`);
        ran++;
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }
    log(ran === 0 ? '  schema already up to date' : `  ${ran} migration(s) applied`);
    return ran;
  } finally {
    await client.end();
  }
}

// Only run when invoked directly, so tests can import migrate() without side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  await migrate(url);
}
