import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbCandidate } from '../../test-support/arbitraries.ts';
import { assertProperty } from '../../test-support/seed.ts';
import { VALIDATION_ERROR_CODES } from './errors.ts';
import type { ValidationResult } from './errors.ts';
import { validateStack } from './validate.ts';

/** Freezes `value` and everything reachable from it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

/** Candidates are JSON-like, so a structured clone is an exact deep copy. */
function deepCopy<T>(value: T): T {
  return structuredClone(value);
}

function expectWellFormed(result: ValidationResult): void {
  expect(typeof result.valid).toBe('boolean');
  expect(typeof result.truncated).toBe('boolean');
  expect(Array.isArray(result.errors)).toBe(true);
  expect(result.valid).toBe(result.errors.length === 0);
  expect(result.errors.length).toBeLessThanOrEqual(100);
  if (result.truncated) {
    expect(result.errors.length).toBe(100);
  }
  for (const error of result.errors) {
    expect(VALIDATION_ERROR_CODES).toContain(error.code);
    expect(typeof error.path).toBe('string');
    expect(typeof error.message).toBe('string');
    expect(typeof error.expected).toBe('string');
    expect(typeof error.hint).toBe('string');
    expect(error.actual === null || typeof error.actual === 'string').toBe(true);
  }
}

describe('validateStack totality and determinism', () => {
  // Feature: thin-slice, Property 2: The validator is total, pure, and deterministic
  // **Validates: Requirements 6.1, 6.14, 22.8**
  it('never throws, never mutates the candidate, and returns equal results on repeated calls', () => {
    assertProperty(
      fc.property(arbCandidate, (candidate) => {
        const before = deepCopy(candidate);

        const first = validateStack(candidate);
        const second = validateStack(candidate);

        expect(candidate).toEqual(before);
        expect(second).toEqual(first);
        expectWellFormed(first);
      }),
    );
  });

  // Feature: thin-slice, Property 2: The validator is total, pure, and deterministic
  // **Validates: Requirements 6.1, 6.14, 22.8**
  it('gives the same result for a deeply frozen candidate as for a mutable one', () => {
    assertProperty(
      fc.property(arbCandidate, (candidate) => {
        const plain = deepCopy(candidate);
        const frozen = deepFreeze(deepCopy(candidate));

        const expected = validateStack(plain);
        const actual = validateStack(frozen);

        expect(actual).toEqual(expected);
        expect(validateStack(frozen)).toEqual(expected);
        expect(frozen).toEqual(candidate);
      }),
    );
  });
});
