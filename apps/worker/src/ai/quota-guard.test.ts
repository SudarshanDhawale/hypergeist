import { describe, expect, it } from 'vitest';
import { guardedAddTokens, guardedReserve, guardedSnapshot } from './quota-guard';
import { createMemoryKv, type Limits } from './quota-logic';

const DATE = '2026-11-15';
const LIMITS: Limits = {
  visitorDaily: 2,
  daily: 5,
  dailyTokens: 1000,
  lifetime: 10,
  lifetimeTokens: 5000,
};
const VALID = { visitorKey: 'abc123', date: DATE, limits: LIMITS };
const ZERO_SNAPSHOT = { dailyLimit: 0, dailyUsed: 0, visitorLimit: 0, visitorUsed: 0 };

function keyCount(kv: ReturnType<typeof createMemoryKv>): number {
  return [...kv.list({ prefix: '' })].length;
}

describe('guardedReserve', () => {
  it('runs the logic for valid input', () => {
    const kv = createMemoryKv();
    expect(guardedReserve(kv, VALID)).toEqual({ ok: true });
    expect(guardedReserve(kv, VALID)).toEqual({ ok: true });
    expect(guardedReserve(kv, VALID)).toEqual({ ok: false, reason: 'visitor' });
  });

  it('accepts `overflow`, 1 and 64 character keys and `maxVisitorRows`', () => {
    const kv = createMemoryKv();
    for (const visitorKey of ['overflow', 'a', 'A_-9'.repeat(16), 'unknown']) {
      expect(guardedReserve(kv, { ...VALID, visitorKey })).toEqual({ ok: true });
    }
    const limits = { ...LIMITS, maxVisitorRows: 0 };
    expect(guardedReserve(kv, { ...VALID, limits })).toEqual({ ok: true });
  });

  const garbage: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['empty object', {}],
    ['empty visitor key', { ...VALID, visitorKey: '' }],
    ['65 character visitor key', { ...VALID, visitorKey: 'a'.repeat(65) }],
    ['visitor key with a colon', { ...VALID, visitorKey: 'a:b' }],
    ['visitor key with a space', { ...VALID, visitorKey: 'a b' }],
    ['non-string visitor key', { ...VALID, visitorKey: 7 }],
    ['date with a time', { ...VALID, date: '2026-11-15T00:00' }],
    ['date without zeros', { ...VALID, date: '2026-1-5' }],
    ['impossible date', { ...VALID, date: '2026-02-31' }],
    ['month 13', { ...VALID, date: '2026-13-01' }],
    ['non-string date', { ...VALID, date: 20261115 }],
    ['missing limits', { visitorKey: 'a', date: DATE }],
    ['limits null', { ...VALID, limits: null }],
    ['limits with a missing field', { ...VALID, limits: { ...LIMITS, daily: undefined } }],
    ['negative limit', { ...VALID, limits: { ...LIMITS, daily: -1 } }],
    ['fractional limit', { ...VALID, limits: { ...LIMITS, daily: 1.5 } }],
    ['NaN limit', { ...VALID, limits: { ...LIMITS, daily: Number.NaN } }],
    ['Infinity limit', { ...VALID, limits: { ...LIMITS, lifetime: Infinity } }],
    ['string limit', { ...VALID, limits: { ...LIMITS, dailyTokens: '10' } }],
    ['unsafe integer limit', { ...VALID, limits: { ...LIMITS, lifetime: 2 ** 60 } }],
    ['bad maxVisitorRows', { ...VALID, limits: { ...LIMITS, maxVisitorRows: -1 } }],
  ];

  it.each(garbage)('denies without throwing and without writing: %s', (_name, input) => {
    const kv = createMemoryKv();
    expect(guardedReserve(kv, input)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(keyCount(kv)).toBe(0);
  });

  it('ignores unknown extra fields', () => {
    const kv = createMemoryKv();
    expect(guardedReserve(kv, { ...VALID, extra: 1, limits: { ...LIMITS, extra: 1 } })).toEqual({
      ok: true,
    });
  });
});

describe('guardedAddTokens', () => {
  it('adds tokens for valid input, visible to the next reserve', () => {
    const kv = createMemoryKv();
    guardedAddTokens(kv, { visitorKey: 'abc', date: DATE, tokens: 1000 });
    expect(guardedReserve(kv, VALID)).toEqual({ ok: false, reason: 'daily-tokens' });
  });

  const garbage: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['bad key', { visitorKey: 'a b', date: DATE, tokens: 1 }],
    ['bad date', { visitorKey: 'a', date: '2026-02-30', tokens: 1 }],
    ['negative tokens', { visitorKey: 'a', date: DATE, tokens: -1 }],
    ['fractional tokens', { visitorKey: 'a', date: DATE, tokens: 1.5 }],
    ['NaN tokens', { visitorKey: 'a', date: DATE, tokens: Number.NaN }],
    ['Infinity tokens', { visitorKey: 'a', date: DATE, tokens: Infinity }],
    ['string tokens', { visitorKey: 'a', date: DATE, tokens: '5' }],
  ];

  it.each(garbage)('does nothing and does not throw: %s', (_name, input) => {
    const kv = createMemoryKv();
    expect(() => guardedAddTokens(kv, input)).not.toThrow();
    expect(keyCount(kv)).toBe(0);
  });

  it('accepts zero tokens', () => {
    const kv = createMemoryKv();
    expect(() => guardedAddTokens(kv, { visitorKey: 'a', date: DATE, tokens: 0 })).not.toThrow();
  });
});

describe('guardedSnapshot', () => {
  it('reports the counters for valid input', () => {
    const kv = createMemoryKv();
    guardedReserve(kv, VALID);
    expect(guardedSnapshot(kv, VALID)).toEqual({
      dailyLimit: 5,
      dailyUsed: 1,
      visitorLimit: 2,
      visitorUsed: 1,
    });
  });

  it.each([undefined, null, 5, {}, { ...VALID, date: 'x' }, { ...VALID, visitorKey: '' }])(
    'returns zeros for garbage without throwing: %j',
    (input) => {
      const kv = createMemoryKv();
      expect(guardedSnapshot(kv, input)).toEqual(ZERO_SNAPSHOT);
      expect(keyCount(kv)).toBe(0);
    },
  );
});
