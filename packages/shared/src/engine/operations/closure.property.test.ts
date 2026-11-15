import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbStack } from '../../../test-support/arbitraries.ts';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import {
  arbOperationSequence,
  resolveOperation,
} from '../../../test-support/operation-arbitraries.ts';
import { assertProperty } from '../../../test-support/seed.ts';
import { VALIDATION_ERROR_CODES, validateStack } from '../../format/index.ts';
import type { Stack } from '../../format/index.ts';
import { applyOperation } from './index.ts';

describe('applyOperation closure', () => {
  // Feature: stack-engine, Property 1: Operations keep the Stack valid
  // **Validates: Requirements 1.1, 11.6**
  it('keeps the held Stack valid after every step, accepted or rejected', () => {
    const seen = { accepted: 0, rejected: 0 };
    assertProperty(
      fc.property(arbStack, arbOperationSequence, (initial, templates) => {
        let held: Stack = deepFreeze(deepCopy(initial));
        for (const template of templates) {
          const call = resolveOperation(held, template);
          const before = deepCopy(held);

          const result = applyOperation(held, call.name, call.params);

          // The input is frozen, so a write would have thrown. It must also be unchanged.
          expect(held).toEqual(before);

          if (result.ok) {
            seen.accepted += 1;
            expect(Array.isArray(result.summary.created)).toBe(true);
            expect(Array.isArray(result.summary.updated)).toBe(true);
            expect(Array.isArray(result.summary.removed)).toBe(true);
            expect(typeof result.summary.removedActions).toBe('number');
            expect(Number.isInteger(result.summary.removedActions)).toBe(true);
            expect(result.summary.removedActions).toBeGreaterThanOrEqual(0);
            expect(validateStack(result.stack).valid).toBe(true);
            held = deepFreeze(deepCopy(result.stack));
          } else {
            seen.rejected += 1;
            expect('stack' in result).toBe(false);
            expect(result.errors.length).toBeGreaterThanOrEqual(1);
            for (const error of result.errors) {
              expect(VALIDATION_ERROR_CODES).toContain(error.code);
            }
          }

          expect(validateStack(held).valid).toBe(true);
        }
      }),
    );
    expect(seen.accepted).toBeGreaterThan(0);
    expect(seen.rejected).toBeGreaterThan(0);
  });
});
