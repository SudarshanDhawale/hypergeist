import { parseStack } from '@hypergeist/shared/format';
import type { Stack, ValidationError } from '@hypergeist/shared/format';

import { suggestFreeId } from './free-id.ts';

/** Largest import file the app reads: 5 MB. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** How many Validation_Errors the app shows for a refused import. */
const MAX_SHOWN_ERRORS = 5;

export type ImportSizeCheck = { ok: true } | { ok: false; message: string };

export type ParseImportResult =
  | { ok: true; stack: Stack }
  | {
      ok: false;
      /** At most 5 errors. */
      errors: readonly ValidationError[];
      /** How many errors were left out of `errors`. */
      more: number;
    };

export type ImportPlan = { kind: 'new' } | { kind: 'conflict'; suggestedId: string };

/**
 * Checks the file size before the file is read into a parser. Exactly 5 MB is accepted.
 * A size that is not a finite non-negative number is refused.
 */
export function checkImportSize(bytes: number): ImportSizeCheck {
  if (Number.isFinite(bytes) && bytes >= 0 && bytes <= MAX_IMPORT_BYTES) {
    return { ok: true };
  }
  return {
    ok: false,
    message: 'This file is larger than 5 MB, so it was not opened. Stack files are much smaller.',
  };
}

const UNREADABLE: ValidationError = {
  code: 'INVALID_JSON',
  path: '',
  message: 'The file could not be read as a stack.',
  expected: 'a JSON text that describes a stack',
  actual: null,
  hint: 'Check that the file is a stack exported from HyperGeist.',
};

/**
 * Parses the text of an imported file. The text is untrusted: this function never throws,
 * and it does not store anything. Shows at most 5 errors and counts the rest in `more`.
 */
export function parseImport(text: string): ParseImportResult {
  let result: ReturnType<typeof parseStack>;
  try {
    result = parseStack(text);
  } catch {
    // parseStack never throws by contract. This keeps a bug there from reaching the caller.
    return { ok: false, errors: [UNREADABLE], more: 0 };
  }
  if (result.ok) {
    return { ok: true, stack: result.value };
  }
  const errors = result.errors.slice(0, MAX_SHOWN_ERRORS);
  const leftOut = result.errors.length - errors.length;
  // A truncated list means the validator stopped collecting; at least one more exists.
  const more = leftOut === 0 && result.truncated ? 1 : leftOut;
  return { ok: false, errors, more };
}

/**
 * Decides whether an imported stack can be stored under its own id. On a clash it suggests
 * a free id for a copy. Nothing is ever overwritten.
 */
export function planImport(
  stack: Stack,
  existingIds: ReadonlySet<string> | readonly string[],
): ImportPlan {
  const taken: ReadonlySet<string> =
    existingIds instanceof Set ? existingIds : new Set(existingIds);
  if (!taken.has(stack.id)) {
    return { kind: 'new' };
  }
  return { kind: 'conflict', suggestedId: suggestFreeId(stack.id, taken) };
}
