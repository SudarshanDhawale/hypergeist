import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbCandidate, arbMutation } from '../../test-support/arbitraries.ts';
import { resolvePointer } from '../../test-support/oracles.ts';
import { assertProperty } from '../../test-support/seed.ts';
import { VALIDATION_ERROR_CODES } from './errors.ts';
import type { ValidationResult } from './errors.ts';
import { parseStack } from './parse.ts';
import { serializeStack } from './serialize.ts';
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

  // Feature: stack-format-and-validator, Property 2: The validator is total, pure, and deterministic
  // **Validates: Requirements 2.5, 7.11, 10.3, 12.6**
  it('validateStack, parseStack, and serializeStack never throw, leave the candidate untouched, and repeat exactly (plain and deeply frozen)', () => {
    assertProperty(
      fc.property(arbCandidate, (candidate) => {
        const operations = [
          ['validateStack', validateStack],
          ['parseStack', parseStack],
          ['serializeStack', serializeStack],
        ] as const;

        for (const variant of ['plain', 'frozen'] as const) {
          const subject =
            variant === 'frozen' ? deepFreeze(deepCopy(candidate)) : deepCopy(candidate);
          const before = deepCopy(subject);

          for (const [name, operation] of operations) {
            let first: unknown;
            let second: unknown;
            try {
              first = operation(subject);
              second = operation(subject);
            } catch (error) {
              throw new Error(`${name} threw on a ${variant} candidate: ${String(error)}`, {
                cause: error,
              });
            }
            expect(second, `${name} (${variant}) differs between two calls`).toEqual(first);
            expect(subject, `${name} (${variant}) mutated the candidate`).toEqual(before);
          }
        }
      }),
    );
  });

  // Feature: stack-format-and-validator, Property 3: Results are well-formed and paths resolve
  // **Validates: Requirements 1.11, 3.6, 6.13, 7.1, 7.3, 7.4, 7.5, 7.13, 8.8, 12.5**
  it('rejects every mutated valid stack with well-formed errors whose paths resolve to the mutated value or its nearest ancestor', () => {
    assertProperty(
      fc.property(arbMutation, (mutation) => {
        const result = validateStack(mutation.mutated);

        expect(result.valid, `${mutation.kind} at ${JSON.stringify(mutation.path)} validated`).toBe(
          false,
        );
        expectWellFormed(result);
        expect(result.errors.length).toBeGreaterThan(0);
        for (const error of result.errors) {
          expect(error.code).not.toBe('OUT_OF_RANGE');
          expect(error.code).not.toBe('UNKNOWN_ENTITY');
          expect(error.message.length).toBeGreaterThan(0);
          expect(error.expected.length).toBeGreaterThan(0);
          expect(error.hint.length).toBeGreaterThan(0);
          if (error.actual !== null) {
            expect([...error.actual].length).toBeLessThanOrEqual(200);
          }
          const resolution = resolvePointer(mutation.mutated, error.path);
          expect(
            resolution.kind,
            `path ${JSON.stringify(error.path)} is not a resolvable pointer`,
          ).not.toBe('malformed');
        }
      }),
    );
  });
});
