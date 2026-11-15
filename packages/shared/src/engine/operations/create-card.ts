import { LIMITS, createValidationError } from '../../format/index.ts';
import type { Card, ValidationError } from '../../format/index.ts';
import { collectEntityIds, nextEntityId } from '../ids.ts';
import { emptySummary } from '../operation-result.ts';
import type { OperationDefinition } from './definition.ts';
import { CreateCardParamsSchema } from './params.ts';
import type { CreateCardParams } from './params.ts';

/**
 * `create_card`: inserts an empty Card at `index`, or at the end when `index` is omitted.
 * `startCardId` does not change. All precondition errors are collected.
 */
export const createCardDefinition: OperationDefinition<CreateCardParams> = {
  name: 'create_card',
  schema: CreateCardParamsSchema,
  rangePaths: ['/index'],
  run: (stack, params) => {
    const used = collectEntityIds(stack);
    const cardCount = stack.cards.length;
    const errors: ValidationError[] = [];

    if (params.id !== undefined && used.has(params.id)) {
      errors.push(
        createValidationError({
          code: 'DUPLICATE_ID',
          path: '/id',
          message: `The id "${params.id}" is already used by a Card, an Object or a Link.`,
          expected: 'an Entity_ID that no Card, Object or Link of the Stack uses',
          actual: params.id,
          hint: 'Choose a different id, or omit "id" to get the next free "card-<n>".',
        }),
      );
    }

    if (cardCount >= LIMITS.cards.max) {
      errors.push(
        createValidationError({
          code: 'LIMIT_EXCEEDED',
          path: '',
          message: `The Stack already has the maximum of ${LIMITS.cards.max} Cards.`,
          expected: `at most ${LIMITS.cards.max} Cards after the Operation`,
          actual: cardCount,
          hint: 'Delete a Card before creating a new one.',
        }),
      );
    }

    if (params.index !== undefined && params.index > cardCount) {
      errors.push(
        createValidationError({
          code: 'OUT_OF_RANGE',
          path: '/index',
          message: `The index ${params.index} is above the number of Cards (${cardCount}).`,
          expected: `an integer from 0 through ${cardCount}`,
          actual: params.index,
          hint: `Use an index from 0 through ${cardCount}, or omit "index" to add the Card at the end.`,
        }),
      );
    }

    if (errors.length > 0) return { ok: false, errors };

    const id = params.id ?? nextEntityId(used, 'card');
    const index = params.index ?? cardCount;
    const card: Card = { id, name: params.name, objects: [], links: [], onOpen: [] };

    return {
      ok: true,
      candidate: {
        ...stack,
        cards: [...stack.cards.slice(0, index), card, ...stack.cards.slice(index)],
      },
      summary: { ...emptySummary(), created: [id] },
      mapPath: () => undefined,
    };
  },
};
