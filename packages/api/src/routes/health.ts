import { Hono } from 'hono';
import type { ApiDeps } from '../deps.ts';
import type { HttpMetrics } from '../observability/metrics.ts';
import type { AppEnv } from '../middleware/context.ts';

/**
 * Liveness, readiness and metrics — three endpoints that are routinely collapsed
 * into one, with consequences.
 *
 * `/healthz` answers "is this process alive?" and touches NOTHING. It must not
 * query the database, because the orchestrator restarts a container that fails its
 * liveness probe: wire the database into liveness and a thirty-second database
 * blip becomes a rolling restart of every replica, which turns a recoverable
 * incident into an outage that also loses every in-flight request.
 *
 * `/readyz` answers "should traffic be sent here?" and DOES check the database,
 * because a replica that cannot reach Postgres should be taken out of the load
 * balancer — but left running, so it can rejoin when the database returns.
 */
export function healthRoutes(deps: ApiDeps, metrics: HttpMetrics): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/healthz', (c) => c.json({ status: 'ok', at: deps.clock.now().toISOString() }));

  app.get('/readyz', async (c) => {
    const started = Date.now();
    try {
      await deps.db.query('SELECT 1');
      return c.json({
        status: 'ready',
        checks: { database: { ok: true, latencyMs: Date.now() - started } },
      });
    } catch (error) {
      deps.logger.error({ err: error }, 'readiness check failed');
      // 503, and the reason is in the body rather than only in the log. An operator
      // reading a readiness failure at 03:00 should not have to go and find the
      // pod's logs to learn that it was DNS.
      return c.json(
        {
          status: 'not_ready',
          checks: {
            database: {
              ok: false,
              latencyMs: Date.now() - started,
              error: error instanceof Error ? error.message : 'unknown',
            },
          },
        },
        503,
      );
    }
  });

  /**
   * Unauthenticated, and that is a deployment assumption stated out loud: this
   * endpoint is expected to be reachable only from the cluster's scrape network.
   * Exposing it publicly would publish per-route latency and traffic volumes,
   * which is a business-intelligence leak rather than a security one — but it is
   * still a leak, and the mitigation is an ingress rule, not a bearer token that
   * every Prometheus deployment then has to be taught to send.
   */
  app.get('/metrics', async (c) => {
    const body = await metrics.registry.metrics();
    c.header('content-type', metrics.registry.contentType);
    return c.body(body);
  });

  return app;
}
