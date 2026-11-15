import { createValidationError } from '../../format/index.ts';
import type { Card, Link, StackObject } from '../../format/index.ts';
import { pruneHandler } from '../handler-prune.ts';
import { unknownEntityError } from '../operation-result.ts';
import type { OperationDefinition } from './definition.ts';
import { DeleteCardParamsSchema } from './params.ts';
import type { DeleteCardParams } from './params.ts';

/** What the cascade did to one remaining Card. */
type CardCascade = {
  readonly card: Card;
  readonly removedLinkIds: readonly string[];
  readonly updatedOwnerIds: readonly string[];
  readonly removedActions: number;
};

/**
 * Applies the cascade of a deleted Card to one remaining Card: drops Links that target the
 * deleted Card, prunes Button `onClick` Handlers and the `onOpen` Handler, and filters ai-field
 * `inputObjectIds`. A Card or Object that does not change keeps its identity. Owners that lost
 * entries are listed in document order: Objects in array order, then the Card (`onOpen`).
 */
function cascadeCard(card: Card, deletedCardId: string, deletedObjectIds: ReadonlySet<string>) {
  const isRemoved = (id: string): boolean => id === deletedCardId || deletedObjectIds.has(id);
  const updatedOwnerIds: string[] = [];
  let removedActions = 0;

  const keptLinks: Link[] = [];
  const removedLinkIds: string[] = [];
  for (const link of card.links) {
    if (link.targetCardId === deletedCardId) {
      removedLinkIds.push(link.id);
    } else {
      keptLinks.push(link);
    }
  }

  const objects = card.objects.map((object): StackObject => {
    if (object.type === 'button') {
      const pruned = pruneHandler(object.onClick, isRemoved);
      if (pruned.removed === 0) return object;
      removedActions += pruned.removed;
      updatedOwnerIds.push(object.id);
      return { ...object, onClick: pruned.handler };
    }
    if (object.type === 'ai-field') {
      const inputObjectIds = object.inputObjectIds.filter((id) => !deletedObjectIds.has(id));
      if (inputObjectIds.length === object.inputObjectIds.length) return object;
      updatedOwnerIds.push(object.id);
      return { ...object, inputObjectIds };
    }
    return object;
  });

  const onOpen = pruneHandler(card.onOpen, isRemoved);
  if (onOpen.removed > 0) {
    removedActions += onOpen.removed;
    updatedOwnerIds.push(card.id);
  }

  const unchanged =
    removedLinkIds.length === 0 &&
    updatedOwnerIds.length === 0 &&
    objects.every((object, i) => object === card.objects[i]);
  const result: CardCascade = {
    card: unchanged
      ? card
      : {
          ...card,
          objects,
          links: removedLinkIds.length === 0 ? card.links : keptLinks,
          onOpen: onOpen.handler,
        },
    removedLinkIds,
    updatedOwnerIds,
    removedActions,
  };
  return result;
}

/**
 * `delete_card`: removes a Card with its Objects and Links, then cleans the remaining Cards of
 * everything that referred to it (Links, Actions, ai-field inputs). When the start Card is
 * deleted, the Card at position 0 of the result becomes the start Card.
 */
export const deleteCardDefinition: OperationDefinition<DeleteCardParams> = {
  name: 'delete_card',
  schema: DeleteCardParamsSchema,
  rangePaths: [],
  run: (stack, params) => {
    const deleted = stack.cards.find((card) => card.id === params.cardId);
    if (deleted === undefined) {
      return {
        ok: false,
        errors: [
          unknownEntityError(
            '/cardId',
            params.cardId,
            'Card',
            stack.cards.map((card) => card.id),
          ),
        ],
      };
    }

    if (stack.cards.length === 1) {
      return {
        ok: false,
        errors: [
          createValidationError({
            code: 'LIMIT_EXCEEDED',
            path: '/cardId',
            message: 'The Stack has only one Card, and a Stack must keep at least one.',
            expected: 'a Stack with at least 2 Cards before the deletion',
            actual: params.cardId,
            hint: 'Create another Card first, or keep this Card.',
          }),
        ],
      };
    }

    const deletedObjectIds = new Set(deleted.objects.map((object) => object.id));
    const cascades = stack.cards
      .filter((card) => card !== deleted)
      .map((card) => cascadeCard(card, params.cardId, deletedObjectIds));
    const cards = cascades.map((cascade) => cascade.card);
    const [first] = cards;
    if (first === undefined) {
      // Unreachable: the Stack has at least two Cards, so one remains.
      throw new Error('delete_card: no Card remains');
    }

    return {
      ok: true,
      candidate: {
        ...stack,
        cards,
        startCardId: stack.startCardId === params.cardId ? first.id : stack.startCardId,
      },
      summary: {
        created: [],
        updated: cascades.flatMap((cascade) => cascade.updatedOwnerIds),
        removed: [
          deleted.id,
          ...deleted.objects.map((object) => object.id),
          ...deleted.links.map((link) => link.id),
          ...cascades.flatMap((cascade) => cascade.removedLinkIds),
        ],
        removedActions: cascades.reduce((sum, cascade) => sum + cascade.removedActions, 0),
      },
      mapPath: () => undefined,
    };
  },
};
