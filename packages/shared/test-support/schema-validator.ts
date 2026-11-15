/**
 * An independent JSON Schema draft 2020-12 validator for tests.
 *
 * It wraps `ajv` (a dev dependency of this package, used by tests only) so the schema
 * tests do not depend on Zod to judge Zod's own output. Never import this file, or `ajv`,
 * from `src/`.
 *
 * `ajv/dist/2020.js` is CommonJS. Its `module.exports` is the `Ajv2020` class and it also sets
 * `exports.default`, so the default import is the class both under TypeScript's bundler
 * resolution and under Node's ESM-to-CJS interop in Vitest.
 */
import Ajv2020 from 'ajv/dist/2020.js';

/** `strict: false` because Zod emits annotation keywords Ajv strict mode would reject. */
function createAjv(): Ajv2020 {
  return new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
}

/** The outcome of checking one JSON value against a compiled schema. */
export type SchemaCheck =
  { readonly valid: true } | { readonly valid: false; readonly errors: readonly string[] };

export type CompiledSchema = (data: unknown) => SchemaCheck;

export type SchemaValidator = {
  /** True when `schema` is itself a valid draft 2020-12 schema (checked against the meta-schema). */
  readonly isValidSchema: (schema: unknown) => boolean;
  /** Compiles `schema` (throws if it cannot be compiled) and returns a checker for data. */
  readonly compile: (schema: object) => CompiledSchema;
};

/** Creates a validator with its own Ajv instance, so compiled schemas never leak between callers. */
export function createSchemaValidator(): SchemaValidator {
  const ajv = createAjv();
  return {
    isValidSchema: (schema) => ajv.validateSchema(schema as object) === true,
    compile: (schema) => {
      const validate = ajv.compile(schema);
      return (data) => {
        if (validate(data)) {
          return { valid: true };
        }
        const errors = (validate.errors ?? []).map(
          (error) =>
            `${error.instancePath === '' ? '(root)' : error.instancePath} ${error.message ?? 'is invalid'}`,
        );
        return { valid: false, errors };
      };
    },
  };
}
