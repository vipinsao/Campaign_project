/**
 * Migration runner. Plain numbered .sql files, forward-only, applied in one
 * transaction each, recorded with a content hash.
 *
 * The hash is not decoration: it catches the case where a migration that has
 * already been applied is edited afterwards. That edit silently produces two
 * different schemas from the same migration number — one on the machine that
 * applied the old version, one on every machine that applies it fresh.
 *
 * This lives in `core` rather than in `scripts/` because the API process runs it
 * on boot, and the dependency-boundary rule correctly refuses to let a package
 * import from the scripts directory. `scripts/migrate.ts` is now the CLI around it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';

/** Repository root is four levels above packages/core/src/db/. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations', import.meta.url));

/** Arbitrary but fixed. Any process migrating this schema must use this number. */
const MIGRATION_LOCK_KEY = 4_207_180_301;

export async function migrate(
  connectionString: string,
  /**
   * `log` rather than a bare console call: this now runs inside the API process on
   * boot, and a library that writes to stdout on its own initiative is a library
   * that corrupts somebody's structured logs. The CLI passes a writer; nothing
   * else does.
   */
  opts: { silent?: boolean; log?: (message: string) => void } = {},
) {
  const log = (m: string) => {
    if (opts.silent !== true) opts.log?.(m);
  };
  const client = new Client({ connectionString });
  await client.connect();
  try {
    // One migrator at a time.
    //
    // The API and the worker are separate processes started together by the
    // platform, and both migrate on boot. Without this they race: two connections
    // read the same empty `schema_migrations`, both decide 0001 is unapplied, and
    // the loser dies on a duplicate object rather than the winner's work being
    // waited for. A session-level advisory lock is the right shape because it is
    // released automatically if the process dies holding it — a migrator killed
    // mid-run must not wedge every future deploy.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

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
    // Ending the connection releases the lock too; releasing explicitly keeps the
    // pairing visible and survives anyone later switching to a pooled client.
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    await client.end();
  }
}
