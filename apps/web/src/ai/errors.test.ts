import { describe, expect, it } from 'vitest';
import {
  PROVIDER_ERROR_CODES,
  errorFromHttp,
  errorFromProxy,
  errorFromThrown,
  isProviderErrorCode,
  providerError,
} from './errors.ts';
import type { ProviderErrorCode } from './types.ts';

const FAKE_KEY = 'sk-test-1234567890abcdef';

function codeOf(status: number, body?: string): ProviderErrorCode {
  return errorFromHttp(status, body).code;
}

describe('PROVIDER_ERROR_CODES', () => {
  it('holds the 12 codes of the closed set, without duplicates', () => {
    expect(PROVIDER_ERROR_CODES).toHaveLength(12);
    expect(new Set(PROVIDER_ERROR_CODES).size).toBe(12);
    expect(PROVIDER_ERROR_CODES).toContain('DEMO_ONLY');
  });

  it('isProviderErrorCode accepts every code and nothing else', () => {
    for (const code of PROVIDER_ERROR_CODES) expect(isProviderErrorCode(code)).toBe(true);
    for (const other of ['nope', '', 'network', 42, null, undefined, {}, ['AUTH']]) {
      expect(isProviderErrorCode(other)).toBe(false);
    }
  });
});

describe('providerError', () => {
  it.each(PROVIDER_ERROR_CODES)(
    '%s has a plain message and hint of at most 200 characters',
    (code) => {
      const error = providerError(code);
      expect(error.code).toBe(code);
      expect(error.message.trim().length).toBeGreaterThan(0);
      expect(error.hint.trim().length).toBeGreaterThan(0);
      expect(error.message.length).toBeLessThanOrEqual(200);
      expect(error.hint.length).toBeLessThanOrEqual(200);
    },
  );

  it.each(PROVIDER_ERROR_CODES)(
    '%s text has no URL, bearer token, key prefix or placeholder',
    (code) => {
      const { message, hint } = providerError(code);
      for (const text of [message, hint]) {
        expect(text.toLowerCase()).not.toContain('http');
        expect(text).not.toContain('Bearer');
        expect(text).not.toContain('sk-');
        expect(text).not.toMatch(/[{}<>]|\$\{|%s/);
      }
    },
  );

  it('returns a new object on every call', () => {
    const a = providerError('AUTH');
    const b = providerError('AUTH');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('tells the user about demo mode when the browser cannot reach the provider', () => {
    expect(providerError('CORS_OR_OFFLINE').hint.toLowerCase()).toContain('demo mode');
  });
});

describe('errorFromHttp', () => {
  it.each([
    [400, 'BAD_REQUEST'],
    [401, 'AUTH'],
    [402, 'QUOTA'],
    [403, 'AUTH'],
    [404, 'MODEL_NOT_FOUND'],
    [422, 'BAD_REQUEST'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER'],
    [502, 'SERVER'],
    [503, 'SERVER'],
    [418, 'BAD_REQUEST'],
    [599, 'SERVER'],
    [499, 'BAD_REQUEST'],
  ] as const)('status %i gives %s', (status, code) => {
    expect(codeOf(status)).toBe(code);
  });

  it.each(['You exceeded your current QUOTA', 'billing hard limit reached', 'Insufficient funds'])(
    '429 with the body "%s" gives QUOTA',
    (body) => {
      expect(codeOf(429, body)).toBe('QUOTA');
    },
  );

  it('429 with an unrelated or empty body gives RATE_LIMITED', () => {
    expect(codeOf(429, 'Too many requests, slow down')).toBe('RATE_LIMITED');
    expect(codeOf(429, '')).toBe('RATE_LIMITED');
  });

  it('only 429 reads the body for quota words', () => {
    expect(codeOf(500, 'quota')).toBe('SERVER');
    expect(codeOf(400, 'billing')).toBe('BAD_REQUEST');
  });

  it('treats a status outside 400 to 599 as BAD_REPLY', () => {
    for (const status of [0, 100, 200, 204, 301, 399, 600]) {
      expect(codeOf(status)).toBe('BAD_REPLY');
    }
  });

  it('never returns the body text', () => {
    const body = `{"error":"quota exceeded for key ${FAKE_KEY}"}`;
    for (const status of [400, 401, 402, 404, 429, 500, 418]) {
      expect(JSON.stringify(errorFromHttp(status, body))).not.toContain(FAKE_KEY);
    }
  });

  it('always returns a code of the closed set, for every status', () => {
    for (let status = 0; status < 700; status += 1) {
      expect(isProviderErrorCode(errorFromHttp(status, 'quota').code)).toBe(true);
    }
  });
});

describe('errorFromThrown', () => {
  it('maps a TypeError to CORS_OR_OFFLINE', () => {
    expect(errorFromThrown(new TypeError('Failed to fetch')).code).toBe('CORS_OR_OFFLINE');
  });

  it('maps any other thrown value to NETWORK', () => {
    for (const value of [new Error('boom'), 'text', 42, null, undefined, { message: 'x' }]) {
      expect(errorFromThrown(value).code).toBe('NETWORK');
    }
  });

  it('maps the abort flags to TIMEOUT and ABORTED', () => {
    expect(errorFromThrown(new Error('x'), { timedOut: true }).code).toBe('TIMEOUT');
    expect(errorFromThrown(new TypeError('x'), { timedOut: true }).code).toBe('TIMEOUT');
    expect(errorFromThrown(new Error('x'), { aborted: true }).code).toBe('ABORTED');
    expect(errorFromThrown(new DOMException('x', 'AbortError'), { aborted: true }).code).toBe(
      'ABORTED',
    );
  });

  it('lets a caller abort win over a timeout', () => {
    expect(errorFromThrown(null, { timedOut: true, aborted: true }).code).toBe('ABORTED');
  });

  it('ignores false flags', () => {
    expect(errorFromThrown(new Error('x'), { timedOut: false, aborted: false }).code).toBe(
      'NETWORK',
    );
  });

  it('never copies the thrown value, even when it carries a key', () => {
    const thrown: readonly unknown[] = [
      new Error(`request to https://api.example.com failed with Bearer ${FAKE_KEY}`),
      new TypeError(`Failed to fetch ${FAKE_KEY}`),
      FAKE_KEY,
      { message: FAKE_KEY, toString: () => FAKE_KEY },
    ];
    for (const value of thrown) {
      for (const flags of [{}, { timedOut: true }, { aborted: true }]) {
        const text = JSON.stringify(errorFromThrown(value, flags));
        expect(text).not.toContain(FAKE_KEY);
        expect(text).not.toContain('Bearer');
      }
    }
  });
});

describe('errorFromProxy', () => {
  it('maps the proxy codes', () => {
    expect(errorFromProxy('RATE_LIMITED', 429).code).toBe('RATE_LIMITED');
    expect(errorFromProxy('DAILY_CAP', 429).code).toBe('QUOTA');
    expect(errorFromProxy('MODEL_NOT_ALLOWED', 403).code).toBe('BAD_REQUEST');
  });

  it('lets the proxy code win over the status', () => {
    expect(errorFromProxy('DAILY_CAP', 500).code).toBe('QUOTA');
    expect(errorFromProxy('RATE_LIMITED', 200).code).toBe('RATE_LIMITED');
  });

  it('maps a 404 (route missing) and 401 or 403 without a code to SERVER', () => {
    expect(errorFromProxy(undefined, 404).code).toBe('SERVER');
    expect(errorFromProxy(null, 401).code).toBe('SERVER');
    expect(errorFromProxy('SOMETHING_ELSE', 403).code).toBe('SERVER');
  });

  it('falls back to the HTTP status for an unknown or missing code', () => {
    expect(errorFromProxy(undefined, 429).code).toBe('RATE_LIMITED');
    expect(errorFromProxy('UNKNOWN', 500).code).toBe('SERVER');
    expect(errorFromProxy(undefined, 502).code).toBe('SERVER');
    expect(errorFromProxy(undefined, 400).code).toBe('BAD_REQUEST');
    expect(errorFromProxy(undefined, 422).code).toBe('BAD_REQUEST');
  });

  it('treats a non-string code as unknown', () => {
    expect(errorFromProxy(42, 500).code).toBe('SERVER');
    expect(errorFromProxy({ code: 'DAILY_CAP' }, 400).code).toBe('BAD_REQUEST');
  });

  it('does not treat prototype names as codes', () => {
    expect(errorFromProxy('constructor', 500).code).toBe('SERVER');
    expect(errorFromProxy('__proto__', 429).code).toBe('RATE_LIMITED');
  });
});
