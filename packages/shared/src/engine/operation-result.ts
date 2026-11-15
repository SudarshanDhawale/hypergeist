import { createValidationError } from '../format/index.ts';
import type { Stack, ValidationError } from '../format/index.ts';

/** How many valid ids an UNKNOWN_ENTITY hint lists before it cuts the list. */
const MAX_HINT_IDS = 20;

export type OperationSummary = {
  /** Entities created by the Operation, each id at most once. */
  readonly created: readonly string[];
  /** Entities that changed, including owners whose Handler or inputs lost entries in a cascade. */
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  /** Number of Actions removed from remaining Handlers. 0 when none. */
  readonly removedActions: number;
};

export type OperationResult =
  | { readonly ok: true; readonly stack: Stack; readonly summary: OperationSummary }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
      readonly truncated: boolean;
    };

/** A summary for an Operation that produced nothing. */
export function emptySummary(): OperationSummary {
  return { created: [], updated: [], removed: [], removedActions: 0 };
}

/** A rejected result. It has no `stack` property. */
export function rejected(
  errors: readonly ValidationError[],
  truncated: boolean = false,
): OperationResult {
  return { ok: false, errors, truncated };
}

/**
 * The error for an id that names no entity of the wanted kind (`kind` is for example "Card" or
 * "Object"). The hint lists up to 20 of `validIds`, then says how many more exist.
 */
export function unknownEntityError(
  path: string,
  id: unknown,
  kind: string,
  validIds: readonly string[],
): ValidationError {
  const listed = validIds.slice(0, MAX_HINT_IDS);
  const rest = validIds.length - listed.length;
  const hint =
    validIds.length === 0
      ? `The Stack has no ${kind} to refer to.`
      : `Use one of these ${kind} ids: ${listed.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.`;
  return createValidationError({
    code: 'UNKNOWN_ENTITY',
    path,
    message: `The value does not name an existing ${kind}.`,
    expected: `the id of an existing ${kind}`,
    actual: id,
    hint,
  });
}

/**
 * Maps errors from a candidate Stack back to the parameters that caused them. `mapPath` is the
 * per-operation mapping from a Stack pointer to a parameter pointer. A pointer it cannot map
 * becomes `/stack` plus the Stack pointer. Code, message, expected, actual and hint are kept.
 */
export function remapErrors(
  errors: readonly ValidationError[],
  mapPath: (stackPointer: string) => string | undefined,
): readonly ValidationError[] {
  return errors.map((error) => ({
    ...error,
    path: mapPath(error.path) ?? `/stack${error.path}`,
  }));
}
