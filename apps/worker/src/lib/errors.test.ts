import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_STATUS, errorResponse, type ErrorCode } from './errors';

const EXPECTED_STATUS: Record<ErrorCode, number> = {
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

describe('ERROR_CODES and ERROR_STATUS', () => {
  it('lists the nine codes of the contract', () => {
    expect([...ERROR_CODES]).toEqual(Object.keys(EXPECTED_STATUS));
    expect(ERROR_CODES).toHaveLength(9);
  });

  it('maps every code to its status and nothing else', () => {
    expect({ ...ERROR_STATUS }).toEqual(EXPECTED_STATUS);
  });
});

describe('errorResponse', () => {
  it.each(ERROR_CODES)('%s has the right status, headers and body', async (code) => {
    const response = errorResponse(code);

    expect(response.status).toBe(EXPECTED_STATUS[code]);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toEqual({ error: { code } });
  });

  it.each(ERROR_CODES)('%s body has no field except error.code', async (code) => {
    const body: unknown = await errorResponse(code, { retryAfterSeconds: 30 }).json();

    expect(body).toEqual({ error: { code } });
    expect(Object.keys(body as object)).toEqual(['error']);
    expect(Object.keys((body as { error: object }).error)).toEqual(['code']);
  });

  it('sets Retry-After for the 429 codes when given', () => {
    for (const code of ['RATE_LIMITED', 'DAILY_CAP'] as const) {
      expect(errorResponse(code, { retryAfterSeconds: 42 }).headers.get('retry-after')).toBe('42');
    }
  });

  it('omits Retry-After for a 429 code when not given', () => {
    expect(errorResponse('RATE_LIMITED').headers.has('retry-after')).toBe(false);
    expect(errorResponse('DAILY_CAP', {}).headers.has('retry-after')).toBe(false);
  });

  it('never sets Retry-After for a code that is not 429', () => {
    for (const code of ERROR_CODES) {
      if (EXPECTED_STATUS[code] === 429) continue;
      expect(errorResponse(code, { retryAfterSeconds: 30 }).headers.has('retry-after')).toBe(false);
    }
  });

  it('rounds Retry-After up to an integer of at least 1', () => {
    const retryAfter = (seconds: number): string | null =>
      errorResponse('RATE_LIMITED', { retryAfterSeconds: seconds }).headers.get('retry-after');

    expect(retryAfter(0)).toBe('1');
    expect(retryAfter(0.2)).toBe('1');
    expect(retryAfter(-5)).toBe('1');
    expect(retryAfter(1.2)).toBe('2');
    expect(retryAfter(86_400)).toBe('86400');
    expect(retryAfter(Number.NaN)).toBe('1');
    expect(retryAfter(Number.POSITIVE_INFINITY)).toBe('1');
  });
});
