import { Hono } from 'hono';
import { DEFAULT_RATE_LIMIT, type ApiDeps } from './deps.ts';
import { buildHttpMetrics, type HttpMetrics } from './observability/metrics.ts';
import type { AppEnv } from './middleware/context.ts';
import { renderError } from './errors.ts';
import { requestLogger } from './middleware/logging.ts';
import { createRateLimiter, rateLimit, type RateLimiter } from './middleware/rate-limit.ts';
import { requireApiKey, requireOperator } from './middleware/auth.ts';
import { flowRoutes } from './routes/flow.ts';
import { operationsRoutes } from './routes/operations.ts';
import { authRoutes, sessionRoutes } from './routes/auth.ts';
import { healthRoutes } from './routes/health.ts';
import { publicRoutes } from './routes/public.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { campaignRoutes } from './routes/campaigns.ts';
import { analyticsRoutes } from './routes/analytics.ts';
import { audienceRoutes } from './routes/audience.ts';
import { templateRoutes } from './routes/templates.ts';
import { orderRoutes } from './routes/orders.ts';
import { contactRoutes } from './routes/contacts.ts';
import { suppressionRoutes } from './routes/suppressions.ts';
import { queueRoutes } from './routes/queue.ts';
import { decisionRoutes } from './routes/decisions.ts';
import { eventRoutes } from './routes/events.ts';
import { storefrontRoutes } from './routes/storefront.ts';

/**
 * The app factory.
 *
 * `createApp(deps)` builds a fully wired Hono app and does NOT listen on a port.
 * Everything the app needs arrives in `deps`, so the integration suite boots the
 * real application — the real middleware chain, the real error handler, the real
 * routes — against a test pool and a fixed clock, and drives it with
 * `app.request()` or `fetch`. A server that could only be exercised over a socket
 * would push the tests towards mocking the layer under test, which is the layer
 * the tests exist to check.
 *
 * The route table is grouped by what authenticates it, because that grouping is
 * the security boundary and it should be readable in one screen:
 *
 *   /healthz /readyz /metrics            no auth, operational
 *   /t /r /u /webhooks                   no auth, reached by mail clients and providers
 *   /auth/login                          no auth, tightly rate limited
 *   /events                              API key
 *   everything else                      operator session, tenant-scoped
 */
export type App = Hono<AppEnv>;

export type CreateAppOptions = {
  /** Shared across apps in a test process only if a test chooses to share it. */
  readonly limiter?: RateLimiter;
  readonly httpMetrics?: HttpMetrics;
};

export function createApp(deps: ApiDeps, options: CreateAppOptions = {}): App {
  const app = new Hono<AppEnv>();
  const metrics = options.httpMetrics ?? buildHttpMetrics(deps.metrics);
  const limiter = options.limiter ?? createRateLimiter();

  /**
   * One error handler for the whole app, and it is the only place a response body
   * for a failure is constructed.
   *
   * `details` survives here. Every handler throws a typed `ApiError` carrying the
   * specific diagnosis, and this function passes it through untouched. The failure
   * mode being prevented is a well-meaning wrapper that catches, logs, and
   * re-throws a generic error — after which the server still knows exactly what
   * went wrong and the client is told "request failed".
   */
  app.onError((error, c) => {
    const rendered = renderError(error);
    if (rendered.status >= 500) {
      deps.logger.error(
        { err: error, requestId: c.get('requestId'), path: c.req.path },
        'unhandled error',
      );
    }
    return c.json(rendered.body, rendered.status);
  });

  app.notFound((c) =>
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

  app.use('*', requestLogger(deps.logger, metrics));

  // ── operational, unauthenticated ──────────────────────────────────────────
  app.route('/', healthRoutes(deps, metrics));

  // ── public surfaces an email client or a provider reaches ─────────────────
  /**
   * A separate, much larger budget.
   *
   * One newsletter to fifty thousand people produces fifty thousand pixel fetches
   * in a few minutes, all from a handful of mail-provider proxy IPs. Sharing the
   * operator budget here would rate-limit a successful campaign's own analytics.
   */
  const publicLimit = rateLimit({
    limiter,
    clock: deps.clock,
    metrics,
    bucket: 'public',
    limit: deps.rateLimit.publicLimit,
    windowMs: deps.rateLimit.windowMs,
  });
  app.use('/t/*', publicLimit);
  app.use('/r/*', publicLimit);
  app.use('/u/*', publicLimit);
  app.use('/webhooks/*', publicLimit);
  app.route('/', publicRoutes(deps));
  app.route('/', webhookRoutes(deps, metrics));

  // ── the storefront: public, and the only public route that can cause a send ──
  /**
   * Its own bucket, and a deliberately small one.
   *
   * `/t/*` and `/u/*` are read-mostly and are hit by mail-provider proxies in
   * bursts, which is why the public budget is three thousand a minute. A checkout
   * is not that: it writes a contact, an order and a consent record, and hands a
   * real address to a real provider. Sharing the public budget here would let one
   * source place three thousand orders a minute against a free email tier and get
   * the sending account suspended, which takes the demo down permanently.
   *
   * Twenty a minute per source is generous for a human clicking around and useless
   * for anything else. The daily deployment budget inside the route is the second
   * line, for the case where the source rotates.
   */
  app.use(
    '/storefront/*',
    rateLimit({
      limiter,
      clock: deps.clock,
      metrics,
      bucket: 'storefront',
      limit: deps.rateLimit.storefrontLimit ?? DEFAULT_RATE_LIMIT.storefrontLimit ?? 20,
      windowMs: deps.rateLimit.windowMs,
    }),
  );
  app.route('/', storefrontRoutes(deps, deps.env));

  // ── login ─────────────────────────────────────────────────────────────────
  /**
   * Its own, deliberately small budget.
   *
   * `/auth/login` is the only endpoint in the system that will tell you whether a
   * guess was right. Ten attempts a minute per source makes credential stuffing
   * uneconomic without locking out a person who mistyped their password twice —
   * and account lockout, the usual alternative, is itself a denial-of-service
   * primitive aimed at whoever you want locked out.
   */
  app.use(
    '/auth/login',
    rateLimit({
      limiter,
      clock: deps.clock,
      metrics,
      bucket: 'login',
      limit: deps.rateLimit.loginLimit,
      windowMs: deps.rateLimit.windowMs,
    }),
  );
  app.route('/', authRoutes(deps));

  // ── API-key ingest ────────────────────────────────────────────────────────
  app.use('/events', requireApiKey(deps));
  app.route('/', eventRoutes(deps));

  // ── operator session, tenant-scoped ───────────────────────────────────────
  const operatorLimit = rateLimit({
    limiter,
    clock: deps.clock,
    metrics,
    bucket: 'operator',
    limit: deps.rateLimit.limit,
    windowMs: deps.rateLimit.windowMs,
  });

  /**
   * The guard is applied by PREFIX, not per handler.
   *
   * Registering `requireOperator` on each route individually is the version where
   * the forty-first route is added without it, and nothing fails — the route works
   * perfectly, for everybody, with no tenant. Prefix middleware means a new route
   * under one of these paths is authenticated before its handler is written.
   */
  for (const prefix of [
    '/auth/me',
    '/campaigns',
    '/campaigns/*',
    '/audience/*',
    '/templates/*',
    '/merge-fields',
    '/orders',
    '/orders/*',
    '/contacts/*',
    '/suppressions',
    '/queue',
    '/queue/*',
    '/decisions',
    '/flow/*',
    '/tenant',
    '/mock-outbox',
  ]) {
    app.use(prefix, requireOperator(deps), operatorLimit);
  }

  app.route('/', sessionRoutes());
  app.route('/', campaignRoutes(deps));
  app.route('/', analyticsRoutes(deps));
  app.route('/', audienceRoutes(deps));
  app.route('/', templateRoutes());
  app.route('/', orderRoutes(deps));
  app.route('/', contactRoutes(deps));
  app.route('/', suppressionRoutes(deps));
  app.route('/', queueRoutes(deps));
  app.route('/', decisionRoutes(deps));
  app.route('/', flowRoutes(deps));
  app.route('/', operationsRoutes(deps));

  return app;
}
