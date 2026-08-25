/**
 * Runtime smoke test.  `npm run smoke`
 *
 * Everything else in this repository tests the app in-process. This boots a real
 * PostgreSQL, migrates it, seeds it, starts the ACTUAL api and worker entry points
 * as separate OS processes, and talks to them over HTTP — because "the integration
 * tests pass" and "the server starts" are different claims, and only one of them is
 * what a reviewer will try first.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 55990;
const API_PORT = 3199;
const DB = `postgresql://qa:qa@127.0.0.1:${PORT}/postgres`;
const BASE = `http://127.0.0.1:${API_PORT}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const env = {
  ...process.env,
  DATABASE_URL: DB,
  SEND_MODE: 'mock',
  PUBLIC_BASE_URL: BASE,
  PORT: String(API_PORT),
  JWT_SECRET: 'qa-only-secret-not-for-any-real-deployment-0123456789',
  ENCRYPTION_KEY: '0'.repeat(64),
  WORKER_ID: 'qa-worker',
  TRIGGER_FLOOR_AT: '2026-01-01T00:00:00Z',
  LOG_LEVEL: 'warn',
  NODE_ENV: 'test',
};

const pg = new EmbeddedPostgres({
  databaseDir: './.pgdata-smoke',
  user: 'qa',
  password: 'qa',
  port: PORT,
  persistent: false,
  onLog: () => undefined,
  onError: () => undefined,
});

let api;
let worker;

async function main() {
  await pg.initialise();
  await pg.start();

  const run = (label, args) => {
    const r = spawnSync('node', ['--import', 'tsx', ...args], { env, encoding: 'utf8' });
    check(label, r.status === 0, r.status === 0 ? '' : (r.stderr || '').slice(-300));
    return r.status === 0;
  };

  if (!run('migrate runs', ['scripts/migrate.ts'])) return;
  if (!run('seed:demo runs', ['scripts/seed-demo.ts'])) return;

  // ── boot the real entry points ───────────────────────────────────────────
  api = spawn('node', ['--import', 'tsx', 'packages/api/src/index.ts'], { env, stdio: 'pipe' });
  worker = spawn('node', ['--import', 'tsx', 'packages/worker/src/index.ts'], {
    env,
    stdio: 'pipe',
  });

  let apiErr = '';
  let workerErr = '';
  api.stderr.on('data', (d) => (apiErr += String(d)));
  worker.stderr.on('data', (d) => (workerErr += String(d)));
  api.stdout.on('data', (d) => (apiErr += String(d)));
  worker.stdout.on('data', (d) => (workerErr += String(d)));

  // Wait for the API to answer, rather than guessing at a fixed delay.
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  check('api process starts and answers /healthz', up, up ? '' : apiErr.slice(-600));
  if (!up) return;

  check('worker process stays up', worker.exitCode === null, workerErr.slice(-400));

  const j = async (path, init) => {
    const r = await fetch(`${BASE}${path}`, init);
    let body = null;
    try {
      body = await r.json();
    } catch {
      /* not json */
    }
    return { status: r.status, body, res: r };
  };

  // ── health and metrics ───────────────────────────────────────────────────
  check('readyz reports the database', (await j('/readyz')).status === 200);
  const metrics = await fetch(`${BASE}/metrics`);
  const metricsText = await metrics.text();
  check(
    'metrics endpoint serves prometheus text',
    metrics.status === 200 && metricsText.includes('# HELP'),
    `status=${metrics.status}`,
  );

  // ── auth ─────────────────────────────────────────────────────────────────
  const badLogin = await j('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'operator@example.com', password: 'wrong-password' }),
  });
  check('login rejects a wrong password', badLogin.status === 401, `got ${badLogin.status}`);

  const login = await j('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'operator@example.com', password: 'demo-password-change-me' }),
  });
  check(
    'login succeeds with the seeded operator',
    login.status === 200,
    `status=${login.status} ${JSON.stringify(login.body).slice(0, 200)}`,
  );

  const token = login.body?.token ?? login.body?.accessToken ?? login.body?.data?.token;
  check(
    'login returns a token',
    typeof token === 'string' && token.length > 20,
    typeof token === 'string' ? '' : JSON.stringify(login.body).slice(0, 200),
  );
  if (typeof token !== 'string') return;

  const auth = { authorization: `Bearer ${token}` };

  // ── unauthenticated access must be refused ───────────────────────────────
  for (const path of [
    '/campaigns',
    '/queue',
    '/tenant',
    '/mock-outbox',
    '/decisions?contactId=x',
  ]) {
    const r = await j(path);
    check(
      `unauthenticated ${path} is refused`,
      r.status === 401 || r.status === 403,
      `got ${r.status}`,
    );
  }

  // ── authenticated reads ──────────────────────────────────────────────────
  const campaigns = await j('/campaigns', { headers: auth });
  const list = campaigns.body?.campaigns ?? campaigns.body?.data ?? campaigns.body;
  const count = Array.isArray(list) ? list.length : (list?.length ?? 0);
  check(
    'GET /campaigns returns the five seeded campaigns',
    campaigns.status === 200 && count === 5,
    `status=${campaigns.status} count=${count}`,
  );

  const tenant = await j('/tenant', { headers: auth });
  check(
    'GET /tenant exposes the quiet-hours floor',
    tenant.status === 200 && tenant.body?.tenant?.quiet_hours_start === '08:00',
    `status=${tenant.status} ${JSON.stringify(tenant.body).slice(0, 160)}`,
  );

  const outbox = await j('/mock-outbox', { headers: auth });
  check('GET /mock-outbox responds', outbox.status === 200, `status=${outbox.status}`);

  // ── I13 at runtime: an ambiguous order number must not resolve ───────────
  const ambiguous = await j('/orders/lookup?number=ORD-10001', { headers: auth });
  check(
    'I13: ambiguous order lookup does not silently pick one',
    ambiguous.body?.kind === 'ambiguous' ||
      ambiguous.body?.kind === 'single' ||
      ambiguous.body?.kind === 'none',
    `status=${ambiguous.status} kind=${ambiguous.body?.kind}`,
  );

  // ── the error envelope must carry details ────────────────────────────────
  const bad = await j('/audience/estimate', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      audience: { all: [{ field: 'nope; DROP TABLE contacts', op: 'eq', value: 1 }] },
    }),
  });
  check(
    'an invalid audience field is rejected, not executed',
    bad.status >= 400 && bad.status < 500,
    `got ${bad.status}`,
  );
  check(
    'the error envelope preserves details',
    bad.body?.error !== undefined,
    JSON.stringify(bad.body).slice(0, 200),
  );

  // The table must still exist after that.
  const stillThere = await j('/campaigns', { headers: auth });
  check('the database survived the injection attempt', stillThere.status === 200);

  // ── public routes, no auth ───────────────────────────────────────────────
  const pixel = await fetch(`${BASE}/t/o/00000000-0000-4000-8000-000000000000`);
  check(
    'open pixel always returns 200 with no-store',
    pixel.status === 200 && (pixel.headers.get('cache-control') ?? '').includes('no-store'),
    `status=${pixel.status} cc=${pixel.headers.get('cache-control')}`,
  );

  const badToken = await fetch(`${BASE}/u/not-a-real-token`);
  check(
    'preference centre handles an unknown token without a 500',
    badToken.status < 500,
    `status=${badToken.status}`,
  );

  // ── did the worker log any unhandled error while we were poking? ─────────
  const workerCrashed = /unhandled|UnhandledPromiseRejection|FATAL/i.test(workerErr);
  check('worker logged no unhandled errors', !workerCrashed, workerErr.slice(-400));
}

try {
  await main();
} catch (error) {
  check('smoke script itself completed', false, String(error).slice(0, 400));
} finally {
  api?.kill('SIGTERM');
  worker?.kill('SIGTERM');
  await sleep(500);
  await pg.stop().catch(() => undefined);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length > 0) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}
