import { z } from 'zod';
import {
  AiFieldSchema,
  ButtonSchema,
  FieldSchema,
  ImageSchema,
  ListSchema,
  ObjectSchema,
  checkAgainstSchema,
  createValidationError,
} from '../../format/index.ts';
import type { StackObject, ValidationError } from '../../format/index.ts';
import { emptySummary, unknownEntityError } from '../operation-result.ts';
import { withObject } from '../stack-edit.ts';
import type { OperationDefinition } from './definition.ts';
import { UpdateObjectParamsSchema } from './params.ts';
import type { UpdateObjectParams } from './params.ts';

/** The properties each Object type defines, read from the type's Zod `.shape`. */
const PROPERTIES_BY_TYPE: Readonly<Record<StackObject['type'], Readonly<Record<string, unknown>>>> =
  {
    button: ButtonSchema.shape,
    field: FieldSchema.shape,
    list: ListSchema.shape,
    image: ImageSchema.shape,
    'ai-field': AiFieldSchema.shape,
  };

/** Properties that an Object keeps for its whole life. */
const FIXED_KEYS = ['id', 'type'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The pre-pass of the design: it runs on the raw parameters, before the strict schema. Without
 * it the strict `changes` object would report `UNKNOWN_PROPERTY` for `id` and `type`, and
 * Requirement 3.5 asks for `INVALID_VALUE`. The pre-pass is the first stage of the schema that
 * `runDefinition` runs as stage A, because a Zod pipe stops at the first stage that fails.
 * An issue of this stage maps to `INVALID_VALUE` at the issue path.
 */
const changesPrePass = z.unknown().superRefine((params, ctx) => {
  if (!isRecord(params)) return;
  const { changes } = params;
  if (!isRecord(changes)) return;
  for (const key of FIXED_KEYS) {
    if (Object.hasOwn(changes, key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['changes', key],
        message: `The property "${key}" of an Object cannot be changed. Remove "${key}" from changes.`,
      });
    }
  }
});

/** The `schema` of the definition: the pre-pass, then `UpdateObjectParamsSchema`. */
const UpdateObjectStageASchema: z.ZodType<UpdateObjectParams> =
  changesPrePass.pipe(UpdateObjectParamsSchema);

/** Where the Object sits in the Stack, for the path mapping. */
type Located = {
  readonly cardIndex: number;
  readonly objectIndex: number;
  readonly object: StackObject;
};

function locate(
  cards: readonly { readonly objects: readonly StackObject[] }[],
  objectId: string,
): Located | undefined {
  for (const [cardIndex, card] of cards.entries()) {
    const objectIndex = card.objects.findIndex((object) => object.id === objectId);
    const object = card.objects[objectIndex];
    if (object !== undefined) return { cardIndex, objectIndex, object };
  }
  return undefined;
}

/**
 * `update_object`: replaces the named properties of one Object and keeps every other property.
 * Empty `changes` return the input Stack. The merged Object is validated with `ObjectSchema`,
 * and the whole candidate by stage C (bounds, for example).
 */
export const updateObjectDefinition: OperationDefinition<UpdateObjectParams> = {
  name: 'update_object',
  schema: UpdateObjectStageASchema,
  rangePaths: [],
  run: (stack, params) => {
    const located = locate(stack.cards, params.objectId);
    if (located === undefined) {
      const objectIds = stack.cards.flatMap((card) => card.objects.map((object) => object.id));
      return {
        ok: false,
        errors: [unknownEntityError('/objectId', params.objectId, 'Object', objectIds)],
      };
    }
    const { object, cardIndex, objectIndex } = located;

    // A key whose value is `undefined` names no change (JSON has no `undefined`).
    const named = Object.entries(params.changes).filter(([, value]) => value !== undefined);
    if (named.length === 0) {
      return { ok: true, candidate: stack, summary: emptySummary(), mapPath: () => undefined };
    }

    const defined = PROPERTIES_BY_TYPE[object.type];
    const errors: ValidationError[] = [];
    const known: [string, unknown][] = [];
    for (const [key, value] of named) {
      if (Object.hasOwn(defined, key)) {
        known.push([key, value]);
      } else {
        errors.push(
          createValidationError({
            code: 'UNKNOWN_PROPERTY',
            path: `/changes/${key}`,
            message: `The property "${key}" is not defined for an Object of type "${object.type}".`,
            expected: `only properties of the "${object.type}" type: ${Object.keys(defined)
              .filter((property) => !(FIXED_KEYS as readonly string[]).includes(property))
              .join(', ')}`,
            actual: value,
            hint: `Remove "${key}" from changes, or change an Object of a type that has it.`,
          }),
        );
      }
    }

    const merged: unknown = { ...object, ...Object.fromEntries(known) };
    const checked = checkAgainstSchema(ObjectSchema, merged);
    if (!checked.ok) {
      errors.push(...checked.errors.map((error) => ({ ...error, path: `/changes${error.path}` })));
    }
    if (errors.length > 0 || !checked.ok) return { ok: false, errors };

    const objectPointer = `/cards/${cardIndex}/objects/${objectIndex}`;
    return {
      ok: true,
      candidate: withObject(stack, object, checked.value),
      summary: { ...emptySummary(), updated: [params.objectId] },
      mapPath: (stackPointer) => {
        if (stackPointer === objectPointer) return '/changes';
        if (stackPointer.startsWith(`${objectPointer}/`)) {
          return `/changes${stackPointer.slice(objectPointer.length)}`;
        }
        return undefined;
      },
    };
  },
};
