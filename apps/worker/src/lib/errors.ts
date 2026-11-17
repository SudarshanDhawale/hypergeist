// The only place that builds an error response. The body carries the error code
// and nothing else, so no route can leak request, upstream or exception text.

export const ERROR_CODES = [
  'BAD_REQUEST',
  'FORBIDDEN_ORIGIN',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'DAILY_CAP',
  'MODEL_NOT_ALLOWED',
  'AI_DISABLED',
  'UPSTREAM_FAILED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  FORBIDDEN_ORIGIN: 403,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  DAILY_CAP: 429,
  MODEL_NOT_ALLOWED: 400,
  AI_DISABLED: 503,
  UPSTREAM_FAILED: 503,
  INTERNAL: 500,
};

export type ErrorResponseOptions = {
  /** Seconds until the caller may retry. Only used for 429 codes. */
  readonly retryAfterSeconds?: number;
};

export function errorResponse(code: ErrorCode, options?: ErrorResponseOptions): Response {
  const status = ERROR_STATUS[code];
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const retryAfter = options?.retryAfterSeconds;
  if (status === 429 && retryAfter !== undefined) {
    // Whole seconds, at least 1. A non-finite value falls back to 1.
    const seconds = Number.isFinite(retryAfter) ? Math.max(1, Math.ceil(retryAfter)) : 1;
    headers.set('retry-after', String(seconds));
  }
  return new Response(JSON.stringify({ error: { code } }), { status, headers });
}
