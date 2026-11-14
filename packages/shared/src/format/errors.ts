/**
 * The closed set of Validation_Error codes. It equals the set in the
 * stack-format-and-validator spec. The slice validator never returns
 * `OUT_OF_RANGE` or `UNKNOWN_ENTITY`; the engine reuses them for rejected operations.
 */
export const VALIDATION_ERROR_CODES = [
  'INVALID_JSON',
  'MISSING_PROPERTY',
  'UNKNOWN_PROPERTY',
  'WRONG_TYPE',
  'INVALID_VALUE',
  'OUT_OF_RANGE',
  'DUPLICATE_ID',
  'DANGLING_REFERENCE',
  'WRONG_REFERENCE_TYPE',
  'OUT_OF_BOUNDS',
  'LIMIT_EXCEEDED',
  'UNSUPPORTED_VERSION',
  'DUPLICATE_LINK',
  'UNKNOWN_ENTITY',
] as const;

export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];

/** Machine-readable error. Plain TypeScript: no Zod schema describes it. */
export type ValidationError = {
  readonly code: ValidationErrorCode;
  /** RFC 6901 JSON Pointer. The root is the empty string. */
  readonly path: string;
  readonly message: string;
  readonly expected: string;
  /** The offending value as JSON, cut to 200 code points. `null` when the property is absent. */
  readonly actual: string | null;
  readonly hint: string;
};

export type ValidationResult = {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
  readonly truncated: boolean;
};
