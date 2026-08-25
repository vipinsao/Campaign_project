/**
 * Boots one real PostgreSQL for the whole test run and migrates it.
 *
 * Real Postgres, not a mock and not an in-memory shim. The behaviour under test —
 * FOR UPDATE SKIP LOCKED, partial indexes, generated columns, EXCLUDE constraints,
 * NULLS NOT DISTINCT, append-only triggers — exists only in a real server. Mocking
 * the database here would mock away the entire subject of the project.
 *
 * embedded-postgres downloads a genuine server binary and runs it as an unprivileged
 * child process, so this works with no Docker daemon and no root. docker-compose.yml
 * is still shipped for reviewers who prefer it; neither is required for `npm test`.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../scripts/migrate.ts';

const DATA_DIR = fileURLToPath(new URL('../../.pgdata-test', import.meta.url));
const PORT = Number(process.env['TEST_PG_PORT'] ?? 55432);
const URL_ = `postgresql://ce_test:ce_test@127.0.0.1:${PORT}/postgres`;

let pg: EmbeddedPostgres | undefined;

export async function setup(project: TestProject) {
  await rm(DATA_DIR, { recursive: true, force: true });

  pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'ce_test',
    password: 'ce_test',
    port: PORT,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  await pg.initialise();
  await pg.start();

  process.env['DATABASE_URL'] = URL_;
  project.provide('databaseUrl', URL_);

  await migrate(URL_, { silent: true });
}

export async function teardown() {
  await pg?.stop();
  await rm(DATA_DIR, { recursive: true, force: true });
}

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
  }
}
