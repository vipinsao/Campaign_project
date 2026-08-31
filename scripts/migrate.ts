/**
 * The migration CLI.
 *
 * The runner itself lives in `packages/core/src/db/migrate.ts`, because the API
 * process applies migrations on boot and a package may not import from `scripts/`.
 */
import { fileURLToPath } from 'node:url';
import { migrate } from '@campaign/core';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  await migrate(url, { log: (message) => process.stdout.write(`${message}\n`) });
}
