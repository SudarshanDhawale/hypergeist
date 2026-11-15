import type { Card, StackObject } from '../../format/index.ts';
import { pruneHandler } from '../handler-prune.ts';
import { unknownEntityError } from '../operation-result.ts';
import type { OperationDefinition } from './definition.ts';
import { RemoveObjectParamsSchema } from './params.ts';
import type { RemoveObjectParams } from './params.ts';

/**
 * `remove_object`: removes one Object, prunes every Action that refers to it (`targetObjectId`,
 * `fromObjectId`, `atFromObjectId`) from every Button `onClick` and every Card `onOpen`, and
 * drops its id from every ai-field `inputObjectIds`. Entities that lose nothing keep their
 * identity.
 */
export const removeObjectDefinition: OperationDefinition<RemoveObjectParams> = {
  name: 'remove_object',
  schema: RemoveObjectParamsSchema,
  rangePaths: [],
  run: (stack, params) => {
    const { objectId } = params;
    const objectIds = stack.cards.flatMap((card) => card.objects.map((object) => object.id));
    if (!objectIds.includes(objectId)) {
      return {
        ok: false,
        errors: [unknownEntityError('/objectId', objectId, 'Object', objectIds)],
      };
    }

    const isRemoved = (referencedId: string): boolean => referencedId === objectId;
    const updated: string[] = [];
    let removedActions = 0;

    const cards = stack.cards.map((card): Card => {
      const onOpen = pruneHandler(card.onOpen, isRemoved);
      let objectsChanged = false;
      const objects: StackObject[] = [];

      for (const object of card.objects) {
        if (object.id === objectId) {
          objectsChanged = true;
          continue;
        }
        if (object.type === 'button') {
          const pruned = pruneHandler(object.onClick, isRemoved);
          if (pruned.removed > 0) {
            removedActions += pruned.removed;
            updated.push(object.id);
            objectsChanged = true;
            objects.push({ ...object, onClick: pruned.handler });
            continue;
          }
        } else if (object.type === 'ai-field' && object.inputObjectIds.includes(objectId)) {
          updated.push(object.id);
          objectsChanged = true;
          objects.push({
            ...object,
            inputObjectIds: object.inputObjectIds.filter((id) => id !== objectId),
          });
          continue;
        }
        objects.push(object);
      }

      if (onOpen.removed > 0) {
        removedActions += onOpen.removed;
        updated.push(card.id);
      }
      if (!objectsChanged && onOpen.removed === 0) return card;
      return {
        ...card,
        objects: objectsChanged ? objects : card.objects,
        onOpen: onOpen.handler,
      };
    });

    return {
      ok: true,
      candidate: { ...stack, cards },
      summary: { created: [], updated, removed: [objectId], removedActions },
      mapPath: () => undefined,
    };
  },
};
