import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbHandlerFor, arbStack } from '../../test-support/arbitraries.ts';
import { deepCopy, deepFreeze } from '../../test-support/freeze.ts';
import { assertProperty } from '../../test-support/seed.ts';
import { validateStack } from '../format/index.ts';
import type { Handler, Stack } from '../format/index.ts';
import { executeHandler } from './execute-handler.ts';

const SKIP_PREFIX = 'Skipped action';
const EFFECT_KINDS: readonly string[] = [
  'run_ai_field',
  'fetch_news',
  'transcribe_audio',
  'schedule_notification',
];

const arbStackAndHandler: fc.Arbitrary<{ readonly stack: Stack; readonly handler: Handler }> =
  arbStack.chain((stack) => arbHandlerFor(stack, 'all').map((handler) => ({ stack, handler })));

describe('executeHandler results over all nine Actions', () => {
  // Feature: stack-engine, Property 16: Executor results stay valid for all nine Actions
  // **Validates: Requirements 5.12, 5.17, 11.8**
  it('returns a valid stack, a card for navigateTo, string messages, and only known effects', () => {
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
        for (const effect of result.effects) {
          expect(EFFECT_KINDS).toContain(effect.kind);
          expect(Number.isInteger(effect.actionIndex)).toBe(true);
          expect(effect.actionIndex).toBeGreaterThanOrEqual(0);
          expect(effect.actionIndex).toBeLessThan(handler.length);
        }
      }),
    );
  });

  // Feature: stack-engine, Property 16: Executor results stay valid for all nine Actions
  // **Validates: Requirements 5.12, 5.17, 11.8**
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

  // Feature: stack-engine, Property 16: Executor results stay valid for all nine Actions
  // **Validates: Requirements 5.12, 5.17, 11.8**
  it('never mutates frozen inputs and returns an equal result on a repeat run', () => {
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
      }),
    );
  });
});
