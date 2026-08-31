import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { App } from './app.ts';

/**
 * The process-level app: the API, the built SPA, and the boundary between them.
 *
 * `createApp` mounts every route at the ROOT — `/campaigns`, `/queue`,
 * `/contacts/:id`. The browser client asks for `/api/campaigns`, and in
 * development the Vite proxy strips that prefix. Nothing stripped it in
 * production, so a deployed build called `/api/campaigns` and got a 404 on every
 * request. This file is what was missing.
 *
 * The prefix cannot simply be dropped, because the SPA and the API genuinely
 * collide: `/queue` is an operator PAGE and a JSON endpoint, `/contacts/:id` is
 * both a page and a resource. Served from one origin without a namespace, the API
 * wins every one of those paths and the operator gets JSON where a screen should
 * be. `/api` is the namespace that keeps them apart.
 *
 * Three groups, in this order, and the order is the whole design:
 *
 *   1. `/api/*`      the API, prefix stripped by the mount
 *   2. the unprefixed public surfaces — a mail client following an unsubscribe
 *      link, a provider posting a webhook and a load balancer probing health will
 *      never prepend `/api`, and rewriting those URLs would break the very links
 *      invariant I7 exists to prove resolve
 *   3. static files, then `index.html` for anything left, so a deep link to
 *      `/campaigns/<id>/analytics` reloads into the SPA instead of 404ing
 */
const UNPREFIXED = [
  '/healthz',
  '/readyz',
  '/metrics',
  '/t/*',
  '/r/*',
  '/u/*',
  '/webhooks/*',
] as const;

export type ServerAppOptions = {
  /** Path to the built SPA, relative to cwd. `null` serves the API alone. */
  readonly webRoot?: string | null;
};

export function createServerApp(api: App, options: ServerAppOptions = {}): Hono {
  const root = new Hono();

  root.route('/api', api);
  for (const path of UNPREFIXED) {
    // Forwarded raw and unrewritten: same URL, same method, same body.
    root.all(path, (c) => api.fetch(c.req.raw));
  }

  const webRoot = options.webRoot === undefined ? defaultWebRoot() : options.webRoot;
  if (webRoot !== null) {
    const files = serveStatic({ root: webRoot });
    const shell = serveStatic({ path: `${webRoot}/index.html` });

    /**
     * The SPA must never answer for `/api`.
     *
     * A sub-app mounted with `route()` does not get to run its own `notFound`, so
     * an unmatched `/api/*` falls straight through to whatever is registered next.
     * With the fallback unguarded that was `index.html`, and a mistyped or removed
     * endpoint answered 200 with an HTML page — which the client would then try to
     * parse as JSON, turning a clear 404 into an incoherent runtime error far from
     * its cause.
     */
    const notApi = (handler: MiddlewareHandler): MiddlewareHandler =>
      async function spaOnly(c, next) {
        if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return next();
        return handler(c, next);
      };

    root.use('/*', notApi(files));
    // GET only: a POST to an unknown path is a client error and must stay a 404,
    // not a 200 carrying an HTML page.
    root.get('*', notApi(shell));
  }

  // The API envelope, for anything that reached neither the API nor the SPA.
  root.notFound((c) =>
    c.json(
      {
        error: {
          code: 'not_found',
          message: 'No route matches this request.',
          details: { method: c.req.method, path: c.req.path },
        },
      },
      404,
    ),
  );

  return root;
}

/**
 * The built SPA, if this deployment has one.
 *
 * Returning `null` rather than throwing is deliberate: an API-only deployment is a
 * legitimate configuration, and a worker image that never serves HTTP should not
 * fail to boot over a missing frontend build.
 */
export function defaultWebRoot(): string | null {
  const candidate = 'packages/web/dist';
  return existsSync(`${candidate}/index.html`) ? candidate : null;
}
