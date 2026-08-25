import { z } from 'zod';

/**
 * The error envelope.
 *
 * `{ error: { code, message, details? } }` — and `details` is carried all the way
 * to the client, deliberately.
 *
 * The failure this exists to prevent is not a crash. It is a server that knows
 * exactly which of forty audience rules is malformed, and a client that renders
 * "Save failed". The diagnosis is produced correctly and then thrown away one
 * layer before anyone can read it, so the operator files a ticket, an engineer
 * reproduces it locally, and the answer was in the response body the whole time.
 * tests/integration/api-error-envelope.test.ts asserts the field survives, because
 * the natural way to lose it is a well-meaning `catch` that re-wraps the error.
 */
export type ErrorEnvelope = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
};

/** HTTP statuses this layer produces. Kept closed so a handler cannot invent a 418. */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 415 | 422 | 429 | 500 | 503;

export class ApiError extends Error {
  readonly status: ErrorStatus;
  readonly code: string;
  readonly details: unknown;

  constructor(status: ErrorStatus, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(400, code, message, details);

export const unauthorized = (message: string, details?: unknown): ApiError =>
  new ApiError(401, 'unauthorized', message, details);

export const forbidden = (message: string, details?: unknown): ApiError =>
  new ApiError(403, 'forbidden', message, details);

/**
 * A row that exists in another tenant is reported as 404, never 403.
 *
 * A 403 confirms the id exists, which turns any authenticated account into an
 * oracle for enumerating another tenant's campaign ids. "Not found" is both the
 * honest answer from inside this tenant's world and the one that leaks nothing.
 */
export const notFound = (resource: string, id?: string): ApiError =>
  new ApiError(
    404,
    'not_found',
    `${resource} was not found in this tenant.`,
    id === undefined ? undefined : { resource, id },
  );

export const conflict = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(409, code, message, details);

export const unprocessable = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(422, code, message, details);

export const tooManyRequests = (message: string, details?: unknown): ApiError =>
  new ApiError(429, 'rate_limited', message, details);

type ZodIssueView = {
  readonly path: string;
  readonly code: string;
  readonly message: string;
};

/**
 * Flatten a zod error into something a form can point at.
 *
 * The path is joined into `messages[0].subject_template` rather than left as an
 * array, because the client that most needs this is a form that keys its fields
 * by dotted path, and asking every consumer to re-join the array is how the field
 * ends up ignored.
 */
export function zodDetails(error: z.ZodError): { readonly issues: readonly ZodIssueView[] } {
  return {
    issues: error.issues.map((issue) => ({
      path: issue.path.map((p) => String(p)).join('.'),
      code: issue.code,
      message: issue.message,
    })),
  };
}

export type RenderedError = {
  readonly status: ErrorStatus;
  readonly body: ErrorEnvelope;
};

/**
 * Turn anything thrown anywhere into the envelope.
 *
 * Two rules: a known error keeps its `details`, and an unknown error gets none.
 * An unhandled exception's message can carry a connection string or a fragment of
 * a row, so the generic arm says nothing — the detail goes to the log, where the
 * request id ties it back.
 */
export function renderError(error: unknown): RenderedError {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        error:
          error.details === undefined
            ? { code: error.code, message: error.message }
            : { code: error.code, message: error.message, details: error.details },
      },
    };
  }

  if (error instanceof z.ZodError) {
    return {
      status: 422,
      body: {
        error: {
          code: 'validation_failed',
          message: 'The request body did not validate.',
          details: zodDetails(error),
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message: 'The request could not be completed.',
      },
    },
  };
}
