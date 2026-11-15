import { checkInput, unreadableResult } from './check.ts';
import type { ValidationResult } from './errors.ts';
import { finalize, fromSemanticError } from './finalize.ts';
import { HandlerSchema } from './schemas.ts';
import type { Stack } from './schemas.ts';
import { buildEntityIndex, walkHandler } from './semantic.ts';
import { mapZodIssues } from './zod-issues.ts';
import type { RawError } from './zod-issues.ts';

/**
 * Validates a candidate Stack. A string is treated as JSON text. Never throws,
 * never modifies the candidate, and does no I/O.
 */
export function validateStack(candidate: unknown): ValidationResult {
  return checkInput(candidate).result;
}

/**
 * Validates a candidate Handler against a Stack that supplies the entity ids.
 * Error paths are relative to the Handler, so the root is `""`. Never throws.
 */
export function validateHandler(stack: Stack, candidate: unknown): ValidationResult {
  try {
    const parsed = HandlerSchema.safeParse(candidate);
    const raws: RawError[] = parsed.success ? [] : mapZodIssues(parsed.error.issues, candidate);
    const { index } = buildEntityIndex(stack);
    raws.push(...walkHandler(candidate, [], index).map(fromSemanticError));
    return finalize(raws, candidate);
  } catch {
    return unreadableResult(candidate);
  }
}
