import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LIMITS } from './limits.ts';
import { checkAgainstSchema, createValidationError, toJsonPointer } from './schema-check.ts';

const ParamsSchema = z.strictObject({
  label: z.string(),
  width: z.number().int().min(1).max(10).optional(),
});

const NestedSchema = z.strictObject({ inner: z.strictObject({ name: z.string() }) });

function failureOf(result: ReturnType<typeof checkAgainstSchema>) {
  if (result.ok) throw new Error('expected a failure');
  return result;
}

describe('checkAgainstSchema', () => {
  it('returns the parsed value on success', () => {
    const result = checkAgainstSchema(ParamsSchema, { label: 'Go', width: 3 });
    expect(result).toEqual({ ok: true, value: { label: 'Go', width: 3 } });
  });

  it('reports a missing property at the root, the nearest existing ancestor', () => {
    const { errors, truncated } = failureOf(checkAgainstSchema(ParamsSchema, {}));
    expect(truncated).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'MISSING_PROPERTY', path: '', actual: null });
  });

  it('reports a missing nested property at the nested parent', () => {
    const { errors } = failureOf(checkAgainstSchema(NestedSchema, { inner: {} }));
    expect(errors[0]).toMatchObject({ code: 'MISSING_PROPERTY', path: '/inner' });
  });

  it('reports a wrong type', () => {
    const { errors } = failureOf(checkAgainstSchema(ParamsSchema, { label: 5 }));
    expect(errors[0]).toMatchObject({ code: 'WRONG_TYPE', path: '/label', actual: '5' });
  });

  it('reports an unknown key', () => {
    const { errors } = failureOf(checkAgainstSchema(ParamsSchema, { label: 'Go', extra: true }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'UNKNOWN_PROPERTY', path: '/extra', actual: 'true' });
  });

  it('keeps INVALID_VALUE for numbers outside the range when rangePaths is not given', () => {
    const { errors } = failureOf(checkAgainstSchema(ParamsSchema, { label: 'Go', width: 1.5 }));
    expect(errors[0]).toMatchObject({ code: 'INVALID_VALUE', path: '/width' });
  });

  it('turns a non-integer and out-of-range numbers into OUT_OF_RANGE at a listed path', () => {
    const options = { rangePaths: ['/width'] };
    for (const width of [1.5, 0, 11]) {
      const { errors } = failureOf(
        checkAgainstSchema(ParamsSchema, { label: 'Go', width }, options),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: 'OUT_OF_RANGE', path: '/width' });
    }
  });

  it('leaves a string at a listed path as WRONG_TYPE', () => {
    const { errors } = failureOf(
      checkAgainstSchema(ParamsSchema, { label: 'Go', width: '3' }, { rangePaths: ['/width'] }),
    );
    expect(errors[0]).toMatchObject({ code: 'WRONG_TYPE', path: '/width' });
  });

  it('does not rewrite errors at paths that are not listed', () => {
    const schema = z.strictObject({ a: z.number().int(), b: z.number().int() });
    const { errors } = failureOf(
      checkAgainstSchema(schema, { a: 1.5, b: 1.5 }, { rangePaths: ['/a'] }),
    );
    expect(errors.map((e) => [e.path, e.code])).toEqual([
      ['/a', 'OUT_OF_RANGE'],
      ['/b', 'INVALID_VALUE'],
    ]);
  });

  it('sorts errors in document order of the candidate', () => {
    const schema = z.strictObject({ a: z.string(), b: z.string() });
    const { errors } = failureOf(checkAgainstSchema(schema, { b: 1, a: 2 }));
    expect(errors.map((e) => e.path)).toEqual(['/b', '/a']);
  });

  it('keeps the first 100 errors and sets truncated', () => {
    const schema = z.array(z.string());
    const candidate = Array.from({ length: LIMITS.maxErrors + 20 }, (_, i) => i);
    const { errors, truncated } = failureOf(checkAgainstSchema(schema, candidate));
    expect(errors).toHaveLength(LIMITS.maxErrors);
    expect(truncated).toBe(true);
  });

  it('does not throw for a cyclic object', () => {
    const cyclic: Record<string, unknown> = { label: 'Go' };
    cyclic['self'] = cyclic;
    const { errors } = failureOf(checkAgainstSchema(ParamsSchema, cyclic));
    expect(errors[0]).toMatchObject({ code: 'UNKNOWN_PROPERTY', path: '/self' });
  });

  it('returns the unreadable-value error when reading the candidate throws', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'label', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const { errors, truncated } = failureOf(checkAgainstSchema(ParamsSchema, hostile));
    expect(truncated).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'WRONG_TYPE', path: '' });
    expect(errors[0]?.message).toBe('The candidate could not be read as JSON data.');
  });

  it('gives every error the full Validation_Error shape', () => {
    const { errors } = failureOf(checkAgainstSchema(ParamsSchema, { label: 5 }));
    for (const error of errors) {
      expect(Object.keys(error).sort()).toEqual(
        ['actual', 'code', 'expected', 'hint', 'message', 'path'].sort(),
      );
      expect(typeof error.message).toBe('string');
      expect(typeof error.expected).toBe('string');
      expect(typeof error.hint).toBe('string');
    }
  });
});

describe('createValidationError', () => {
  const base = {
    code: 'UNKNOWN_ENTITY',
    path: '/cardId',
    message: 'No such card.',
    expected: 'an existing card id',
    hint: 'Use a card id from the stack.',
  } as const;

  it('builds the full shape with the actual value as JSON', () => {
    expect(createValidationError({ ...base, actual: 'card-9' })).toEqual({
      ...base,
      actual: '"card-9"',
    });
  });

  it('gives null when actual is absent', () => {
    expect(createValidationError(base).actual).toBeNull();
    expect(createValidationError({ ...base, actual: undefined }).actual).toBeNull();
  });

  it('keeps an explicit null value as the text "null"', () => {
    expect(createValidationError({ ...base, actual: null }).actual).toBe('null');
  });

  it('cuts actual to 200 code points without splitting a surrogate pair', () => {
    const long = '😀'.repeat(300);
    const { actual } = createValidationError({ ...base, actual: long });
    expect(actual).not.toBeNull();
    expect([...(actual ?? '')]).toHaveLength(LIMITS.actualMaxChars);
  });

  it('keeps the given path as is', () => {
    expect(createValidationError({ ...base, path: '' }).path).toBe('');
  });
});

describe('toJsonPointer re-export', () => {
  it('builds RFC 6901 pointers', () => {
    expect(toJsonPointer([])).toBe('');
    expect(toJsonPointer(['a/b', '~', 0])).toBe('/a~1b/~0/0');
  });
});
