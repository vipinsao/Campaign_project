import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

/**
 * Model-call telemetry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This file is what turns "I thought about cost" into "I measured cost".
 *
 * Every claim an AI feature makes about itself — it is cheap, it is fast, the
 * cache is working, the retries are rare — is unfalsifiable until the numbers are
 * on the span. The failure this prevents is the one that only shows up on the
 * invoice: a prompt change that quietly doubles input tokens, a cache key that
 * stopped matching after a whitespace edit, a retry loop that fires on 8% of
 * calls. None of those raise an exception. All of them are obvious the moment
 * `cost_usd` and `cache_hit` are attributes you can group by.
 *
 * The attributes are set on EVERY call, including cache hits (cost 0) and
 * failures, because a spend dashboard that silently omits the cheap calls cannot
 * be used to compute a hit rate.
 *
 * With no OpenTelemetry SDK registered — which is the case in tests and in the
 * zero-credential demo — `trace.getTracer` returns a no-op tracer. Instrumentation
 * therefore costs nothing and needs no conditional guard at the call sites.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const tracer = trace.getTracer('@campaign/triage', '0.1.0');

/** The attribute set every model call must carry. Named, so a call site cannot
 *  forget one and have it merely be absent from the dashboard. */
export type ModelSpanAttributes = {
  readonly modelId: string;
  readonly promptName: string;
  readonly promptVersion: number;
  readonly tenantId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly cacheHit: boolean;
};

/**
 * Semantic-convention names where OpenTelemetry has one (`gen_ai.*`), and a
 * `campaign.*` prefix where it does not. Inventing a name inside the `gen_ai`
 * namespace would collide with whatever the convention settles on later.
 */
export function modelSpanAttributes(a: ModelSpanAttributes): Attributes {
  return {
    'gen_ai.system': 'anthropic',
    'gen_ai.request.model': a.modelId,
    'gen_ai.usage.input_tokens': a.inputTokens,
    'gen_ai.usage.output_tokens': a.outputTokens,
    'campaign.prompt.name': a.promptName,
    'campaign.prompt.version': a.promptVersion,
    'campaign.tenant_id': a.tenantId,
    'campaign.model.cost_usd': a.costUsd,
    'campaign.model.latency_ms': a.latencyMs,
    'campaign.model.cache_hit': a.cacheHit,
  };
}

/**
 * Run `fn` inside a span named for the model call.
 *
 * `fn` reports the attributes itself rather than receiving them up front, because
 * token counts and latency are only known once the call has returned — and a span
 * that records the request but not the response is exactly the span that cannot
 * answer "what did that cost?".
 */
export async function withModelSpan<T>(
  name: string,
  fn: (report: (a: ModelSpanAttributes) => void) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span: Span) => {
    try {
      const result = await fn((a) => {
        span.setAttributes(modelSpanAttributes(a));
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      // A failed model call still has to appear in the trace. Swallowing it here
      // is how a 30% error rate becomes invisible until a customer reports it.
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
