import type { Card, Stack, StackObject } from '../format/index.ts';

/**
 * Finds the first Object with the given id, searching Cards in order.
 * Returns `undefined` when no Object has that id.
 */
export function findObject(stack: Stack, objectId: string): StackObject | undefined {
  for (const card of stack.cards) {
    const found = card.objects.find((object) => object.id === objectId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Returns a new Stack in which the Object with the same id as `target` is replaced by
 * `replacement`. Only the path to that Object is rebuilt: every other Card and Object
 * keeps its identity, and no input is written to, so deeply frozen inputs work.
 * When no Object has `target.id`, the same Stack value is returned.
 */
export function withObject(stack: Stack, target: StackObject, replacement: StackObject): Stack {
  let changed = false;
  const cards = stack.cards.map((card) => {
    if (changed) {
      return card;
    }
    const index = card.objects.findIndex((object) => object.id === target.id);
    if (index === -1) {
      return card;
    }
    changed = true;
    return {
      ...card,
      objects: card.objects.map((object, i) => (i === index ? replacement : object)),
    };
  });
  return changed ? { ...stack, cards } : stack;
}

/**
 * The current text of an Object: a List's items joined by newline characters, a
 * Field's or AI field's value, and the empty string for anything else.
 */
export function textOf(object: StackObject): string {
  switch (object.type) {
    case 'list':
      return object.items.join('\n');
    case 'field':
    case 'ai-field':
      return object.value;
    default:
      return '';
  }
}

/**
 * Finds the Card with the given id. Returns `undefined` when no Card has that id.
 */
export function findCard(stack: Stack, cardId: string): Card | undefined {
  return stack.cards.find((card) => card.id === cardId);
}

/**
 * Returns a new Stack in which the Card at `index` is replaced by `replacement`. Every
 * other Card keeps its identity, and no input is written to, so deeply frozen inputs work.
 * When `index` is not a valid position in `stack.cards`, the same Stack value is returned.
 */
export function withCard(stack: Stack, index: number, replacement: Card): Stack {
  if (!Number.isInteger(index) || index < 0 || index >= stack.cards.length) {
    return stack;
  }
  return {
    ...stack,
    cards: stack.cards.map((card, i) => (i === index ? replacement : card)),
  };
}
