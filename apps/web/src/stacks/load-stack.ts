import { StackSchema, validateStack } from '@hypergeist/shared/format';
import type { Stack, ValidationError } from '@hypergeist/shared/format';

export type LoadStackResult =
  | { readonly ok: true; readonly stack: Stack }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/**
 * Validates the bundled Stack text at startup. The validator runs first and reports
 * structured errors. For valid text, a second parse with `StackSchema` gives a typed
 * value without a cast. That second parse cannot fail once `validateStack` accepted the text.
 */
export function loadStack(text: string): LoadStackResult {
  const result = validateStack(text);
  if (!result.valid) {
    return { ok: false, errors: result.errors };
  }
  return { ok: true, stack: StackSchema.parse(JSON.parse(text)) };
}
