import { ENTITY_ID_PATTERN } from '@hypergeist/shared/format';
import { describe, expect, it } from 'vitest';
import { suggestFreeId } from './free-id.ts';

describe('suggestFreeId', () => {
  it('appends -copy when it is free', () => {
    expect(suggestFreeId('todo', new Set())).toBe('todo-copy');
    expect(suggestFreeId('todo', new Set(['todo', 'other']))).toBe('todo-copy');
  });

  it('gives -copy-2 when -copy is taken', () => {
    expect(suggestFreeId('todo', new Set(['todo', 'todo-copy']))).toBe('todo-copy-2');
  });

  it('gives -copy-3 when -copy and -copy-2 are taken', () => {
    expect(suggestFreeId('todo', new Set(['todo-copy', 'todo-copy-2']))).toBe('todo-copy-3');
  });

  it('skips only taken numbers and takes the first free one', () => {
    expect(suggestFreeId('todo', new Set(['todo-copy', 'todo-copy-3']))).toBe('todo-copy-2');
  });

  it('cuts a 64-character base so the result is 64 characters', () => {
    const base = 'a'.repeat(64);
    const first = suggestFreeId(base, new Set([base]));
    expect(first).toBe(`${'a'.repeat(59)}-copy`);
    expect(first).toHaveLength(64);
    expect(ENTITY_ID_PATTERN.test(first)).toBe(true);

    const second = suggestFreeId(base, new Set([base, first]));
    expect(second).toBe(`${'a'.repeat(57)}-copy-2`);
    expect(second).toHaveLength(64);
    expect(ENTITY_ID_PATTERN.test(second)).toBe(true);
  });

  it('keeps ids within 64 characters when the counter gains digits', () => {
    const base = 'b'.repeat(64);
    const taken = new Set<string>([base]);
    for (let n = 1; n <= 100; n += 1) {
      const id = suggestFreeId(base, taken);
      expect(id.length).toBeLessThanOrEqual(64);
      expect(ENTITY_ID_PATTERN.test(id)).toBe(true);
      taken.add(id);
    }
    expect(taken.size).toBe(101);
    expect(suggestFreeId(base, taken).endsWith('-copy-101')).toBe(true);
  });

  it('allows a trailing - or _ left by the cut', () => {
    const base = `${'c'.repeat(58)}-_`; // 60 characters; the cut for "-copy" keeps 59
    const id = suggestFreeId(base, new Set());
    expect(id).toBe(`${'c'.repeat(58)}--copy`);
    expect(ENTITY_ID_PATTERN.test(id)).toBe(true);

    const long = `${'d'.repeat(58)}_-xx`;
    const cut = suggestFreeId(long, new Set());
    expect(cut).toBe(`${'d'.repeat(58)}_-copy`);
    expect(ENTITY_ID_PATTERN.test(cut)).toBe(true);
  });

  it('treats a base that already ends in -copy like any other base', () => {
    expect(suggestFreeId('todo-copy', new Set(['todo-copy']))).toBe('todo-copy-copy');
    expect(suggestFreeId('todo-copy', new Set(['todo-copy-copy']))).toBe('todo-copy-copy-2');
  });

  it('accepts taken as an array and as a set with the same result', () => {
    const list = ['todo', 'todo-copy', 'todo-copy-2'];
    expect(suggestFreeId('todo', list)).toBe('todo-copy-3');
    expect(suggestFreeId('todo', new Set(list))).toBe('todo-copy-3');
    expect(suggestFreeId('todo', [])).toBe('todo-copy');
  });

  it('does not change its input', () => {
    const list: readonly string[] = Object.freeze(['todo-copy']);
    const set = new Set(['todo-copy']);
    suggestFreeId('todo', list);
    suggestFreeId('todo', set);
    expect([...list]).toEqual(['todo-copy']);
    expect([...set]).toEqual(['todo-copy']);
  });

  it('is deterministic', () => {
    const taken = new Set(['x-copy', 'x-copy-2']);
    expect(suggestFreeId('x', taken)).toBe(suggestFreeId('x', taken));
  });

  it('handles several thousand taken ids', () => {
    const taken = new Set<string>(['doc', 'doc-copy']);
    for (let n = 2; n <= 5000; n += 1) {
      taken.add(`doc-copy-${n}`);
    }
    for (let n = 0; n < 5000; n += 1) {
      taken.add(`unrelated-${n}`);
    }
    const started = performance.now();
    const id = suggestFreeId('doc', taken);
    expect(id).toBe('doc-copy-5001');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('falls back to a valid id when the base is not a valid id', () => {
    for (const bad of ['', '-x', 'UPPER', 'a b', 'é']) {
      const id = suggestFreeId(bad, new Set());
      expect(ENTITY_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it('always returns an id that matches the pattern and is not taken', () => {
    const bases = ['a', '0', 'a-b_c', 'x'.repeat(63), 'y'.repeat(64), 'z-copy', 'q_'.repeat(32)];
    for (const base of bases) {
      const taken = new Set<string>([base]);
      for (let i = 0; i < 15; i += 1) {
        const id = suggestFreeId(base, taken);
        expect(ENTITY_ID_PATTERN.test(id)).toBe(true);
        expect(taken.has(id)).toBe(false);
        taken.add(id);
      }
    }
  });
});
