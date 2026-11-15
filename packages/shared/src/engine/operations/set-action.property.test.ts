import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbHandlerFor, arbStack } from '../../../test-support/arbitraries.ts';
import type { HandlerMode } from '../../../test-support/arbitraries.ts';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import { assertProperty } from '../../../test-support/seed.ts';
import { validateStack } from '../../format/index.ts';
import type { Handler, Stack } from '../../format/index.ts';
import { applyOperation } from './index.ts';

type Owner = { readonly id: string; readonly kind: 'button' | 'card' };

/** Every Card and every Button of the Stack, in document order. */
function ownersOf(stack: Stack): readonly Owner[] {
  return stack.cards.flatMap((card): Owner[] => [
    { id: card.id, kind: 'card' },
    ...card.objects.flatMap((object): Owner[] =>
      object.type === 'button' ? [{ id: object.id, kind: 'button' }] : [],
    ),
  ]);
}

/**
 * The Stack that `set_action` must produce: the owner's Handler replaced as a whole and every
 * other value left alone. Built on a deep copy so the check shares nothing with the engine.
 */
function expectedStack(stack: Stack, owner: Owner, handler: Handler): Stack {
  const copy = deepCopy(stack);
  for (const card of copy.cards) {
    if (owner.kind === 'card' && card.id === owner.id) card.onOpen = deepCopy(handler);
    for (const object of card.objects) {
      if (owner.kind === 'button' && object.type === 'button' && object.id === owner.id) {
        object.onClick = deepCopy(handler);
      }
    }
  }
  return copy;
}

type Case = {
  readonly stack: Stack;
  readonly owner: Owner;
  readonly handler: Handler;
};

/** A Stack, one of its Buttons or Cards, and a Handler valid for that Stack in the given mode. */
function arbCase(mode: HandlerMode): fc.Arbitrary<Case> {
  return arbStack.chain((stack) => {
    const owners = ownersOf(stack);
    return fc
      .tuple(fc.integer({ min: 0, max: owners.length - 1 }), arbHandlerFor(stack, mode))
      .map(([index, handler]) => ({
        stack,
        // A Stack always has at least one Card, so `owners` is never empty.
        owner: owners[index] as Owner,
        handler,
      }));
  });
}

describe('set_action', () => {
  for (const mode of ['executable', 'all'] as const) {
    // Feature: stack-engine, Property 13: set_action replaces one Handler and is idempotent
    // **Validates: Requirements 4.4, 4.5, 4.8**
    it(`replaces only the owner's Handler and is idempotent (${mode} Handlers)`, () => {
      const seen = { button: 0, card: 0, emptyHandler: 0, nonEmptyHandler: 0 };
      assertProperty(
        fc.property(arbCase(mode), ({ stack, owner, handler }) => {
          const frozenStack = deepFreeze(deepCopy(stack));
          const frozenHandler = deepFreeze(deepCopy(handler));
          const params = deepFreeze({ ownerId: owner.id, handler: frozenHandler });

          const first = applyOperation(frozenStack, 'set_action', params);
          if (!first.ok) {
            throw new Error(`First set_action was rejected: ${JSON.stringify(first.errors)}`);
          }

          // The whole Handler is replaced and nothing else changes.
          expect(first.stack).toEqual(expectedStack(stack, owner, handler));
          expect(validateStack(first.stack).valid).toBe(true);
          expect(first.summary.updated).toEqual([owner.id]);

          // The same call again is accepted and gives an equal Stack.
          const second = applyOperation(deepFreeze(deepCopy(first.stack)), 'set_action', params);
          if (!second.ok) {
            throw new Error(`Second set_action was rejected: ${JSON.stringify(second.errors)}`);
          }
          expect(second.stack).toEqual(first.stack);

          // The input Stack was not modified.
          expect(frozenStack).toEqual(stack);

          seen[owner.kind] += 1;
          seen[handler.length === 0 ? 'emptyHandler' : 'nonEmptyHandler'] += 1;
        }),
      );
      // The generators reach both kinds of owner and both empty and non-empty Handlers.
      expect(seen.button).toBeGreaterThan(0);
      expect(seen.card).toBeGreaterThan(0);
      expect(seen.nonEmptyHandler).toBeGreaterThan(0);
    });
  }
});
