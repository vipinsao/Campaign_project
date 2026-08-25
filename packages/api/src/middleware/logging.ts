import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import type { Logger } from 'pino';
import type { HttpMetrics } from '../observability/metrics.ts';
import type { AppEnv } from './context.ts';

/**
 * Request logging and the HTTP metrics, in one pass.
 *
 * They share a middleware because they share a measurement: walking the timer
 * twice would let the log line and the histogram disagree about the same request,
 * and a p95 that does not match the slow-request log is a p95 nobody trusts.
 *
 * The request id is echoed back in `x-request-id`. That header is the entire
 * reason the 500 arm of the error envelope can afford to say nothing useful: the
 * operator reports the id, and the log has the stack.
 */
export function requestLogger(logger: Logger, metrics: HttpMetrics): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const inbound = c.req.header('x-request-id');
    // An inbound id is honoured so a trace survives the gateway, but it is bounded:
    // this value ends up as a log field on every line for the request, and an
    // unbounded one from the internet is a cheap way to fill a log budget.
    const requestId =
      inbound !== undefined && inbound.length > 0 && inbound.length <= 200 ? inbound : randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);

    const started = process.hrtime.bigint();
    try {
      await next();
    } finally {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      // The matched PATTERN, not the path. See the note in observability/metrics.ts:
      // labelling by path makes every campaign id its own time series. The `-1`
      // asks for the last route that matched — the handler — rather than this
      // middleware's own '*', which would label every request identically.
      const route = routePath(c, -1);
      const method = c.req.method;
      const status = c.res.status;

      metrics.duration.observe({ method, route }, seconds);
      metrics.requests.inc({ method, route, status: String(status) });

      const line = {
        requestId,
        method,
        route,
        status,
        durationMs: Math.round(seconds * 1000),
      };
      if (status >= 500) logger.error(line, 'request failed');
      else if (status >= 400) logger.warn(line, 'request rejected');
      else logger.info(line, 'request');
    }
  };
}
