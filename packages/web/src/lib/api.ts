/**
 * The one place that knows the API's error envelope.
 *
 * The API goes to real trouble to say WHICH of forty audience rules is malformed,
 * WHICH nine activation checks failed, and WHICH constraint the database refused —
 * all of it in `error.details`. A client that catches the response and renders
 * "Save failed" throws that away one layer before anybody can read it, and the
 * operator files a ticket for a diagnosis that was already in the response body.
 *
 * So `ApiError` carries `details` through untouched, and `explainDetails()` below
 * knows the small number of shapes the server actually produces, so a form can
 * point at a field instead of showing a wall of JSON. Anything it does not
 * recognise is rendered verbatim rather than dropped — an unknown diagnosis is
 * still a diagnosis.
 */

import { displayUnknown } from './format.ts';

const BASE = '/api';
const TOKEN_KEY = 'campaign.operator.token';
const USER_KEY = 'campaign.operator.user';

export type ErrorEnvelope = {
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Thrown when the request never reached the API at all. Distinct on purpose:
 *  "the server said no" and "there was no server" call for different screens. */
export class NetworkError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('The API could not be reached. Is `npm run dev` running on :3000?');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

// ── session ──────────────────────────────────────────────────────────────────

export type Operator = {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly tenantId: string;
};

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function readOperator(): Operator | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw === null ? null : (JSON.parse(raw) as Operator);
  } catch {
    return null;
  }
}

export function storeSession(token: string, user: Operator): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* private browsing; the session simply will not survive a reload. */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* nothing to clear. */
  }
  window.dispatchEvent(new CustomEvent('campaign:signed-out'));
}

// ── the request ──────────────────────────────────────────────────────────────

type RequestOptions = {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly query?: Record<string, string | number | undefined | null>;
  /**
   * Statuses that are a legitimate answer rather than a failure.
   *
   * `/orders/lookup` returns **300 Multiple Choices** for an ambiguous order
   * number, and that is the single most important response in this product (I13).
   * A client whose only rule is `if (!res.ok) throw` turns the one answer the API
   * was carefully designed to give into a generic error toast.
   */
  readonly accept?: readonly number[];
};

function buildUrl(path: string, query: RequestOptions['query']): string {
  const url = new URL(BASE + path, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = readToken();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }

  const text = await response.text();
  const parsed: unknown = text.length === 0 ? null : safeJson(text);

  if (response.ok || (options.accept ?? []).includes(response.status)) {
    return parsed as T;
  }

  // An expired token is not an error the page should render; it is a session that
  // ended. Everything else is the caller's to explain.
  if (response.status === 401 && path !== '/auth/login') clearSession();

  const envelope = parsed as Partial<ErrorEnvelope> | null;
  const error = envelope?.error;
  throw new ApiError(
    response.status,
    error?.code ?? 'unknown_error',
    error?.message ?? `The API returned ${String(response.status)} with no error envelope.`,
    error?.details,
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'unparseable_response', message: text.slice(0, 400) } };
  }
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], accept?: readonly number[]) =>
    request<T>(path, { method: 'GET', ...(query ? { query } : {}), ...(accept ? { accept } : {}) }),
  post: <T>(path: string, body?: unknown, accept?: readonly number[]) =>
    request<T>(path, { method: 'POST', body: body ?? {}, ...(accept ? { accept } : {}) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string, query?: RequestOptions['query']) =>
    request<T>(path, { method: 'DELETE', ...(query ? { query } : {}) }),
};

// ── making `details` legible ─────────────────────────────────────────────────

export type DetailLine = {
  /** A dotted field path, a message id, or a constraint name — whatever the server named. */
  readonly at: string | null;
  readonly text: string;
};

type ZodIssue = { path?: unknown; code?: unknown; message?: unknown };
type Failure = { code?: unknown; message?: unknown; field?: unknown; campaignMessageId?: unknown };

/**
 * Translate the shapes the API actually emits into lines a form can render.
 *
 * The four it knows about are the four `errors.ts` and the route handlers produce:
 * zod `issues`, activation `failures`, the audience compiler's `path`, and a
 * Postgres `constraint`. Everything else falls through to pretty-printed JSON,
 * because rendering an unrecognised diagnosis badly still beats swallowing it.
 */
export function explainDetails(details: unknown): readonly DetailLine[] {
  if (details === undefined || details === null) return [];
  if (typeof details !== 'object') return [{ at: null, text: displayUnknown(details) ?? '' }];

  const bag = details as Record<string, unknown>;

  if (Array.isArray(bag.issues)) {
    return (bag.issues as ZodIssue[]).map((issue) => ({
      at: typeof issue.path === 'string' && issue.path.length > 0 ? issue.path : null,
      text: typeof issue.message === 'string' ? issue.message : 'invalid',
    }));
  }

  if (Array.isArray(bag.failures)) {
    return (bag.failures as Failure[]).map((failure) => ({
      at:
        typeof failure.field === 'string'
          ? failure.field
          : typeof failure.campaignMessageId === 'string'
            ? `message ${failure.campaignMessageId.slice(0, 8)}`
            : typeof failure.code === 'string'
              ? failure.code
              : null,
      text: typeof failure.message === 'string' ? failure.message : 'invalid',
    }));
  }

  if (typeof bag.path === 'string') {
    return [{ at: bag.path, text: 'This rule is the one the compiler rejected.' }];
  }

  if (typeof bag.constraint === 'string') {
    return [
      {
        at: bag.constraint,
        text: `The database refused this write: constraint \`${bag.constraint}\`${
          typeof bag.table === 'string' ? ` on \`${bag.table}\`` : ''
        }.`,
      },
    ];
  }

  return Object.entries(bag).map(([key, value]) => ({
    at: key,
    text: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}

/** The activation failures, keyed by the message they belong to, for the canvas. */
export function failuresByMessage(details: unknown): Map<string, string[]> {
  const byMessage = new Map<string, string[]>();
  if (typeof details !== 'object' || details === null) return byMessage;
  const failures = (details as Record<string, unknown>).failures;
  if (!Array.isArray(failures)) return byMessage;
  for (const raw of failures as Failure[]) {
    const id = typeof raw.campaignMessageId === 'string' ? raw.campaignMessageId : '__campaign';
    const text = typeof raw.message === 'string' ? raw.message : 'invalid';
    byMessage.set(id, [...(byMessage.get(id) ?? []), text]);
  }
  return byMessage;
}
