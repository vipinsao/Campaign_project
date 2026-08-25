/**
 * The metric vocabulary, imported from the domain rather than restated here.
 *
 * `METRICS`, `rate`, `formatRate` and `metricsForChannel` come from
 * packages/core/src/metrics/denominators.ts. That module exists so every rate in
 * the system is defined exactly once (I12); a UI that recomputed
 * `opens / delivered` locally would be the second definition, and the second
 * definition is always the wrong one eventually.
 *
 * The import reaches the module directly rather than through `@campaign/core`'s
 * barrel because the barrel also re-exports the queue, the pool and the delivery
 * orchestrator, which pull `pg` and `node:crypto` into a browser bundle. The
 * denominators module itself imports one *type* from `@campaign/shared` and
 * nothing else, so it is the domain, unmodified, running in the browser.
 */
export {
  METRICS,
  rate,
  formatRate,
  metricsForChannel,
  isMetricValidForChannel,
} from '@campaign/core/metrics/denominators';
export type { MetricDefinition, MetricInputs, MetricKey } from '@campaign/core/metrics/denominators';

import type { MetricInputs } from '@campaign/core/metrics/denominators';

/**
 * Build a `MetricInputs` from whatever counts an endpoint actually returned.
 *
 * Every field defaults to 0, and that is safe ONLY because `rate()` treats a zero
 * DENOMINATOR as "not computable" and returns null. So a metric whose denominator
 * this endpoint does not report — per-message `clickableDelivered`, for instance —
 * comes out as `null` and renders as an em dash, rather than as a confident 0.0%
 * computed against a denominator nobody supplied.
 */
export function metricInputs(partial: Partial<MetricInputs>): MetricInputs {
  return {
    queued: partial.queued ?? 0,
    sent: partial.sent ?? 0,
    delivered: partial.delivered ?? 0,
    failed: partial.failed ?? 0,
    bounced: partial.bounced ?? 0,
    complained: partial.complained ?? 0,
    uniqueOpens: partial.uniqueOpens ?? 0,
    uniqueClicks: partial.uniqueClicks ?? 0,
    unsubscribes: partial.unsubscribes ?? 0,
    clickableDelivered: partial.clickableDelivered ?? 0,
    attributedOrders: partial.attributedOrders ?? 0,
  };
}
