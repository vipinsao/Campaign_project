/**
 * The migration CLI.
 *
 * The runner itself lives in `packages/core/src/db/migrate.ts`, because the API
 * process applies migrations on boot and a package may not import from `scripts/`.
 */
import { fileURLToPath } from 'node:url';
import { migrate } from '@campaign/core';

/**
 * Re-exported, because `scripts/dev.mjs` imports it from here.
 *
 * Without this line the whole "one command, cold clone to running system" promise
 * was broken: `npm run dev` booted PostgreSQL, then died on
 * `TypeError: migrate is not a function`, because a module that only runs a CLI
 * block exports nothing. dev.mjs cannot reach `@campaign/core` directly — the
 * boundaries rule puts `scripts` on the allowed side of that edge and a plain
 * `.mjs` is not covered by it at all — so this file is the seam, and the seam has
 * to actually export something.
 */
export { migrate };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  await migrate(url, { log: (message) => process.stdout.write(`${message}\n`) });
}
