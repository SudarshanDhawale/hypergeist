import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbCreateStackParams } from '../../test-support/factory-arbitraries.ts';
import { assertProperty } from '../../test-support/seed.ts';
import { validateStack } from '../format/index.ts';
import { createStack } from './create-stack.ts';

describe('createStack', () => {
  // Feature: stack-engine, Property 22: createStack makes a valid one-Card Stack
  // **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 11.14**
  it('returns a valid one-Card Stack with the supplied values and the defaults', () => {
    assertProperty(
      fc.property(arbCreateStackParams, (params) => {
        const result = createStack(params);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const { stack } = result;

        expect(validateStack(stack).valid).toBe(true);
        expect(stack.formatVersion).toBe(1);
        expect(Object.hasOwn(stack, 'remixedFrom')).toBe(false);

        expect(stack.id).toBe(params.id);
        expect(stack.name).toBe(params.name);
        expect(stack.cardWidth).toBe(params.cardWidth ?? 512);
        expect(stack.cardHeight).toBe(params.cardHeight ?? 342);

        expect(stack.cards).toHaveLength(1);
        const [card] = stack.cards;
        expect(card).toBeDefined();
        if (card === undefined) return;
        expect(card.id).toBe(params.firstCardId ?? 'card-1');
        expect(card.name).toBe(params.firstCardName ?? 'Card 1');
        expect(card.objects).toEqual([]);
        expect(card.links).toEqual([]);
        expect(card.onOpen).toEqual([]);
        expect(stack.startCardId).toBe(card.id);
      }),
    );
  });
});
