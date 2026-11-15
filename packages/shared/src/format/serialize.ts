import { checkValue } from './check.ts';
import type { ValidationError } from './errors.ts';

export type SerializeResult =
  | { readonly ok: true; readonly value: string }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
      readonly truncated: boolean;
    };

/**
 * Writes a Stack as Canonical_JSON: two-space indentation, keys in the documented order, one
 * trailing newline. Takes `unknown` because a value typed `Stack` can still break a
 * cross-entity rule. A string is not a Stack, so it gives one `WRONG_TYPE` at `""` and is
 * never parsed. Never throws.
 */
export function serializeStack(stack: unknown): SerializeResult {
  const checked = checkValue(stack);
  if (checked.result.valid && checked.canonical !== undefined) {
    return { ok: true, value: checked.canonical };
  }
  return { ok: false, errors: checked.result.errors, truncated: checked.result.truncated };
}
