import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbStack } from '../../../test-support/arbitraries.ts';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import {
  arbOperationTemplate,
  resolveOperation,
} from '../../../test-support/operation-arbitraries.ts';
import { assertProperty } from '../../../test-support/seed.ts';
import { VALIDATION_ERROR_CODES, validateStack } from '../../format/index.ts';
import type { Stack, ValidationError } from '../../format/index.ts';
import { applyOperation } from './index.ts';

const MAX_ACTUAL_CODE_POINTS = 200;

/** A few steps per case, so later calls run against Stacks that earlier accepted calls changed. */
const MAX_STEPS = 8;

/** Every way an error can break the standard shape; empty when the error is well formed. */
function shapeProblems(error: ValidationError): string[] {
  const problems: string[] = [];
  if (!(VALIDATION_ERROR_CODES as readonly string[]).includes(error.code)) {
    problems.push(`code ${String(error.code)} is not in the closed set`);
  }
  if (typeof error.path !== 'string') {
    problems.push('path is not a string');
  } else if (error.path !== '' && !error.path.startsWith('/')) {
    problems.push(`path "${error.path}" is neither "" nor a pointer`);
  } else if (error.path.startsWith('/stack')) {
    problems.push(`path "${error.path}" starts with /stack`);
  }
  for (const field of ['message', 'expected', 'hint'] as const) {
    const value: unknown = error[field];
    if (typeof value !== 'string' || value.length === 0) problems.push(`${field} is empty`);
  }
  const actual: unknown = error.actual;
  if (actual !== null) {
    if (typeof actual !== 'string') {
      problems.push('actual is neither null nor a string');
    } else if ([...actual].length > MAX_ACTUAL_CODE_POINTS) {
      problems.push(`actual has more than ${MAX_ACTUAL_CODE_POINTS} code points`);
    }
  }
  return problems;
}

describe('rejected Operations', () => {
  // Feature: stack-engine, Property 2: A rejected Operation changes nothing
  // **Validates: Requirements 1.2, 1.3, 1.10, 3.13, 4.7, 9.6, 11.7**
  it('leave the deeply frozen Stack unchanged and report well-formed errors', () => {
    const seen = { accepted: 0, rejected: 0, withExpectedCode: 0 };
    assertProperty(
      fc.property(
        arbStack,
        fc.array(arbOperationTemplate, { minLength: 1, maxLength: MAX_STEPS }),
        (initial, templates) => {
          let held: Stack = initial;
          for (const template of templates) {
            const call = resolveOperation(held, template);
            const frozen = deepFreeze(deepCopy(held));
            const before = deepCopy(held);
            const frozenParams = deepFreeze(deepCopy(call.params));

            const result = applyOperation(frozen, call.name, frozenParams);

            // Accepted or not, the input is not modified.
            expect(frozen).toEqual(before);

            if (result.ok) {
              seen.accepted += 1;
              // A call with an expected code must never be accepted.
              expect(call.expectedCode).toBeUndefined();
              expect(validateStack(result.stack).valid).toBe(true);
              held = result.stack;
              continue;
            }

            seen.rejected += 1;
            expect(result.errors.length).toBeGreaterThanOrEqual(1);
            expect(Object.hasOwn(result, 'stack')).toBe(false);
            expect(Object.keys(result).sort()).toEqual(['errors', 'ok', 'truncated']);
            for (const error of result.errors) {
              expect(shapeProblems(error), JSON.stringify(error)).toEqual([]);
            }
            if (call.expectedCode !== undefined) {
              seen.withExpectedCode += 1;
              expect(result.errors.map((error) => error.code)).toContain(call.expectedCode);
            }
          }
        },
      ),
    );

    // Both outcomes, and calls that carry an expected code, occurred.
    expect(seen.accepted).toBeGreaterThan(0);
    expect(seen.rejected).toBeGreaterThan(0);
    expect(seen.withExpectedCode).toBeGreaterThan(0);
  });
});
