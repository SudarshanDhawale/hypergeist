import { describe, expect, it } from 'vitest';
import { deepCopy, deepFreeze } from './freeze.ts';

function sample() {
  return { a: 1, nested: { list: [{ x: 'y' }, [1, 2]], flag: true }, nothing: null };
}

describe('deepFreeze', () => {
  it('returns the same value, frozen at every depth', () => {
    const input = sample();
    const result = deepFreeze(input);
    expect(result).toBe(input);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.nested)).toBe(true);
    expect(Object.isFrozen(input.nested.list)).toBe(true);
    expect(Object.isFrozen(input.nested.list[0])).toBe(true);
    expect(Object.isFrozen(input.nested.list[1])).toBe(true);
  });

  it('makes a write throw in strict mode', () => {
    const input = deepFreeze(sample());
    expect(() => {
      input.a = 2;
    }).toThrow(TypeError);
    expect(() => {
      input.nested.flag = false;
    }).toThrow(TypeError);
    expect(() => {
      (input.nested.list as unknown[]).push(3);
    }).toThrow(TypeError);
  });

  it('accepts primitives and an already frozen value', () => {
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze('text')).toBe('text');
    expect(deepFreeze(null)).toBeNull();
    const frozen = Object.freeze({ a: 1 });
    expect(deepFreeze(frozen)).toBe(frozen);
  });
});

describe('deepCopy', () => {
  it('is deeply equal, shares no reference, and is not frozen', () => {
    const input = deepFreeze(sample());
    const copy = deepCopy(input);
    expect(copy).toEqual(input);
    expect(copy).not.toBe(input);
    expect(copy.nested).not.toBe(input.nested);
    expect(copy.nested.list).not.toBe(input.nested.list);
    expect(copy.nested.list[0]).not.toBe(input.nested.list[0]);
    expect(Object.isFrozen(copy)).toBe(false);
    expect(Object.isFrozen(copy.nested.list)).toBe(false);
    copy.a = 99;
    expect(input.a).toBe(1);
  });

  it('keeps key order and returns primitives as is', () => {
    expect(Object.keys(deepCopy({ b: 1, a: 2, c: 3 }))).toEqual(['b', 'a', 'c']);
    expect(deepCopy('s')).toBe('s');
    expect(deepCopy(null)).toBeNull();
  });

  it('keeps an own "__proto__" key as data', () => {
    const input = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>;
    const copy = deepCopy(input);
    expect(Object.keys(copy)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy).toEqual(input);
  });
});
