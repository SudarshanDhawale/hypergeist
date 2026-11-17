import { describe, expect, it } from 'vitest';
import { checkOrigin as checkOriginForMethod } from './origin';

const ALLOWED = ['https://hypergeist.example', 'http://localhost:5173'] as const;

/** The tests below that do not care about the method use POST, the strictest case. */
function checkOrigin(
  headers: Headers,
  allowedOrigins: readonly string[],
  method = 'POST',
): boolean {
  return checkOriginForMethod(headers, allowedOrigins, method);
}

function headersOf(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('checkOrigin', () => {
  describe('Origin header', () => {
    it('accepts an exact match', () => {
      expect(checkOrigin(headersOf({ origin: 'https://hypergeist.example' }), ALLOWED)).toBe(true);
      expect(checkOrigin(headersOf({ origin: 'http://localhost:5173' }), ALLOWED)).toBe(true);
    });

    it('rejects an origin that is not listed', () => {
      expect(checkOrigin(headersOf({ origin: 'https://other.example' }), ALLOWED)).toBe(false);
    });

    it('rejects a missing Origin', () => {
      expect(checkOrigin(new Headers(), ALLOWED)).toBe(false);
    });

    it('rejects an empty Origin', () => {
      expect(checkOrigin(headersOf({ origin: '' }), ALLOWED)).toBe(false);
      expect(checkOrigin(headersOf({ origin: '' }), [''])).toBe(false);
    });

    it('rejects the string "null"', () => {
      expect(checkOrigin(headersOf({ origin: 'null' }), ALLOWED)).toBe(false);
    });

    it('rejects an origin that only starts with an allowed one', () => {
      expect(
        checkOrigin(headersOf({ origin: 'https://hypergeist.example.evil.com' }), ALLOWED),
      ).toBe(false);
      expect(
        checkOrigin(headersOf({ origin: 'https://a.example.evil.com' }), ['https://a.example']),
      ).toBe(false);
    });

    it('rejects an origin that only ends with an allowed host', () => {
      expect(checkOrigin(headersOf({ origin: 'https://evil.hypergeist.example' }), ALLOWED)).toBe(
        false,
      );
    });

    it('rejects an allowed origin with a different port', () => {
      expect(checkOrigin(headersOf({ origin: 'http://localhost:8787' }), ALLOWED)).toBe(false);
      expect(checkOrigin(headersOf({ origin: 'https://hypergeist.example:8443' }), ALLOWED)).toBe(
        false,
      );
    });

    it('rejects a different scheme', () => {
      expect(checkOrigin(headersOf({ origin: 'http://hypergeist.example' }), ALLOWED)).toBe(false);
    });

    it('is case-sensitive as sent', () => {
      expect(checkOrigin(headersOf({ origin: 'https://Hypergeist.example' }), ALLOWED)).toBe(false);
      expect(checkOrigin(headersOf({ origin: 'HTTPS://hypergeist.example' }), ALLOWED)).toBe(false);
    });

    it('does not trim the request Origin', () => {
      expect(checkOrigin(headersOf({ origin: 'https://hypergeist.example/' }), ALLOWED)).toBe(
        false,
      );
    });

    it('does not trim whitespace from config entries', () => {
      expect(
        checkOrigin(headersOf({ origin: 'https://hypergeist.example' }), [
          ' https://hypergeist.example',
        ]),
      ).toBe(false);
    });
  });

  describe('allowed list', () => {
    it('trims one trailing slash from a config entry', () => {
      expect(
        checkOrigin(headersOf({ origin: 'https://hypergeist.example' }), [
          'https://hypergeist.example/',
        ]),
      ).toBe(true);
    });

    it('trims only one trailing slash', () => {
      expect(
        checkOrigin(headersOf({ origin: 'https://hypergeist.example' }), [
          'https://hypergeist.example//',
        ]),
      ).toBe(false);
      expect(
        checkOrigin(headersOf({ origin: 'https://hypergeist.example/' }), [
          'https://hypergeist.example//',
        ]),
      ).toBe(true);
    });

    it('fails on an empty list', () => {
      expect(checkOrigin(headersOf({ origin: 'https://hypergeist.example' }), [])).toBe(false);
    });

    it('matches any entry of several', () => {
      expect(
        checkOrigin(headersOf({ origin: 'http://localhost:5173' }), [
          'https://one.example',
          'http://localhost:5173/',
        ]),
      ).toBe(true);
    });
  });

  describe('Sec-Fetch-Site', () => {
    const origin = 'https://hypergeist.example';

    it('accepts same-origin', () => {
      expect(checkOrigin(headersOf({ origin, 'sec-fetch-site': 'same-origin' }), ALLOWED)).toBe(
        true,
      );
    });

    it.each(['same-site', 'cross-site', 'none', '', 'Same-Origin'])(
      'rejects %j even when Origin matches',
      (value) => {
        expect(checkOrigin(headersOf({ origin, 'sec-fetch-site': value }), ALLOWED)).toBe(false);
      },
    );

    it('is not required when absent', () => {
      expect(checkOrigin(headersOf({ origin }), ALLOWED)).toBe(true);
    });

    it('does not make a missing Origin pass for POST', () => {
      expect(checkOrigin(headersOf({ 'sec-fetch-site': 'same-origin' }), ALLOWED)).toBe(false);
    });
  });

  describe('no Origin header (same-origin GET and HEAD)', () => {
    const sameOrigin = { 'sec-fetch-site': 'same-origin' };

    it.each(['GET', 'HEAD', 'get', 'Head'])('accepts %s with Sec-Fetch-Site: same-origin', (m) => {
      expect(checkOrigin(headersOf(sameOrigin), ALLOWED, m)).toBe(true);
    });

    it('treats an empty Origin like a missing one', () => {
      expect(checkOrigin(headersOf({ origin: '', ...sameOrigin }), ALLOWED, 'GET')).toBe(true);
      expect(checkOrigin(headersOf({ origin: '', ...sameOrigin }), ALLOWED, 'POST')).toBe(false);
    });

    it('rejects GET and HEAD without Sec-Fetch-Site', () => {
      expect(checkOrigin(new Headers(), ALLOWED, 'GET')).toBe(false);
      expect(checkOrigin(new Headers(), ALLOWED, 'HEAD')).toBe(false);
    });

    it.each(['same-site', 'cross-site', 'none', '', 'Same-Origin'])(
      'rejects GET with Sec-Fetch-Site %j',
      (value) => {
        expect(checkOrigin(headersOf({ 'sec-fetch-site': value }), ALLOWED, 'GET')).toBe(false);
      },
    );

    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '', 'GETX'])(
      'rejects %j even with Sec-Fetch-Site: same-origin',
      (m) => {
        expect(checkOrigin(headersOf(sameOrigin), ALLOWED, m)).toBe(false);
      },
    );

    it('still rejects a wrong Origin on GET', () => {
      expect(
        checkOrigin(headersOf({ origin: 'https://evil.example', ...sameOrigin }), ALLOWED, 'GET'),
      ).toBe(false);
    });

    it('still rejects a cross-site GET that carries a matching Origin', () => {
      expect(
        checkOrigin(
          headersOf({ origin: 'https://hypergeist.example', 'sec-fetch-site': 'cross-site' }),
          ALLOWED,
          'GET',
        ),
      ).toBe(false);
    });

    it('accepts a GET with a matching Origin', () => {
      expect(checkOrigin(headersOf({ origin: 'https://hypergeist.example' }), ALLOWED, 'GET')).toBe(
        true,
      );
    });

    it('never matches with an empty allowed list', () => {
      expect(checkOrigin(headersOf(sameOrigin), [], 'GET')).toBe(false);
      expect(checkOrigin(headersOf(sameOrigin), [], 'HEAD')).toBe(false);
    });
  });

  it('does not mutate the allowed list', () => {
    const list = ['https://hypergeist.example/'];
    const copy = [...list];
    checkOrigin(headersOf({ origin: 'https://hypergeist.example' }), list);
    expect(list).toEqual(copy);
  });
});
