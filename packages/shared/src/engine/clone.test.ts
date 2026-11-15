import { describe, expect, it } from 'vitest';

import { deepCopyJson } from './clone.ts';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

describe('deepCopyJson', () => {
  it('copies nested data into an equal value that shares no reference', () => {
    const input = {
      a: { b: [1, { c: 'x' }, [true, null]] },
      list: [{ id: 'one' }, { id: 'two' }],
    };
    const copy = deepCopyJson(input);

    expect(copy).toEqual(input);
    expect(copy).not.toBe(input);
    expect(copy.a).not.toBe(input.a);
    expect(copy.a.b).not.toBe(input.a.b);
    expect(copy.a.b[1]).not.toBe(input.a.b[1]);
    expect(copy.a.b[2]).not.toBe(input.a.b[2]);
    expect(copy.list).not.toBe(input.list);
    expect(copy.list[0]).not.toBe(input.list[0]);
  });

  it('does not change the copy when the input is changed afterwards', () => {
    const input = { nested: { value: 1 }, items: [1, 2] };
    const copy = deepCopyJson(input);
    input.nested.value = 2;
    input.items.push(3);

    expect(copy).toEqual({ nested: { value: 1 }, items: [1, 2] });
  });

  it('keeps key order', () => {
    const input = { z: 1, a: { y: 2, b: 3 }, m: 4 };
    const copy = deepCopyJson(input);

    expect(Object.keys(copy)).toEqual(['z', 'a', 'm']);
    expect(Object.keys(copy.a)).toEqual(['y', 'b']);
  });

  it('returns strings, numbers, booleans and null as they are', () => {
    const long = 'x'.repeat(1_000_000);
    expect(deepCopyJson(long)).toBe(long);
    expect(deepCopyJson(0)).toBe(0);
    expect(deepCopyJson(-1.5)).toBe(-1.5);
    expect(deepCopyJson(true)).toBe(true);
    expect(deepCopyJson(null)).toBeNull();
  });

  it('copies empty arrays and objects', () => {
    const input = { list: [], map: {} };
    const copy = deepCopyJson(input);

    expect(copy).toEqual(input);
    expect(copy.list).not.toBe(input.list);
    expect(copy.map).not.toBe(input.map);
  });

  it('gives an unfrozen copy of a deeply frozen input', () => {
    const input = deepFreeze({ a: { b: [1, { c: 2 }] } });
    const copy = deepCopyJson(input);

    expect(copy).toEqual(input);
    expect(Object.isFrozen(copy)).toBe(false);
    expect(Object.isFrozen(copy.a)).toBe(false);
    expect(Object.isFrozen(copy.a.b)).toBe(false);
    expect(Object.isFrozen(copy.a.b[1])).toBe(false);
    expect(() => {
      copy.a.b.push(3);
    }).not.toThrow();
  });

  it('keeps an own "__proto__" key as data and does not change the prototype', () => {
    const input: unknown = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
    const copy = deepCopyJson(input) as Record<string, unknown>;

    expect(Object.keys(copy)).toEqual(['__proto__', 'ok']);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(copy, '__proto__')?.value).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('survives a JSON round trip unchanged', () => {
    const input = { a: [1, 'two', { three: null }], b: false };
    expect(JSON.parse(JSON.stringify(deepCopyJson(input)))).toEqual(input);
  });
});
