import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbHandlerFor, arbStack } from '../../test-support/arbitraries.ts';
import { assertProperty } from '../../test-support/seed.ts';
import type { Handler, Stack } from '../format/index.ts';
import { executeHandler } from './execute-handler.ts';

/** Freezes `value` and everything reachable from it. A write to a frozen value throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

/** Stacks and Handlers are plain JSON data, so a structured clone is an exact deep copy. */
function deepCopy<T>(value: T): T {
  return structuredClone(value);
}

const arbStackAndHandler: fc.Arbitrary<{ readonly stack: Stack; readonly handler: Handler }> =
  arbStack.chain((stack) => arbHandlerFor(stack).map((handler) => ({ stack, handler })));

describe('executeHandler purity and determinism', () => {
  // Feature: thin-slice, Property 10: The executor is pure, deterministic, and effect-free
  // **Validates: Requirements 8.3, 8.13, 8.14, 22.4, 22.6**
  it('never throws, never mutates frozen inputs, repeats exactly, and returns no effects', () => {
    assertProperty(
      fc.property(arbStackAndHandler, ({ stack, handler }) => {
        const stackBefore = deepCopy(stack);
        const handlerBefore = deepCopy(handler);
        deepFreeze(stack);
        deepFreeze(handler);

        const first = executeHandler(stack, handler);
        const second = executeHandler(stack, handler);

        expect(stack).toEqual(stackBefore);
        expect(handler).toEqual(handlerBefore);
        expect(second).toEqual(first);
        expect(first.effects).toEqual([]);
        expect(second.effects).toEqual([]);
      }),
    );
  });
});
