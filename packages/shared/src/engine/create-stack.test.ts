import { describe, expect, it } from 'vitest';
import { validateStack } from '../format/index.ts';
import type { ValidationError } from '../format/index.ts';
import { createStack } from './create-stack.ts';

const GOOD = { id: 'my-stack', name: 'My Stack' } as const;

function expectRejected(params: unknown): readonly ValidationError[] {
  const result = createStack(params);
  expect(result.ok).toBe(false);
  expect('stack' in result).toBe(false);
  if (result.ok) throw new Error('expected createStack to reject');
  return result.errors;
}

function codesAndPaths(errors: readonly ValidationError[]): { code: string; path: string }[] {
  return errors.map((error) => ({ code: error.code, path: error.path }));
}

describe('createStack: defaults (Requirement 11.16)', () => {
  it('gives 512 by 342, card-1 and "Card 1" for only id and name', () => {
    const result = createStack(GOOD);
    expect(result).toEqual({
      ok: true,
      stack: {
        formatVersion: 1,
        id: 'my-stack',
        name: 'My Stack',
        cardWidth: 512,
        cardHeight: 342,
        startCardId: 'card-1',
        cards: [{ id: 'card-1', name: 'Card 1', objects: [], links: [], onOpen: [] }],
      },
    });
    if (!result.ok) throw new Error('unreachable');
    expect('remixedFrom' in result.stack).toBe(false);
    expect(validateStack(result.stack).valid).toBe(true);
  });

  it('uses every supplied value', () => {
    const result = createStack({
      id: 'abc',
      name: 'Named',
      cardWidth: 640,
      cardHeight: 480,
      firstCardId: 'home',
      firstCardName: 'Home',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.stack.cardWidth).toBe(640);
    expect(result.stack.cardHeight).toBe(480);
    expect(result.stack.startCardId).toBe('home');
    expect(result.stack.cards).toEqual([
      { id: 'home', name: 'Home', objects: [], links: [], onOpen: [] },
    ]);
    expect(validateStack(result.stack).valid).toBe(true);
  });

  it('accepts sizes 64 and 4096', () => {
    for (const size of [64, 4096]) {
      const result = createStack({ ...GOOD, cardWidth: size, cardHeight: size });
      if (!result.ok) throw new Error(`expected ok for ${size}`);
      expect(result.stack.cardWidth).toBe(size);
      expect(result.stack.cardHeight).toBe(size);
      expect(validateStack(result.stack).valid).toBe(true);
    }
  });

  it('accepts names of 1 and 100 code points, ASCII and astral', () => {
    for (const unit of ['a', '😀']) {
      for (const length of [1, 100]) {
        const name = unit.repeat(length);
        const result = createStack({ ...GOOD, name, firstCardName: name });
        if (!result.ok) throw new Error(`expected ok for ${unit} x ${length}`);
        expect(result.stack.name).toBe(name);
        expect(result.stack.cards[0]?.name).toBe(name);
        expect(validateStack(result.stack).valid).toBe(true);
      }
    }
  });

  it('treats an explicit undefined optional parameter as omitted', () => {
    const result = createStack({ ...GOOD, cardWidth: undefined, firstCardName: undefined });
    if (!result.ok) throw new Error('expected ok');
    expect(result.stack.cardWidth).toBe(512);
    expect(result.stack.cards[0]?.name).toBe('Card 1');
  });
});

describe('createStack: errors (Requirement 11.15)', () => {
  it('reports an omitted id at the parameters root', () => {
    expect(codesAndPaths(expectRejected({ name: 'N' }))).toEqual([
      { code: 'MISSING_PROPERTY', path: '' },
    ]);
  });

  it('reports an omitted name at the parameters root', () => {
    expect(codesAndPaths(expectRejected({ id: 'x' }))).toEqual([
      { code: 'MISSING_PROPERTY', path: '' },
    ]);
  });

  it('reports an omitted id and name as two errors at the root, id first', () => {
    const errors = expectRejected({});
    expect(codesAndPaths(errors)).toEqual([
      { code: 'MISSING_PROPERTY', path: '' },
      { code: 'MISSING_PROPERTY', path: '' },
    ]);
    expect(errors[0]?.message).toContain('id');
    expect(errors[1]?.message).toContain('name');
  });

  it('reports an id or firstCardId that fails the pattern as INVALID_VALUE', () => {
    expect(codesAndPaths(expectRejected({ ...GOOD, id: 'Bad Id' }))).toEqual([
      { code: 'INVALID_VALUE', path: '/id' },
    ]);
    expect(codesAndPaths(expectRejected({ ...GOOD, firstCardId: '-no' }))).toEqual([
      { code: 'INVALID_VALUE', path: '/firstCardId' },
    ]);
  });

  it('reports an empty name or firstCardName as INVALID_VALUE', () => {
    expect(codesAndPaths(expectRejected({ ...GOOD, name: '' }))).toEqual([
      { code: 'INVALID_VALUE', path: '/name' },
    ]);
    expect(codesAndPaths(expectRejected({ ...GOOD, firstCardName: '' }))).toEqual([
      { code: 'INVALID_VALUE', path: '/firstCardName' },
    ]);
  });

  it('reports a name of 101 code points as LIMIT_EXCEEDED, ASCII and astral', () => {
    for (const unit of ['a', '😀']) {
      const name = unit.repeat(101);
      expect(codesAndPaths(expectRejected({ ...GOOD, name }))).toEqual([
        { code: 'LIMIT_EXCEEDED', path: '/name' },
      ]);
      expect(codesAndPaths(expectRejected({ ...GOOD, firstCardName: name }))).toEqual([
        { code: 'LIMIT_EXCEEDED', path: '/firstCardName' },
      ]);
    }
  });

  it('reports sizes 63 and 4097 as OUT_OF_RANGE', () => {
    for (const key of ['cardWidth', 'cardHeight']) {
      for (const size of [63, 4097]) {
        expect(codesAndPaths(expectRejected({ ...GOOD, [key]: size }))).toEqual([
          { code: 'OUT_OF_RANGE', path: `/${key}` },
        ]);
      }
    }
  });

  it('reports a non-integer size as OUT_OF_RANGE', () => {
    for (const key of ['cardWidth', 'cardHeight']) {
      expect(codesAndPaths(expectRejected({ ...GOOD, [key]: 100.5 }))).toEqual([
        { code: 'OUT_OF_RANGE', path: `/${key}` },
      ]);
    }
  });

  it('reports a string size as WRONG_TYPE', () => {
    for (const key of ['cardWidth', 'cardHeight']) {
      expect(codesAndPaths(expectRejected({ ...GOOD, [key]: '512' }))).toEqual([
        { code: 'WRONG_TYPE', path: `/${key}` },
      ]);
    }
  });

  it('reports an unknown parameter as UNKNOWN_PROPERTY', () => {
    const errors = expectRejected({ ...GOOD, color: 'red' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('UNKNOWN_PROPERTY');
  });

  it('reports params that are not an object as WRONG_TYPE at the root', () => {
    for (const params of [null, undefined, 'x', 7, []]) {
      const errors = expectRejected(params);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.path).toBe('');
    }
  });

  it('gives one error per broken parameter, in the fixed order', () => {
    // Keys are supplied in the reverse of the reporting order on purpose.
    const errors = expectRejected({
      firstCardName: '',
      firstCardId: 'BAD',
      cardHeight: 'tall',
      cardWidth: 5,
      name: '',
      id: 'BAD',
    });
    expect(codesAndPaths(errors)).toEqual([
      { code: 'INVALID_VALUE', path: '/id' },
      { code: 'INVALID_VALUE', path: '/name' },
      { code: 'OUT_OF_RANGE', path: '/cardWidth' },
      { code: 'WRONG_TYPE', path: '/cardHeight' },
      { code: 'INVALID_VALUE', path: '/firstCardId' },
      { code: 'INVALID_VALUE', path: '/firstCardName' },
    ]);
  });

  it('puts a missing id and name before errors at named parameters', () => {
    expect(codesAndPaths(expectRejected({ firstCardName: '', cardWidth: 1 }))).toEqual([
      { code: 'MISSING_PROPERTY', path: '' },
      { code: 'MISSING_PROPERTY', path: '' },
      { code: 'OUT_OF_RANGE', path: '/cardWidth' },
      { code: 'INVALID_VALUE', path: '/firstCardName' },
    ]);
  });

  it('does not throw for a throwing or cyclic input', () => {
    const cyclic: Record<string, unknown> = { ...GOOD };
    cyclic['self'] = cyclic;
    expect(createStack(cyclic).ok).toBe(false);
    const trap = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(createStack(trap).ok).toBe(false);
  });
});

describe('createStack: purity (Requirement 8.15)', () => {
  it('gives deeply equal results for equal calls and leaves a frozen input alone', () => {
    const params = Object.freeze({ ...GOOD, cardWidth: 800, firstCardName: 'Start' });
    const first = createStack(params);
    const second = createStack(params);
    expect(first).toEqual(second);
    expect(params).toEqual({ ...GOOD, cardWidth: 800, firstCardName: 'Start' });
    const bad = Object.freeze({ id: 'Bad' });
    expect(createStack(bad)).toEqual(createStack(bad));
  });
});
