import type { ProviderResult } from '@campaign/shared';

/**
 * The small amount of HTTP plumbing the REST adapters share.
 *
 * It lives in its own file because `twilio.ts` and `postmark.ts` would otherwise
 * each grow their own copy, and the copies would drift in exactly the way that
 * makes one provider's timeouts classify correctly and the other's not.
 */

/**
 * Case-insensitive header read.
 *
 * Callers hand us whatever their HTTP layer produced. Node lower-cases incoming
 * header names, but a replay tool reading `webhook_deliveries.headers` back out of
 * JSONB does not necessarily preserve that, and a signature check that fails
 * because of header casing is indistinguishable from a forged request.
 */
export function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

/** Read a JSON body without letting a non-JSON error page throw away the status. */
export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

/**
 * Map a thrown fetch failure onto a ProviderResult.
 *
 * Node's error `code` (`ETIMEDOUT`, `ECONNRESET`, and the `UND_ERR_*` family) is
 * carried through unchanged so ERROR_TABLE can classify it. An abort from our own
 * deadline is reported as `ETIMEDOUT` rather than `AbortError`, because that is
 * what it is and because the table should not need an entry per HTTP client.
 */
export function transportFailure(error: unknown, providerLabel: string): ProviderResult {
  const err = (error ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const aborted = err.name === 'TimeoutError' || err.name === 'AbortError';
  const code = aborted ? 'ETIMEDOUT' : typeof err.code === 'string' ? err.code : 'UNKNOWN';
  return {
    ok: false,
    errorCode: code,
    errorMessage:
      typeof err.message === 'string' ? err.message : `The request to ${providerLabel} failed.`,
    raw: { name: err.name ?? null, code: err.code ?? null },
  };
}

/**
 * Timeout applied to every provider call.
 *
 * Without an explicit deadline a send inherits the platform default, which is long
 * enough that a worker parks on a half-open socket while the queue rows it has
 * claimed age into the stale-claim reaper and get sent twice.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
