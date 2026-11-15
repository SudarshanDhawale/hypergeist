import type { z } from 'zod';
import { unreadableResult } from './check.ts';
import type { ValidationError, ValidationErrorCode } from './errors.ts';
import { buildValidationError, finalize } from './finalize.ts';
import { toJsonPointer } from './text.ts';
import { ABSENT, mapZodIssues } from './zod-issues.ts';
import type { RawError } from './zod-issues.ts';

/**
 * A small public door to the format's Zod-issue mapper, for the engine. Parameter errors then
 * use the same codes, messages, hints, sorting and 100-error cap as `validateStack`.
 */

/** The result of `checkAgainstSchema`: the parsed value, or the mapped errors. */
export type SchemaCheck<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
      readonly truncated: boolean;
    };

export type SchemaCheckOptions = {
  /**
   * JSON Pointers of integer parameters whose number-valued failures (not an integer,
   * below the minimum, above the maximum) are reported as OUT_OF_RANGE instead of
   * INVALID_VALUE. A wrong JSON type (a string) stays WRONG_TYPE.
   */
  readonly rangePaths?: readonly string[];
};

function failure(errors: readonly ValidationError[], truncated: boolean): SchemaCheck<never> {
  return { ok: false, errors, truncated };
}

/** Turns INVALID_VALUE into OUT_OF_RANGE for errors at a listed path. */
function applyRangePaths(raws: readonly RawError[], rangePaths: readonly string[]): RawError[] {
  if (rangePaths.length === 0) return [...raws];
  const listed = new Set(rangePaths);
  return raws.map((raw) =>
    raw.code === 'INVALID_VALUE' && listed.has(toJsonPointer(raw.segments))
      ? { ...raw, code: 'OUT_OF_RANGE' }
      : raw,
  );
}

/**
 * Parses `candidate` with `schema`. Same mapper, codes, sorting and 100-error cap as
 * `validateStack`. Never throws: a cyclic or throwing value gives the unreadable-value error.
 */
export function checkAgainstSchema<S extends z.ZodType>(
  schema: S,
  candidate: unknown,
  options?: SchemaCheckOptions,
): SchemaCheck<z.infer<S>> {
  try {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return { ok: true, value: parsed.data };
    const raws = applyRangePaths(
      mapZodIssues(parsed.error.issues, candidate),
      options?.rangePaths ?? [],
    );
    const result = finalize(raws, candidate);
    return failure(result.errors, result.truncated);
  } catch {
    const result = unreadableResult(candidate);
    return failure(result.errors, result.truncated);
  }
}

/** Builds one ValidationError. `actual` is cut to 200 code points; an absent value gives `null`. */
export function createValidationError(input: {
  readonly code: ValidationErrorCode;
  readonly path: string;
  readonly message: string;
  readonly expected: string;
  readonly hint: string;
  readonly actual?: unknown;
}): ValidationError {
  const built = buildValidationError({
    code: input.code,
    segments: [],
    message: input.message,
    expected: input.expected,
    hint: input.hint,
    actual: input.actual === undefined ? ABSENT : input.actual,
  });
  // The caller already holds a JSON Pointer, so it replaces the root pointer built from no segments.
  return { ...built, path: input.path };
}

export { toJsonPointer } from './text.ts';
