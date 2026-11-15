import type { z } from 'zod';
import { checkAgainstSchema, validateStack } from '../../format/index.ts';
import type { Stack, ValidationError } from '../../format/index.ts';
import { rejected, remapErrors } from '../operation-result.ts';
import type { OperationResult, OperationSummary } from '../operation-result.ts';

/**
 * The seven Operation names. `operations/index.ts` holds the matching runtime list
 * (`OPERATION_NAMES`). The type lives here so the per-operation files and the index do not
 * import each other in a cycle.
 */
export type OperationName =
  | 'create_card'
  | 'delete_card'
  | 'add_object'
  | 'update_object'
  | 'remove_object'
  | 'link_cards'
  | 'set_action';

/**
 * What stage B of an Operation returns: a candidate Stack with a summary and a mapping from
 * Stack pointers to parameter pointers (used if stage C rejects the candidate), or errors that
 * already point into the parameters.
 */
export type RunOutcome =
  | {
      readonly ok: true;
      readonly candidate: Stack;
      readonly summary: OperationSummary;
      readonly mapPath: (stackPointer: string) => string | undefined;
    }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/** The internal contract of one Operation module. Not exported from the package. */
export type OperationDefinition<P> = {
  readonly name: OperationName;
  readonly schema: z.ZodType<P>;
  /** Passed to `checkAgainstSchema` as `rangePaths`. */
  readonly rangePaths: readonly string[];
  /**
   * Stage B. Pure. Receives parsed parameters, checks preconditions and returns a candidate.
   * It never validates the whole Stack itself.
   */
  readonly run: (stack: Stack, params: P) => RunOutcome;
};

/**
 * The single door every Operation goes through, in three stages:
 *
 * - A: the parameter schema (`checkAgainstSchema`). Errors point into the parameters.
 * - B: the Operation's own logic (`definition.run`): preconditions and the candidate Stack.
 * - C: `validateStack` on the candidate, as a safety net. Its errors are remapped to parameter
 *   pointers through `mapPath`, and a pointer that cannot be mapped becomes `/stack` plus the
 *   Stack pointer.
 *
 * A rejection never carries a Stack, so no change is partly applied. The input Stack is never
 * modified. `checkAgainstSchema` and `validateStack` do not throw, and an exception from `run`
 * is a programmer error that is not hidden here.
 */
export function runDefinition<P>(
  definition: OperationDefinition<P>,
  stack: Stack,
  params: unknown,
): OperationResult {
  const parsed = checkAgainstSchema(definition.schema, params, {
    rangePaths: definition.rangePaths,
  });
  if (!parsed.ok) return rejected(parsed.errors, parsed.truncated);

  const outcome = definition.run(stack, parsed.value);
  if (!outcome.ok) return rejected(outcome.errors);

  const checked = validateStack(outcome.candidate);
  if (!checked.valid) {
    return rejected(remapErrors(checked.errors, outcome.mapPath), checked.truncated);
  }
  return { ok: true, stack: outcome.candidate, summary: outcome.summary };
}
