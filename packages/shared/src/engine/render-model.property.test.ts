import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbStack } from '../../test-support/arbitraries.ts';
import { assertProperty } from '../../test-support/seed.ts';
import type { Stack, StackObject } from '../format/index.ts';
import { buildRenderModel } from './render-model.ts';
import type { RenderObject } from './render-model.ts';

/** The render object without the `inputs` an ai-field gains. */
function withoutInputs(object: RenderObject): StackObject {
  if (object.type === 'ai-field') {
    const rest: Record<string, unknown> = { ...object };
    delete rest['inputs'];
    return rest as StackObject;
  }
  return object;
}

function checkEveryCard(stack: Stack): void {
  const cardNames = new Map(stack.cards.map((card) => [card.id, card.name]));

  for (const card of stack.cards) {
    const names = new Map(card.objects.map((object) => [object.id, object.name]));
    const result = buildRenderModel(stack, card.id);
    if (!result.ok) {
      throw new Error(
        `buildRenderModel failed for card "${card.id}": ${JSON.stringify(result.errors)}`,
      );
    }
    const { model } = result;

    expect(model.cardWidth).toBe(stack.cardWidth);
    expect(model.cardHeight).toBe(stack.cardHeight);
    expect(model.id).toBe(card.id);
    expect(model.name).toBe(card.name);

    // Objects: same count and order, every property, position and size unchanged, inside the card.
    expect(model.objects.map(withoutInputs)).toEqual(card.objects);
    for (const object of model.objects) {
      expect(object.x + object.width).toBeLessThanOrEqual(model.cardWidth);
      expect(object.y + object.height).toBeLessThanOrEqual(model.cardHeight);
    }

    // ai-field inputs: `{ id, name }` per `inputObjectIds` entry, in order.
    model.objects.forEach((object, index) => {
      const source = card.objects[index];
      if (object.type === 'ai-field' && source?.type === 'ai-field') {
        expect(object.inputs).toEqual(
          source.inputObjectIds.map((id) => ({ id, name: names.get(id) })),
        );
      } else {
        expect('inputs' in object).toBe(false);
      }
    });

    // Links: same order, `targetCardName` is the target Card's name.
    expect(
      model.links.map((link) => {
        const rest: Record<string, unknown> = { ...link };
        delete rest['targetCardName'];
        return rest;
      }),
    ).toEqual(card.links);
    model.links.forEach((link) => {
      expect(link.targetCardName).toBe(cardNames.get(link.targetCardId));
    });
  }
}

describe('buildRenderModel properties', () => {
  // Feature: stack-engine, Property 19: The Render_Model is total and faithful
  // **Validates: Requirements 6.1, 6.2, 6.3, 6.6, 11.5**
  it('builds a faithful model for every Card of every valid Stack', () => {
    assertProperty(
      fc.property(arbStack, (stack) => {
        checkEveryCard(stack);
      }),
    );
  });
});
