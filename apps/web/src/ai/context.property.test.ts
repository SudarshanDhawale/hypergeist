import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Stack } from '@hypergeist/shared/format';
import { arbStack } from '../../../../packages/shared/test-support/arbitraries.ts';
import { deepCopy, deepFreeze } from '../../../../packages/shared/test-support/freeze.ts';
import { assertProperty } from '../../../../packages/shared/test-support/seed.ts';
import { buildContext, CONTEXT_MAX_CHARS } from './context.ts';

type ParsedContext = {
  readonly currentCard?: { readonly id?: unknown };
  readonly selectedObject?: { readonly id?: unknown };
};

type ContextCase = {
  readonly stack: Stack;
  readonly cardId: string;
  readonly objectId: string | null;
};

/** Picks an index in `[0, length)` from a fraction in `[0, 1)`. */
function pickIndex(fraction: number, length: number): number {
  return Math.min(length - 1, Math.floor(fraction * length));
}

/** A stack, any of its cards as the current card, and a selected object of that card or none. */
const arbContextCase: fc.Arbitrary<ContextCase> = arbStack.chain((stack) =>
  fc
    .record({
      cardFraction: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
      objectFraction: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
      select: fc.boolean(),
    })
    .map(({ cardFraction, objectFraction, select }): ContextCase => {
      const card = stack.cards[pickIndex(cardFraction, stack.cards.length)];
      if (card === undefined) throw new Error('arbStack produced a stack without cards');
      const object =
        select && card.objects.length > 0
          ? card.objects[pickIndex(objectFraction, card.objects.length)]
          : undefined;
      return { stack, cardId: card.id, objectId: object === undefined ? null : object.id };
    }),
);

describe('buildContext: property (full)', () => {
  it('Feature: ai-orchestrator, Property 3: The context is bounded and deterministic', () => {
    // **Validates: Requirements 5.1, 5.3, 5.5, 13.3**
    assertProperty(
      fc.property(arbContextCase, ({ stack, cardId, objectId }) => {
        const snapshot = deepCopy(stack);
        const frozen = deepFreeze(deepCopy(stack));

        const first = buildContext(frozen, cardId, objectId);
        const second = buildContext(frozen, cardId, objectId);

        expect(second).toEqual(first);
        expect(first.text.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);

        const parsed = JSON.parse(first.text) as ParsedContext;
        expect(parsed.currentCard?.id).toBe(cardId);
        if (objectId !== null) expect(parsed.selectedObject?.id).toBe(objectId);

        // The builder neither mutated nor aliased its input.
        expect(frozen).toEqual(snapshot);
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});
