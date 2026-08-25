/**
 * One command, cold clone to running system.
 *
 *   npm install && npm run dev
 *
 * Boots a real PostgreSQL as a child process, migrates it, then starts the API and
 * the worker as separate processes — separate because that separation is a design
 * decision the rest of the system depends on, and running them in one process
 * during development would let a scheduler quietly creep into the API.
 *
 * No Docker daemon, no root, no accounts, no credentials. `docker-compose.yml`
 * ships as well for reviewers who prefer it, but nothing here requires it. A
 * reviewer who cannot run the project will not read it.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = path.join(ROOT, '.pgdata');
const PORT = Number(process.env.DEV_PG_PORT ?? 55432);
const DATABASE_URL = `postgresql://campaign:campaign@127.0.0.1:${PORT}/postgres`;

const children = [];
let pg;

async function shutdown(code = 0) {
  for (const child of children) child.kill('SIGTERM');
  if (pg) {
    try {
      await pg.stop();
    } catch {
      // Already stopped; nothing useful to do about it during shutdown.
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

function run(name, args, extraEnv = {}) {
  const child = spawn('node', ['--import', 'tsx', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL,
      // `off` is the default everywhere, deliberately (I2). Development uses the
      // mock provider, which writes to the outbox and fires its own webhooks back,
      // so the full lifecycle is visible without a single credential.
      SEND_MODE: process.env.SEND_MODE ?? 'mock',
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
      NODE_ENV: 'development',
      ...extraEnv,
    },
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n${name} exited with code ${code}`);
      void shutdown(code);
    }
  });
  children.push(child);
  return child;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'campaign',
    password: 'campaign',
    port: PORT,
    // Persistent, so restarting `npm run dev` keeps whatever you seeded.
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });

  const fresh = !(await exists(path.join(DATA_DIR, 'PG_VERSION')));
  if (fresh) {
    console.log('Initialising a local PostgreSQL (first run only)…');
    await pg.initialise();
  }
  await pg.start();
  console.log(`PostgreSQL listening on ${PORT}`);

  const { migrate } = await import('./migrate.ts');
  await migrate(DATABASE_URL);

  console.log('');
  console.log('  API     http://localhost:3000');
  console.log('  Web     http://localhost:5173');
  console.log('');
  console.log('  Seed the demo:  npm run seed:demo');
  console.log('  Fast-forward:   npm run demo:simulate');
  console.log('');

  run('api', ['packages/api/src/index.ts']);
  run('worker', ['packages/worker/src/index.ts']);

  // The web dev server is optional: the API and worker are the interesting halves,
  // and a missing frontend should not stop the backend from coming up.
  const web = spawn('npm', ['run', 'dev', '-w', '@campaign/web'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_API_URL: 'http://localhost:3000' },
  });
  web.on('error', () => console.warn('web dev server unavailable; api and worker are still up'));
  children.push(web);
}

async function exists(p) {
  try {
    const { stat } = await import('node:fs/promises');
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

await main();
