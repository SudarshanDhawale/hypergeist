import { createValidationError, validateHandler } from '../../format/index.ts';
import type { Card, Stack, StackObject } from '../../format/index.ts';
import { emptySummary, unknownEntityError } from '../operation-result.ts';
import type { OperationDefinition } from './definition.ts';
import { SetActionParamsSchema } from './params.ts';
import type { SetActionParams } from './params.ts';

/** The ids a `set_action` owner can have: every Button and every Card. */
function ownerIds(stack: Stack): readonly string[] {
  return stack.cards.flatMap((card) => [
    card.id,
    ...card.objects.filter((object) => object.type === 'button').map((object) => object.id),
  ]);
}

/** What kind of Entity an id names, or `undefined` when it names none. */
function entityKind(stack: Stack, id: string): 'card' | 'button' | 'object' | 'link' | undefined {
  for (const card of stack.cards) {
    if (card.id === id) return 'card';
    for (const object of card.objects) {
      if (object.id === id) return object.type === 'button' ? 'button' : 'object';
    }
    if (card.links.some((link) => link.id === id)) return 'link';
  }
  return undefined;
}

/**
 * `set_action`: replaces the whole `onClick` of a Button or the whole `onOpen` of a Card with
 * the supplied Handler. The Handler is checked with `validateHandler`; on any error no
 * candidate is returned, so the owner keeps its Handler. The Handler is replaced, not merged,
 * so applying the same call twice gives the same Stack.
 */
export const setActionDefinition: OperationDefinition<SetActionParams> = {
  name: 'set_action',
  schema: SetActionParamsSchema,
  rangePaths: [],
  run: (stack, params) => {
    const { ownerId, handler } = params;
    const kind = entityKind(stack, ownerId);

    if (kind === undefined) {
      return {
        ok: false,
        errors: [unknownEntityError('/ownerId', ownerId, 'Button or Card', ownerIds(stack))],
      };
    }
    if (kind === 'object' || kind === 'link') {
      return {
        ok: false,
        errors: [
          createValidationError({
            code: 'WRONG_REFERENCE_TYPE',
            path: '/ownerId',
            message: `The id "${ownerId}" names a ${kind === 'link' ? 'Link' : 'Object that is not a Button'}, which has no Handler.`,
            expected: 'the id of a Button (onClick) or a Card (onOpen)',
            actual: ownerId,
            hint: 'Use the id of a Button or a Card. Only Buttons and Cards have a Handler.',
          }),
        ],
      };
    }

    const checked = validateHandler(stack, handler);
    if (!checked.valid) {
      return {
        ok: false,
        errors: checked.errors.map((error) => ({ ...error, path: `/handler${error.path}` })),
      };
    }

    let ownerPath = '';
    const cards = stack.cards.map((card, cardIndex): Card => {
      if (kind === 'card' && card.id === ownerId) {
        ownerPath = `/cards/${cardIndex}/onOpen`;
        return { ...card, onOpen: handler };
      }
      if (kind === 'button') {
        const objectIndex = card.objects.findIndex((object) => object.id === ownerId);
        if (objectIndex >= 0) {
          ownerPath = `/cards/${cardIndex}/objects/${objectIndex}/onClick`;
          return {
            ...card,
            objects: card.objects.map((object, index): StackObject =>
              index === objectIndex && object.type === 'button'
                ? { ...object, onClick: handler }
                : object,
            ),
          };
        }
      }
      return card;
    });

    const prefix = ownerPath;
    return {
      ok: true,
      candidate: { ...stack, cards },
      summary: { ...emptySummary(), updated: [ownerId] },
      mapPath: (pointer) => {
        if (pointer === prefix) return '/handler';
        if (pointer.startsWith(`${prefix}/`)) return `/handler${pointer.slice(prefix.length)}`;
        return undefined;
      },
    };
  },
};
