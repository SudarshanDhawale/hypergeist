import { describe, expect, it } from 'vitest';
import type { ValidationErrorCode } from './errors.ts';
import { buildValidationError, finalize, fromSemanticError } from './finalize.ts';
import type { SemanticError } from './semantic.ts';
import { ABSENT } from './zod-issues.ts';
import type { PathSegment, RawError } from './zod-issues.ts';

function raw(
  segments: readonly PathSegment[],
  code: ValidationErrorCode = 'INVALID_VALUE',
  actual: unknown = ABSENT,
): RawError {
  return { code, segments, message: 'm', expected: 'e', hint: 'h', actual };
}

function paths(errors: readonly { path: string }[]): string[] {
  return errors.map((error) => error.path);
}

describe('finalize ordering', () => {
  it('orders by position in the candidate, not alphabetically', () => {
    const candidate = { b: 1, a: 2 };
    const result = finalize([raw(['a']), raw(['b'])], candidate);
    expect(paths(result.errors)).toEqual(['/b', '/a']);
  });

  it('orders array indexes numerically and puts a parent before its children', () => {
    const candidate = { list: Array.from({ length: 12 }, () => ({ x: 1 })) };
    const result = finalize(
      [raw(['list', 10, 'x']), raw(['list', 2]), raw(['list']), raw(['list', 2, 'x'])],
      candidate,
    );
    expect(paths(result.errors)).toEqual(['/list', '/list/2', '/list/2/x', '/list/10/x']);
  });

  it('breaks ties by code in ascending code-point order', () => {
    const candidate = { a: 1 };
    const result = finalize(
      [raw(['a'], 'WRONG_TYPE'), raw(['a'], 'DUPLICATE_ID'), raw(['a'], 'INVALID_VALUE')],
      candidate,
    );
    expect(result.errors.map((error) => error.code)).toEqual([
      'DUPLICATE_ID',
      'INVALID_VALUE',
      'WRONG_TYPE',
    ]);
  });

  it('sorts a path that is not in the candidate after the paths that are', () => {
    const result = finalize([raw(['gone']), raw(['a'])], { a: 1 });
    expect(paths(result.errors)).toEqual(['/a', '/gone']);
  });
});

describe('finalize result shape', () => {
  it('reports valid for no errors', () => {
    expect(finalize([], {})).toEqual({ valid: true, errors: [], truncated: false });
  });

  it.each([
    [99, 99, false],
    [100, 100, false],
    [101, 100, true],
    [150, 100, true],
  ])('with %i errors keeps %i and truncated is %s', (count, kept, truncated) => {
    const candidate = Array.from({ length: count }, () => 0);
    const errors = candidate.map((_, index) => raw([index]));
    const result = finalize(errors.reverse(), candidate);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(kept);
    expect(result.truncated).toBe(truncated);
    expect(result.errors[0]?.path).toBe('/0');
    expect(result.errors[kept - 1]?.path).toBe(`/${kept - 1}`);
  });
});

describe('buildValidationError', () => {
  it('writes keys in the order code, path, message, expected, actual, hint', () => {
    const error = buildValidationError(raw(['a'], 'WRONG_TYPE', 1));
    expect(Object.keys(error)).toEqual(['code', 'path', 'message', 'expected', 'actual', 'hint']);
  });

  it('escapes pointer segments', () => {
    expect(buildValidationError(raw(['a/b', '~c', 3])).path).toBe('/a~1b/~0c/3');
    expect(buildValidationError(raw([])).path).toBe('');
  });

  it('serializes actual as JSON and uses null when the property is absent', () => {
    expect(buildValidationError(raw([], 'INVALID_VALUE', { a: [1, 'x'] })).actual).toBe(
      '{"a":[1,"x"]}',
    );
    expect(buildValidationError(raw([], 'INVALID_VALUE', 'hi')).actual).toBe('"hi"');
    expect(buildValidationError(raw([], 'INVALID_VALUE', null)).actual).toBe('null');
    expect(buildValidationError(raw([], 'MISSING_PROPERTY', ABSENT)).actual).toBeNull();
  });

  it('cuts actual to 200 code points without splitting a surrogate pair', () => {
    const ascii = buildValidationError(raw([], 'INVALID_VALUE', 'a'.repeat(300))).actual;
    expect([...(ascii ?? '')]).toHaveLength(200);

    // JSON text is `"` + 199 emoji..., so the cut falls between whole emoji.
    const astral = buildValidationError(raw([], 'INVALID_VALUE', '😀'.repeat(300))).actual ?? '';
    expect([...astral]).toHaveLength(200);
    expect(astral.length).toBe(1 + 199 * 2);
    expect(astral.endsWith('😀')).toBe(true);

    const exact = buildValidationError(raw([], 'INVALID_VALUE', 'a'.repeat(198))).actual;
    expect([...(exact ?? '')]).toHaveLength(200);
  });

  it('falls back to String(value) when JSON cannot hold the value', () => {
    expect(buildValidationError(raw([], 'INVALID_VALUE', 10n)).actual).toBe('10');
    const explicitUndefined: RawError = { ...raw([]), actual: undefined };
    expect(buildValidationError(explicitUndefined).actual).toBe('undefined');
  });
});

describe('fromSemanticError', () => {
  const base = {
    code: 'DANGLING_REFERENCE',
    segments: ['startCardId'],
    message: 'm',
    expected: 'e',
    hint: 'h',
  } as const;

  it('keeps a present value, including falsy ones', () => {
    const present: SemanticError = { ...base, actual: { present: true, value: 0 } };
    expect(fromSemanticError(present).actual).toBe(0);
    const nothing: SemanticError = { ...base, actual: { present: true, value: undefined } };
    expect(fromSemanticError(nothing).actual).toBeUndefined();
  });

  it('maps "not present" to ABSENT', () => {
    const absent: SemanticError = { ...base, actual: { present: false } };
    const converted = fromSemanticError(absent);
    expect(converted.actual).toBe(ABSENT);
    expect(converted).toMatchObject({ code: 'DANGLING_REFERENCE', segments: ['startCardId'] });
  });
});
