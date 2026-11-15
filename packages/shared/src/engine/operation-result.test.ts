import { describe, expect, it } from 'vitest';
import type { ValidationError } from '../format/index.ts';
import { emptySummary, rejected, remapErrors, unknownEntityError } from './operation-result.ts';

const sampleError: ValidationError = {
  code: 'OUT_OF_BOUNDS',
  path: '/cards/0/objects/2/x',
  message: 'Too far right.',
  expected: 'x + width <= 512',
  actual: '600',
  hint: 'Move it left.',
};

describe('emptySummary', () => {
  it('has empty arrays and a zero count', () => {
    expect(emptySummary()).toEqual({ created: [], updated: [], removed: [], removedActions: 0 });
  });

  it('returns a fresh value each call', () => {
    expect(emptySummary()).not.toBe(emptySummary());
  });
});

describe('rejected', () => {
  it('has ok false and no stack property', () => {
    const result = rejected([sampleError]);
    expect(result.ok).toBe(false);
    expect('stack' in result).toBe(false);
    expect('summary' in result).toBe(false);
    expect(result).toEqual({ ok: false, errors: [sampleError], truncated: false });
  });

  it('carries the truncated flag', () => {
    expect(rejected([], true)).toEqual({ ok: false, errors: [], truncated: true });
  });
});

describe('unknownEntityError', () => {
  it('builds an UNKNOWN_ENTITY error at the given path with the full error shape', () => {
    const error = unknownEntityError('/cardId', 'nope', 'Card', ['card-1', 'card-2']);
    expect(error).toEqual({
      code: 'UNKNOWN_ENTITY',
      path: '/cardId',
      message: expect.any(String),
      expected: expect.any(String),
      actual: '"nope"',
      hint: expect.stringContaining('card-1, card-2'),
    });
  });

  it('lists all ids when there are exactly 20', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `card-${i + 1}`);
    const error = unknownEntityError('/cardId', 'x', 'Card', ids);
    expect(error.hint).toContain('card-20');
    expect(error.hint).not.toContain('more');
  });

  it('cuts the id list at 20 and says how many are left out', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `card-${i + 1}`);
    const error = unknownEntityError('/cardId', 'x', 'Card', ids);
    expect(error.hint).toContain('card-20');
    expect(error.hint).not.toContain('card-21');
    expect(error.hint).toContain('5 more');
  });

  it('has a usable hint when there are no valid ids', () => {
    const error = unknownEntityError('/objectId', 'x', 'Object', []);
    expect(error.code).toBe('UNKNOWN_ENTITY');
    expect(error.hint.length).toBeGreaterThan(0);
  });

  it('reports a non-string id as JSON text', () => {
    expect(unknownEntityError('/cardId', 5, 'Card', []).actual).toBe('5');
  });
});

describe('remapErrors', () => {
  it('maps a mappable pointer and keeps code, message, expected, actual and hint', () => {
    const [mapped] = remapErrors([sampleError], (pointer) =>
      pointer === '/cards/0/objects/2/x' ? '/x' : undefined,
    );
    expect(mapped).toEqual({ ...sampleError, path: '/x' });
  });

  it('maps to the root parameter pointer when mapPath returns an empty string', () => {
    const [mapped] = remapErrors([sampleError], () => '');
    expect(mapped?.path).toBe('');
  });

  it('falls back to /stack plus the Stack pointer when the pointer is unmappable', () => {
    const [mapped] = remapErrors([sampleError], () => undefined);
    expect(mapped).toEqual({ ...sampleError, path: '/stack/cards/0/objects/2/x' });
  });

  it('maps the Stack root pointer to /stack in the fallback', () => {
    const [mapped] = remapErrors([{ ...sampleError, path: '' }], () => undefined);
    expect(mapped?.path).toBe('/stack');
  });

  it('keeps order, does not mutate the input, and returns an empty list for no errors', () => {
    const input = Object.freeze([Object.freeze({ ...sampleError })]);
    const output = remapErrors(input, () => '/x');
    expect(input[0]?.path).toBe('/cards/0/objects/2/x');
    expect(output).not.toBe(input);
    expect(remapErrors([], () => '/x')).toEqual([]);
  });
});
