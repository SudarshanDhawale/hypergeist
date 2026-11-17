import { describe, expect, it } from 'vitest';
import {
  addTokens,
  createMemoryKv,
  reserve,
  snapshot,
  type KvLike,
  type Limits,
} from './quota-logic';

const DAY1 = '2026-11-15';
const DAY2 = '2026-11-16';

const BIG: Limits = {
  visitorDaily: 1000,
  daily: 1000,
  dailyTokens: 1_000_000,
  lifetime: 1000,
  lifetimeTokens: 1_000_000,
};

function limits(overrides: Partial<Limits> = {}): Limits {
  return { ...BIG, ...overrides };
}

function allKeys(kv: KvLike): string[] {
  return [...kv.list({ prefix: '' })].map(([key]) => key);
}

function reserveN(kv: KvLike, n: number, visitorKey: string, date: string, l: Limits): void {
  for (let i = 0; i < n; i += 1) {
    expect(reserve(kv, { visitorKey, date, limits: l })).toEqual({ ok: true });
  }
}

// Compile-time check: a real `ctx.storage.kv` can be passed where a `KvLike` is expected.
const _durableObjectKvIsAssignable = (kv: SyncKvStorage): KvLike => kv;
void _durableObjectKvIsAssignable;

describe('createMemoryKv', () => {
  it('stores, reads, deletes and lists by prefix in sorted order', () => {
    const kv = createMemoryKv();
    kv.put('b:2', 2);
    kv.put('a:1', 1);
    kv.put('b:1', 1);

    expect(kv.get<number>('a:1')).toBe(1);
    expect(kv.get<number>('missing')).toBeUndefined();
    expect([...kv.list({ prefix: 'b:' })]).toEqual([
      ['b:1', 1],
      ['b:2', 2],
    ]);
    expect(kv.delete('a:1')).toBe(true);
    expect(kv.delete('a:1')).toBe(false);
    expect(kv.get<number>('a:1')).toBeUndefined();
  });
});

describe('reserve: each check at its boundary', () => {
  it('lifetime: the cap minus one allows, the cap denies', () => {
    const kv = createMemoryKv();
    const l = limits({ lifetime: 3 });
    reserveN(kv, 3, 'a', DAY1, l);

    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({
      ok: false,
      reason: 'lifetime',
    });
  });

  it('lifetime-tokens: allows below the cap, denies at the cap', () => {
    const kv = createMemoryKv();
    const l = limits({ lifetimeTokens: 100 });
    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 99 });
    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({ ok: true });

    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 1 });
    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({
      ok: false,
      reason: 'lifetime-tokens',
    });
  });

  it('daily: the cap minus one allows, the cap denies', () => {
    const kv = createMemoryKv();
    const l = limits({ daily: 4 });
    reserveN(kv, 2, 'a', DAY1, l);
    reserveN(kv, 2, 'b', DAY1, l);

    expect(reserve(kv, { visitorKey: 'c', date: DAY1, limits: l })).toEqual({
      ok: false,
      reason: 'daily',
    });
  });

  it('daily-tokens: allows below the cap, denies at the cap', () => {
    const kv = createMemoryKv();
    const l = limits({ dailyTokens: 50 });
    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 49 });
    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({ ok: true });

    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 1 });
    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({
      ok: false,
      reason: 'daily-tokens',
    });
  });

  it('visitor: the cap minus one allows, the cap denies', () => {
    const kv = createMemoryKv();
    const l = limits({ visitorDaily: 3 });
    reserveN(kv, 3, 'a', DAY1, l);

    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({
      ok: false,
      reason: 'visitor',
    });
  });

  it('a cap of 0 denies the first request', () => {
    const kv = createMemoryKv();

    expect(
      reserve(kv, { visitorKey: 'a', date: DAY1, limits: limits({ visitorDaily: 0 }) }),
    ).toEqual({
      ok: false,
      reason: 'visitor',
    });
  });

  it('does not count a denied request', () => {
    const kv = createMemoryKv();
    const l = limits({ visitorDaily: 1 });
    reserveN(kv, 1, 'a', DAY1, l);
    reserve(kv, { visitorKey: 'a', date: DAY1, limits: l });
    reserve(kv, { visitorKey: 'a', date: DAY1, limits: l });

    expect(kv.get<number>('l:req')).toBe(1);
    expect(kv.get<number>(`g:${DAY1}:req`)).toBe(1);
    expect(kv.get<number>(`v:${DAY1}:a`)).toBe(1);
  });
});

describe('reserve: order of the checks', () => {
  function everythingExhausted(): { kv: KvLike; l: Limits } {
    const kv = createMemoryKv();
    const l = limits({
      visitorDaily: 1,
      daily: 1,
      dailyTokens: 1,
      lifetime: 1,
      lifetimeTokens: 1,
    });
    reserveN(kv, 1, 'a', DAY1, limits({ ...l, lifetime: 10, daily: 10, visitorDaily: 10 }));
    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 5 });
    return { kv, l };
  }

  it('reports lifetime first when every check would fail', () => {
    const { kv, l } = everythingExhausted();

    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({
      ok: false,
      reason: 'lifetime',
    });
  });

  it('reports lifetime-tokens second', () => {
    const { kv, l } = everythingExhausted();

    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: { ...l, lifetime: 10 } })).toEqual({
      ok: false,
      reason: 'lifetime-tokens',
    });
  });

  it('reports daily third', () => {
    const { kv, l } = everythingExhausted();
    const next = { ...l, lifetime: 10, lifetimeTokens: 100 };

    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: next })).toEqual({
      ok: false,
      reason: 'daily',
    });
  });

  it('reports daily-tokens fourth', () => {
    const { kv, l } = everythingExhausted();
    const next = { ...l, lifetime: 10, lifetimeTokens: 100, daily: 10 };

    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: next })).toEqual({
      ok: false,
      reason: 'daily-tokens',
    });
  });

  it('reports visitor last', () => {
    const { kv, l } = everythingExhausted();
    const next = { ...l, lifetime: 10, lifetimeTokens: 100, daily: 10, dailyTokens: 100 };

    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: next })).toEqual({
      ok: false,
      reason: 'visitor',
    });
  });
});

describe('reserve: visitors', () => {
  it('counts visitors independently', () => {
    const kv = createMemoryKv();
    const l = limits({ visitorDaily: 2 });
    reserveN(kv, 2, 'a', DAY1, l);

    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({
      ok: false,
      reason: 'visitor',
    });
    expect(reserve(kv, { visitorKey: 'b', date: DAY1, limits: l })).toEqual({ ok: true });
    expect(kv.get<number>(`v:${DAY1}:a`)).toBe(2);
    expect(kv.get<number>(`v:${DAY1}:b`)).toBe(1);
    expect(kv.get<number>(`vn:${DAY1}`)).toBe(2);
  });

  it('maps new visitors beyond maxVisitorRows to the shared key overflow', () => {
    const kv = createMemoryKv();
    const l = limits({ maxVisitorRows: 2, visitorDaily: 2 });
    reserveN(kv, 1, 'a', DAY1, l);
    reserveN(kv, 1, 'b', DAY1, l);

    reserveN(kv, 1, 'c', DAY1, l);
    reserveN(kv, 1, 'd', DAY1, l);

    expect(kv.get<number>(`v:${DAY1}:c`)).toBeUndefined();
    expect(kv.get<number>(`v:${DAY1}:d`)).toBeUndefined();
    expect(kv.get<number>(`v:${DAY1}:overflow`)).toBe(2);
    // The shared row is full for every visitor that is mapped to it.
    expect(reserve(kv, { visitorKey: 'e', date: DAY1, limits: l })).toEqual({
      ok: false,
      reason: 'visitor',
    });
    // Visitors that already have a row keep using it.
    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({ ok: true });
    expect(kv.get<number>(`vn:${DAY1}`)).toBe(2);
  });

  it('defaults maxVisitorRows to 5000', () => {
    const kv = createMemoryKv();
    const l = limits({ visitorDaily: 10, daily: 100_000, lifetime: 100_000 });
    for (let i = 0; i < 5000; i += 1) reserveN(kv, 1, `v${i}`, DAY1, l);
    expect(kv.get<number>(`vn:${DAY1}`)).toBe(5000);

    reserveN(kv, 1, 'one-more', DAY1, l);

    expect(kv.get<number>(`v:${DAY1}:one-more`)).toBeUndefined();
    expect(kv.get<number>(`v:${DAY1}:overflow`)).toBe(1);
    expect(kv.get<number>(`vn:${DAY1}`)).toBe(5000);
  });
});

describe('reserve: key layout and date change', () => {
  it('writes the documented keys as plain numbers', () => {
    const kv = createMemoryKv();
    reserveN(kv, 2, 'a', DAY1, BIG);
    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 40 });

    expect(Object.fromEntries(kv.list({ prefix: '' }))).toEqual({
      'meta:date': DAY1,
      [`g:${DAY1}:req`]: 2,
      [`g:${DAY1}:tok`]: 40,
      [`v:${DAY1}:a`]: 2,
      [`vn:${DAY1}`]: 1,
      'l:req': 2,
      'l:tok': 40,
    });
  });

  it('a new date resets daily and visitor counters but not lifetime counters', () => {
    const kv = createMemoryKv();
    const l = limits({ visitorDaily: 2, daily: 2, dailyTokens: 10 });
    reserveN(kv, 2, 'a', DAY1, l);
    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 10 });
    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l }).ok).toBe(false);

    expect(reserve(kv, { visitorKey: 'a', date: DAY2, limits: l })).toEqual({ ok: true });

    expect(kv.get<string>('meta:date')).toBe(DAY2);
    expect(kv.get<number>(`g:${DAY2}:req`)).toBe(1);
    expect(kv.get<number>(`g:${DAY2}:tok`)).toBeUndefined();
    expect(kv.get<number>(`v:${DAY2}:a`)).toBe(1);
    expect(kv.get<number>('l:req')).toBe(3);
    expect(kv.get<number>('l:tok')).toBe(10);
    expect(allKeys(kv).filter((key) => key.includes(DAY1))).toEqual([]);
  });

  it('keeps counting the lifetime cap across dates', () => {
    const kv = createMemoryKv();
    const l = limits({ lifetime: 3 });
    reserveN(kv, 2, 'a', DAY1, l);
    reserveN(kv, 1, 'a', DAY2, l);

    expect(reserve(kv, { visitorKey: 'a', date: DAY2, limits: l })).toEqual({
      ok: false,
      reason: 'lifetime',
    });
  });

  it('100 days of reserves leave only the current day keys', () => {
    const kv = createMemoryKv();
    let lastDate = DAY1;
    for (let day = 0; day < 100; day += 1) {
      lastDate = new Date(Date.UTC(2026, 10, 15 + day)).toISOString().slice(0, 10);
      reserveN(kv, 1, 'a', lastDate, BIG);
      reserveN(kv, 1, 'b', lastDate, BIG);
      addTokens(kv, { visitorKey: 'a', date: lastDate, tokens: 10 });
    }

    expect(allKeys(kv)).toEqual(
      [
        'meta:date',
        `g:${lastDate}:req`,
        `g:${lastDate}:tok`,
        `v:${lastDate}:a`,
        `v:${lastDate}:b`,
        `vn:${lastDate}`,
        'l:req',
        'l:tok',
      ].sort(),
    );
    expect(kv.get<number>('l:req')).toBe(200);
    expect(kv.get<number>('l:tok')).toBe(1000);
  });

  it('removes stale rows of a visitor whose key looks like a date prefix', () => {
    const kv = createMemoryKv();
    reserveN(kv, 1, 'x:y', DAY1, BIG);

    reserveN(kv, 1, 'x:y', DAY2, BIG);

    expect(allKeys(kv).some((key) => key.includes(DAY1))).toBe(false);
    expect(kv.get<number>(`v:${DAY2}:x:y`)).toBe(1);
  });
});

describe('addTokens', () => {
  it('adds to the daily and lifetime counters', () => {
    const kv = createMemoryKv();
    reserveN(kv, 1, 'a', DAY1, BIG);

    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 120 });
    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 30 });

    expect(kv.get<number>(`g:${DAY1}:tok`)).toBe(150);
    expect(kv.get<number>('l:tok')).toBe(150);
  });

  it('floors fractions', () => {
    const kv = createMemoryKv();

    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 10.9 });

    expect(kv.get<number>('l:tok')).toBe(10);
  });

  it.each([
    ['negative', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['fraction below one', 0.9],
  ])('treats %s as 0', (_name, tokens) => {
    const kv = createMemoryKv();
    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 7 });

    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens });

    expect(kv.get<number>(`g:${DAY1}:tok`)).toBe(7);
    expect(kv.get<number>('l:tok')).toBe(7);
  });

  it('overshoot: tokens past the cap are accepted, and only the next reserve is denied', () => {
    const kv = createMemoryKv();
    const l = limits({ dailyTokens: 100 });
    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({ ok: true });

    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 5000 });

    expect(kv.get<number>(`g:${DAY1}:tok`)).toBe(5000);
    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({
      ok: false,
      reason: 'daily-tokens',
    });
  });

  it('on a new date, counts tokens toward the new day and drops the old day keys', () => {
    const kv = createMemoryKv();
    reserveN(kv, 1, 'a', DAY1, BIG);

    addTokens(kv, { visitorKey: 'a', date: DAY2, tokens: 9 });

    expect(kv.get<string>('meta:date')).toBe(DAY2);
    expect(kv.get<number>(`g:${DAY2}:tok`)).toBe(9);
    expect(allKeys(kv).some((key) => key.includes(DAY1))).toBe(false);
  });

  it('repairs a corrupt counter instead of producing NaN or a negative value', () => {
    const kv = createMemoryKv();
    kv.put('l:tok', -50);
    kv.put(`g:${DAY1}:tok`, 'oops');
    kv.put('meta:date', DAY1);

    addTokens(kv, { visitorKey: 'a', date: DAY1, tokens: 4 });

    expect(kv.get<number>('l:tok')).toBe(4);
    expect(kv.get<number>(`g:${DAY1}:tok`)).toBe(4);
  });
});

describe('counters are never negative', () => {
  it('a negative stored request counter reads as 0 and is incremented from 0', () => {
    const kv = createMemoryKv();
    kv.put('l:req', -10);

    expect(reserve(kv, { visitorKey: 'a', date: DAY1, limits: BIG })).toEqual({ ok: true });

    expect(kv.get<number>('l:req')).toBe(1);
  });
});

describe('snapshot', () => {
  it('reports the request numbers of the visitor and of the day', () => {
    const kv = createMemoryKv();
    const l = limits({ visitorDaily: 5, daily: 20 });
    reserveN(kv, 2, 'a', DAY1, l);
    reserveN(kv, 3, 'b', DAY1, l);

    expect(snapshot(kv, { visitorKey: 'a', date: DAY1, limits: l })).toEqual({
      dailyLimit: 20,
      dailyUsed: 5,
      visitorLimit: 5,
      visitorUsed: 2,
    });
  });

  it('shows zero used for a visitor with no row', () => {
    const kv = createMemoryKv();
    reserveN(kv, 1, 'a', DAY1, BIG);

    expect(snapshot(kv, { visitorKey: 'new', date: DAY1, limits: BIG }).visitorUsed).toBe(0);
  });

  it('shows zero used on a new day and changes nothing', () => {
    const kv = createMemoryKv();
    const l = limits({ visitorDaily: 5, daily: 20 });
    reserveN(kv, 2, 'a', DAY1, l);
    const before = [...kv.list({ prefix: '' })];

    const result = snapshot(kv, { visitorKey: 'a', date: DAY2, limits: l });

    expect(result).toEqual({ dailyLimit: 20, dailyUsed: 0, visitorLimit: 5, visitorUsed: 0 });
    expect([...kv.list({ prefix: '' })]).toEqual(before);
  });

  it('has no side effects on an empty store', () => {
    const kv = createMemoryKv();

    expect(snapshot(kv, { visitorKey: 'a', date: DAY1, limits: BIG })).toEqual({
      dailyLimit: 1000,
      dailyUsed: 0,
      visitorLimit: 1000,
      visitorUsed: 0,
    });
    expect(allKeys(kv)).toEqual([]);
  });

  it('never calls put or delete', () => {
    const inner = createMemoryKv();
    reserveN(inner, 1, 'a', DAY1, BIG);
    const writes: string[] = [];
    const watched: KvLike = {
      get: (key) => inner.get(key),
      list: (options) => inner.list(options),
      put: (key, value) => {
        writes.push(`put ${key}`);
        inner.put(key, value);
      },
      delete: (key) => {
        writes.push(`delete ${key}`);
        return inner.delete(key);
      },
    };

    snapshot(watched, { visitorKey: 'a', date: DAY1, limits: BIG });
    snapshot(watched, { visitorKey: 'a', date: DAY2, limits: BIG });

    expect(writes).toEqual([]);
  });

  it('reports the overflow row for a visitor that would be mapped to it', () => {
    const kv = createMemoryKv();
    const l = limits({ maxVisitorRows: 1, visitorDaily: 5 });
    reserveN(kv, 1, 'a', DAY1, l);
    reserveN(kv, 2, 'b', DAY1, l);

    expect(snapshot(kv, { visitorKey: 'b', date: DAY1, limits: l }).visitorUsed).toBe(2);
    expect(snapshot(kv, { visitorKey: 'a', date: DAY1, limits: l }).visitorUsed).toBe(1);
  });
});
