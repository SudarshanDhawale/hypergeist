import { z } from 'zod';
import { createValidationError } from '../../format/index.ts';
import type { Stack } from '../../format/index.ts';
import { rejected } from '../operation-result.ts';
import type { OperationResult } from '../operation-result.ts';
import { addObjectDefinition } from './add-object.ts';
import { createCardDefinition } from './create-card.ts';
import { runDefinition } from './definition.ts';
import type { OperationDefinition, OperationName } from './definition.ts';
import { deleteCardDefinition } from './delete-card.ts';
import { linkCardsDefinition } from './link-cards.ts';
import {
  AddObjectParamsSchema,
  CreateCardParamsSchema,
  DeleteCardParamsSchema,
  LinkCardsParamsSchema,
  RemoveObjectParamsSchema,
  SetActionParamsSchema,
  UpdateObjectParamsSchema,
} from './params.ts';
import type {
  AddObjectParams,
  CreateCardParams,
  DeleteCardParams,
  LinkCardsParams,
  RemoveObjectParams,
  SetActionParams,
  UpdateObjectParams,
} from './params.ts';
import { removeObjectDefinition } from './remove-object.ts';
import { setActionDefinition } from './set-action.ts';
import { updateObjectDefinition } from './update-object.ts';

export type { OperationName } from './definition.ts';

/** The seven Operation names, in the order of the design. */
export const OPERATION_NAMES = [
  'create_card',
  'delete_card',
  'add_object',
  'update_object',
  'remove_object',
  'link_cards',
  'set_action',
] as const;

/** The parameters of each Operation, derived from the Zod schemas in `params.ts`. */
export type OperationParams = {
  create_card: CreateCardParams;
  delete_card: DeleteCardParams;
  add_object: AddObjectParams;
  update_object: UpdateObjectParams;
  remove_object: RemoveObjectParams;
  link_cards: LinkCardsParams;
  set_action: SetActionParams;
};

/* Compile-time check: `OPERATION_NAMES` and the `OperationName` union list the same names. */
type SameNames = [OperationName] extends [(typeof OPERATION_NAMES)[number]]
  ? [(typeof OPERATION_NAMES)[number]] extends [OperationName]
    ? true
    : never
  : never;
const namesMatch: SameNames = true;
void namesMatch;

/** One definition per name. Looked up with an own-property check, see `isOperationName`. */
const DEFINITIONS: { readonly [N in OperationName]: OperationDefinition<OperationParams[N]> } = {
  create_card: createCardDefinition,
  delete_card: deleteCardDefinition,
  add_object: addObjectDefinition,
  update_object: updateObjectDefinition,
  remove_object: removeObjectDefinition,
  link_cards: linkCardsDefinition,
  set_action: setActionDefinition,
};

/**
 * The plain parameter schemas, used for the descriptions and the JSON Schema. They are not
 * always the schema a definition runs: the `update_object` definition runs a Zod pipe (a
 * pre-pass, then `UpdateObjectParamsSchema`) that has no JSON Schema form with a root object.
 */
const PARAM_SCHEMAS: { readonly [N in OperationName]: z.ZodType<OperationParams[N]> } = {
  create_card: CreateCardParamsSchema,
  delete_card: DeleteCardParamsSchema,
  add_object: AddObjectParamsSchema,
  update_object: UpdateObjectParamsSchema,
  remove_object: RemoveObjectParamsSchema,
  link_cards: LinkCardsParamsSchema,
  set_action: SetActionParamsSchema,
};

/** True when `name` is one of the seven names. Own-property, so `constructor` and `__proto__` fail. */
function isOperationName(name: string): name is OperationName {
  return Object.hasOwn(DEFINITIONS, name);
}

function runNamed<N extends OperationName>(
  stack: Stack,
  name: N,
  params: unknown,
): OperationResult {
  return runDefinition(DEFINITIONS[name], stack, params);
}

/**
 * The only way to apply an Operation. `name` and `params` are loosely typed because they arrive
 * from model tool calls. An unknown name is rejected with `INVALID_VALUE` at `/operation`.
 * Otherwise the three stages of `runDefinition` run. Never throws for any parameters, and a
 * rejection never carries a Stack. `stack` must be a valid Stack.
 */
export function applyOperation(stack: Stack, name: string, params: unknown): OperationResult {
  if (!isOperationName(name)) {
    return rejected([
      createValidationError({
        code: 'INVALID_VALUE',
        path: '/operation',
        message: 'The operation name is not one of the Operations.',
        expected: `one of ${OPERATION_NAMES.join(', ')}`,
        actual: name,
        hint: `Use one of these operation names: ${OPERATION_NAMES.join(', ')}.`,
      }),
    ]);
  }
  return runNamed(stack, name, params);
}

export type OperationInfo = {
  readonly name: OperationName;
  /** The same text as the top-level `description` of the JSON Schema. */
  readonly description: string;
  readonly schema: z.ZodType;
};

/** Exactly seven entries, one per name, in the order of `OPERATION_NAMES`. */
export const OPERATIONS: readonly OperationInfo[] = Object.freeze(
  OPERATION_NAMES.map((name): OperationInfo => {
    const schema = PARAM_SCHEMAS[name];
    return Object.freeze({ name, description: schema.description ?? '', schema });
  }),
);

export type OperationJsonSchema = z.core.JSONSchema.BaseSchema;

/** A fresh JSON Schema document (draft 2020-12) of one Operation's parameters, on each call. */
export function operationJsonSchema(name: OperationName): OperationJsonSchema {
  if (!isOperationName(name)) {
    // Not reachable with the type system; a programmer error, so it throws.
    throw new RangeError(`Unknown operation name: ${String(name)}`);
  }
  return z.toJSONSchema(PARAM_SCHEMAS[name]);
}
