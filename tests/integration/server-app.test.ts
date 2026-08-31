/**
 * The boundary between the SPA and the API, which did not exist.
 *
 * `createApp` mounts every route at the root. The browser client asks for
 * `/api/campaigns`, and in development the Vite dev proxy strips that prefix.
 * Nothing stripped it in production: the Dockerfile built `packages/web/dist`,
 * copied it into the image, and then no code served it and no code answered
 * `/api/*`. A deploy produced a JSON-only API and a frontend that 404'd on every
 * request it made.
 *
 * The prefix cannot just be dropped either, which is the part worth a test rather
 * than a comment. `/queue` is an operator PAGE and a JSON endpoint. `/contacts/:id`
 * is both a page and a resource. Served from one origin with no namespace the API
 * wins all of them, and the operator gets JSON where a screen should be.
 *
 * So: `/api/*` is the API, the public surfaces stay unprefixed because a mail
 * client following an unsubscribe link will never prepend anything, and everything
 * else falls through to the SPA.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { FakeClock } from '@campaign/core';
import { buildDeps, createApp, createServerApp } from '@campaign/api';

const CLOCK = new FakeClock('2026-06-15T12:00:00Z');
const INDEX_HTML = '<!doctype html><title>Campaign Engine</title><div id="root"></div>';

let webRoot: string;
let absoluteWebRoot: string;
let root: ReturnType<typeof createServerApp>;

afterAll(async () => {
  rmSync(absoluteWebRoot, { recursive: true, force: true });
  await closeTestDb();
});

beforeAll(async () => {
  await resetDb();

  // A stand-in for the Vite build, so this test does not depend on `npm run build`
  // having been run first — CI runs the suite without building the frontend.
  absoluteWebRoot = mkdtempSync(join(tmpdir(), 'campaign-web-'));
  mkdirSync(join(absoluteWebRoot, 'assets'), { recursive: true });
  writeFileSync(join(absoluteWebRoot, 'index.html'), INDEX_HTML);
  writeFileSync(join(absoluteWebRoot, 'assets', 'app.js'), 'console.log(1);\n');
  // serveStatic resolves against cwd, and vitest runs from the repository root.
  webRoot = relative(process.cwd(), absoluteWebRoot);

  root = createServerApp(
    createApp(
      buildDeps({
        db: testDb(),
        clock: CLOCK,
        jwtSecret: new TextEncoder().encode('server-app-suite-secret'),
        encryptionKey: Buffer.alloc(32, 0x44),
        publicBaseUrl: 'http://api.test',
        rateLimit: { limit: 10_000, windowMs: 60_000, publicLimit: 10_000, loginLimit: 10_000 },
        env: { ...process.env, LOG_LEVEL: 'silent' },
      }),
    ),
    { webRoot },
  );
});

const get = (path: string) => root.request(path);

describe('the API is reachable under the prefix the client actually uses', () => {
  it('serves the API under /api, which is what the built client requests', async () => {
    // 401, not 404: the route EXISTS and refused the caller. Before this file, the
    // deployed client got 404 here for every screen it tried to load.
    const response = await get('/api/campaigns');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('a 404 under /api is a JSON 404, not an HTML page', async () => {
    const response = await get('/api/no-such-route');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

describe('the public surfaces stay unprefixed', () => {
  // A mail client following an unsubscribe link, a provider posting a webhook and a
  // load balancer probing health will never prepend `/api`. Rewriting these would
  // break exactly the links invariant I7 exists to prove resolve.
  it('answers /healthz without the prefix', async () => {
    const response = await get('/healthz');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('answers an unsubscribe URL without the prefix', async () => {
    // A stale unsubscribe link is answered by the ROUTE, which renders a real page
    // for the recipient holding it — HTML with a 404 is correct here. What must not
    // happen is the SPA shell being served instead, which would leave somebody who
    // clicked unsubscribe staring at an operator console that cannot load.
    const response = await get('/u/not-a-real-token');
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body, 'the unsubscribe page, not the operator SPA').not.toContain('<div id="root">');
  });
});

describe('everything else is the SPA', () => {
  it('serves index.html at the root', async () => {
    const response = await get('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  it('serves a static asset', async () => {
    const response = await get('/assets/app.js');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('console.log');
  });

  it.each(['/queue', '/contacts/00000000-0000-0000-0000-000000000000', '/mock-outbox'])(
    'serves the SPA at %s, which is ALSO an API path',
    async (path) => {
      // The collision this whole arrangement exists for. Without the namespace the
      // API answers these and the operator is shown JSON instead of a screen.
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<div id="root">');
    },
  );

  it('serves the SPA for a deep client route so a reload does not 404', async () => {
    const response = await get('/campaigns/00000000-0000-0000-0000-000000000000/analytics');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  it('does NOT serve the SPA for a POST to an unknown path', async () => {
    // A mistyped POST is a client error. Answering 200 with an HTML page would hide
    // it from whatever made the request.
    const response = await root.request('/definitely-not-a-route', { method: 'POST' });
    expect(response.status).not.toBe(200);
  });
});
