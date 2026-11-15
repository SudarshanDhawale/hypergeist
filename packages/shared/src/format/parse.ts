import { checkInput } from './check.ts';
import type { ValidationError } from './errors.ts';
import type { Stack } from './schemas.ts';

export type ParseResult =
  | { readonly ok: true; readonly value: Stack }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
      readonly truncated: boolean;
    };

/**
 * Parses and validates a Stack. A string is JSON text; any other value is a candidate object
 * (for IndexedDB reads and model tool calls). Follows the same pipeline as `validateStack`, so
 * `ok` is true exactly when the candidate is valid. Never throws.
 */
export function parseStack(input: unknown): ParseResult {
  const checked = checkInput(input);
  if (checked.result.valid && checked.stack !== undefined) {
    return { ok: true, value: checked.stack };
  }
  return { ok: false, errors: checked.result.errors, truncated: checked.result.truncated };
}
