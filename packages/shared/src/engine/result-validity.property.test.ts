import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbHandlerFor, arbStack } from '../../test-support/arbitraries.ts';
import { assertProperty } from '../../test-support/seed.ts';
import { validateStack } from '../format/index.ts';
import type { Handler, Stack } from '../format/index.ts';
import { executeHandler } from './execute-handler.ts';

const SKIP_PREFIX = 'Skipped action';

const arbStackAndHandler: fc.Arbitrary<{ readonly stack: Stack; readonly handler: Handler }> =
  arbStack.chain((stack) => arbHandlerFor(stack).map((handler) => ({ stack, handler })));

describe('executeHandler result validity', () => {
  // Feature: thin-slice, Property 11: Results stay valid and skips are clean
  // **Validates: Requirements 8.1, 8.10, 22.5**
  it('returns a valid stack, an existing navigateTo card, and string messages', () => {
    assertProperty(
      fc.property(arbStackAndHandler, ({ stack, handler }) => {
        const result = executeHandler(stack, handler);

        expect(validateStack(result.stack).valid).toBe(true);
        if (result.navigateTo !== undefined) {
          expect(result.stack.cards.map((card) => card.id)).toContain(result.navigateTo);
        }
        for (const message of result.messages) {
          expect(typeof message).toBe('string');
        }
      }),
    );
  });

  // Feature: thin-slice, Property 11: Results stay valid and skips are clean
  // **Validates: Requirements 8.1, 8.10, 22.5**
  it('leaves the stack unchanged and adds exactly one message when a single action is skipped', () => {
    assertProperty(
      fc.property(arbStackAndHandler, ({ stack, handler }) => {
        for (const action of handler) {
          // A show_message text is arbitrary, so it cannot count as a skip entry.
          if (action.type === 'show_message') {
            continue;
          }
          const result = executeHandler(stack, [action]);
          const skips = result.messages.filter((message) => message.startsWith(SKIP_PREFIX));
          if (skips.length > 0) {
            expect(result.stack).toEqual(stack);
            expect(result.messages).toHaveLength(1);
            expect(skips).toHaveLength(1);
          }
        }
      }),
    );
  });
});
