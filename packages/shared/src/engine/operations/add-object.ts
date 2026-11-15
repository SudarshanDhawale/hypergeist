import {
  LIMITS,
  ObjectSchema,
  checkAgainstSchema,
  createValidationError,
} from '../../format/index.ts';
import type { StackObject, ValidationError } from '../../format/index.ts';
import { deepCopyJson } from '../clone.ts';
import { collectEntityIds, nextEntityId } from '../ids.ts';
import { emptySummary, unknownEntityError } from '../operation-result.ts';
import { withCard } from '../stack-edit.ts';
import type { OperationDefinition } from './definition.ts';
import { OBJECT_DEFAULTS } from './object-defaults.ts';
import { AddObjectParamsSchema } from './params.ts';
import type { AddObjectParams } from './params.ts';

/**
 * `add_object`: inserts one Object into a Card at `index`, or at the end when `index` is
 * omitted. The candidate Object is the type's `OBJECT_DEFAULTS` row plus the supplied
 * properties, validated with `ObjectSchema`. That one check reports a missing required
 * property (`label`, `src`, `prompt`), a property the type does not define and a bad value,
 * with paths that already are parameter pointers.
 */
export const addObjectDefinition: OperationDefinition<AddObjectParams> = {
  name: 'add_object',
  schema: AddObjectParamsSchema,
  rangePaths: ['/index'],
  run: (stack, params) => {
    const { cardId, index, ...supplied } = params;
    const cardIndex = stack.cards.findIndex((candidate) => candidate.id === cardId);
    const card = stack.cards[cardIndex];
    if (card === undefined) {
      return {
        ok: false,
        errors: [
          unknownEntityError(
            '/cardId',
            cardId,
            'Card',
            stack.cards.map((candidate) => candidate.id),
          ),
        ],
      };
    }

    const used = collectEntityIds(stack);
    const objectCount = card.objects.length;
    const errors: ValidationError[] = [];

    if (objectCount >= LIMITS.objectsPerCard.max) {
      errors.push(
        createValidationError({
          code: 'LIMIT_EXCEEDED',
          path: '/cardId',
          message: `The Card already has the maximum of ${LIMITS.objectsPerCard.max} Objects.`,
          expected: `at most ${LIMITS.objectsPerCard.max} Objects on the Card after the Operation`,
          actual: objectCount,
          hint: 'Remove an Object from the Card, or add the Object to another Card.',
        }),
      );
    }

    if (index !== undefined && index > objectCount) {
      errors.push(
        createValidationError({
          code: 'OUT_OF_RANGE',
          path: '/index',
          message: `The index ${index} is above the number of Objects on the Card (${objectCount}).`,
          expected: `an integer from 0 through ${objectCount}`,
          actual: index,
          hint: `Use an index from 0 through ${objectCount}, or omit "index" to add the Object at the end.`,
        }),
      );
    }

    if (supplied.id !== undefined && used.has(supplied.id)) {
      errors.push(
        createValidationError({
          code: 'DUPLICATE_ID',
          path: '/id',
          message: `The id "${supplied.id}" is already used by a Card, an Object or a Link.`,
          expected: 'an Entity_ID that no Card, Object or Link of the Stack uses',
          actual: supplied.id,
          hint: 'Choose a different id, or omit "id" to get the next free "obj-<n>".',
        }),
      );
    }

    // The row and its arrays are copied, so the frozen table is never shared with a Stack.
    const row: Record<string, unknown> = deepCopyJson({ ...OBJECT_DEFAULTS[supplied.type] });
    const candidate: Record<string, unknown> = {
      id: supplied.id ?? nextEntityId(used, 'obj'),
      ...row,
    };
    for (const [key, value] of Object.entries(supplied)) {
      if (value !== undefined && key !== 'id') candidate[key] = deepCopyJson(value);
    }

    const checked = checkAgainstSchema(ObjectSchema, candidate);
    if (!checked.ok) errors.push(...checked.errors);
    if (errors.length > 0 || !checked.ok) return { ok: false, errors };

    const object: StackObject = checked.value;
    const position = index ?? objectCount;
    const objects = [...card.objects.slice(0, position), object, ...card.objects.slice(position)];
    const prefix = `/cards/${cardIndex}/objects/${position}`;

    return {
      ok: true,
      candidate: withCard(stack, cardIndex, { ...card, objects }),
      summary: { ...emptySummary(), created: [object.id] },
      mapPath: (pointer) => {
        if (pointer === prefix) return '';
        return pointer.startsWith(`${prefix}/`) ? pointer.slice(prefix.length) : undefined;
      },
    };
  },
};
