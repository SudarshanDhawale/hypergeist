import { z } from 'zod';
import { StackSchema } from './schemas.ts';

/** A JSON Schema document (draft 2020-12) as produced by `z.toJSONSchema`. */
export type JsonSchemaDocument = ReturnType<typeof z.toJSONSchema<typeof StackSchema>>;

/**
 * The JSON Schema (draft 2020-12) for a Stack. It describes structure only; cross-entity
 * rules stay in the semantic validator. It uses Zod's default `unrepresentable: "throw"`, so a
 * future schema that cannot be represented fails a test instead of becoming `{}`.
 * Every call returns a fresh object, so callers cannot change shared state.
 */
export function stackJsonSchema(): JsonSchemaDocument {
  return z.toJSONSchema(StackSchema);
}
