import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * The metrics surface.
 *
 * One registry per app instance rather than the library's global default. The
 * global registry throws on a duplicate metric name, so a test suite that boots
 * the app twice in one process fails on the second boot with an error about
 * `http_requests_total` that has nothing to do with the test — and the usual fix
 * for that is `register.clear()` in a hook, which quietly deletes the metrics of
 * whichever app is still running.
 */
export type HttpMetrics = {
  readonly registry: Registry;
  readonly requests: Counter<'method' | 'route' | 'status'>;
  readonly duration: Histogram<'method' | 'route'>;
  readonly rateLimited: Counter<'bucket'>;
  readonly webhooks: Counter<'provider' | 'signature_status'>;
};

/**
 * Route labels come from the matched ROUTE PATTERN, never the raw path.
 *
 * `/campaigns/:id` is one time series; `/campaigns/<uuid>` is one time series per
 * campaign, which is an unbounded label set. Cardinality explosions of this shape
 * do not degrade gracefully — they take the scrape endpoint, and therefore all the
 * other metrics, down with them.
 */
export function buildRegistry(opts: { readonly defaultMetrics?: boolean } = {}): Registry {
  const registry = new Registry();
  if (opts.defaultMetrics === true) {
    collectDefaultMetrics({ register: registry });
  }
  return registry;
}

export function buildHttpMetrics(registry: Registry): HttpMetrics {
  const requests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled, by matched route pattern and status.',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by matched route pattern.',
    labelNames: ['method', 'route'] as const,
    // Buckets chosen for this API's actual shape: the tracking pixel must stay in
    // single-digit milliseconds, audience estimates are allowed to be slow, and
    // the interesting question is which side of 250ms the p95 sits on.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const rateLimited = new Counter({
    name: 'http_rate_limited_total',
    help: 'Requests refused by the rate limiter, by bucket.',
    labelNames: ['bucket'] as const,
    registers: [registry],
  });

  const webhooks = new Counter({
    name: 'webhook_deliveries_total',
    help: 'Inbound provider callbacks, by provider and signature outcome.',
    labelNames: ['provider', 'signature_status'] as const,
    registers: [registry],
  });

  return { registry, requests, duration, rateLimited, webhooks };
}
