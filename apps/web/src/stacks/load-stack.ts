import { parseStack } from '@hypergeist/shared/format';
import type { Stack, ValidationError } from '@hypergeist/shared/format';

export type LoadStackResult =
  | { readonly ok: true; readonly stack: Stack }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/**
 * Parses the bundled Stack text at startup. `parseStack` validates the text and returns
 * the typed Stack, or structured errors, without throwing.
 */
export function loadStack(text: string): LoadStackResult {
  const result = parseStack(text);
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }
  return { ok: true, stack: result.value };
}
