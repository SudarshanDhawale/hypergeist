import type { ValidationResult } from './errors.ts';
import { finalize, fromSemanticError } from './finalize.ts';
import { FORMAT_VERSION, LIMITS } from './limits.ts';
import { HandlerSchema, StackSchema } from './schemas.ts';
import type { Stack } from './schemas.ts';
import { buildEntityIndex, runSemanticPass, walkHandler } from './semantic.ts';
import { utf8ByteLength } from './text.ts';
import { ABSENT, mapZodIssues } from './zod-issues.ts';
import type { RawError } from './zod-issues.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A result with exactly one error at the root, built through the same path as every other result. */
function rootFailure(error: RawError, candidate: unknown): ValidationResult {
  return finalize([error], candidate);
}

/** Last resort for values that are not JSON data at all (cycles, throwing getters). */
function unreadable(candidate: unknown): ValidationResult {
  return rootFailure(
    {
      code: 'WRONG_TYPE',
      segments: [],
      message: 'The candidate could not be read as JSON data.',
      expected: 'JSON text or a plain JSON value',
      hint: 'Pass JSON text, or a value made only of objects, arrays, strings, numbers, booleans, and null.',
      actual: ABSENT,
    },
    candidate,
  );
}

function validateStackText(text: string): ValidationResult {
  if (utf8ByteLength(text) > LIMITS.maxDocumentBytes) {
    return rootFailure(
      {
        code: 'LIMIT_EXCEEDED',
        segments: [],
        message: `The text is longer than ${LIMITS.maxDocumentBytes} bytes in UTF-8.`,
        expected: `text of at most ${LIMITS.maxDocumentBytes} bytes in UTF-8`,
        hint: 'Shorten the document, for example by removing cards or long text values.',
        actual: text,
      },
      text,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return rootFailure(
      {
        code: 'INVALID_JSON',
        segments: [],
        message: `The text is not well-formed JSON: ${cause instanceof Error ? cause.message : 'parse failed'}.`,
        expected: 'well-formed JSON text',
        hint: 'Fix the JSON syntax, for example a missing quote, comma, or bracket.',
        actual: text,
      },
      text,
    );
  }
  return validateStackValue(parsed);
}

function validateStackValue(candidate: unknown): ValidationResult {
  if (!isRecord(candidate)) {
    return rootFailure(
      {
        code: 'WRONG_TYPE',
        segments: [],
        message: 'The stack must be a JSON object.',
        expected: 'a JSON object',
        hint: 'Wrap the stack in an object with the properties "formatVersion", "id", "name", and "cards".',
        actual: candidate === undefined ? ABSENT : candidate,
      },
      candidate,
    );
  }

  const version = Object.hasOwn(candidate, 'formatVersion') ? candidate['formatVersion'] : ABSENT;
  if (typeof version === 'number' && Number.isInteger(version) && version !== FORMAT_VERSION) {
    return rootFailure(
      {
        code: 'UNSUPPORTED_VERSION',
        segments: ['formatVersion'],
        message: `The format version ${String(version)} is not supported.`,
        expected: `formatVersion ${FORMAT_VERSION}`,
        hint: `Set "formatVersion" to ${FORMAT_VERSION}, the only supported version.`,
        actual: version,
      },
      candidate,
    );
  }

  const parsed = StackSchema.safeParse(candidate);
  const raws: RawError[] = parsed.success ? [] : mapZodIssues(parsed.error.issues, candidate);
  raws.push(...runSemanticPass(candidate).map(fromSemanticError));

  if (raws.length === 0) {
    const indented = `${JSON.stringify(candidate, null, 2)}\n`;
    if (utf8ByteLength(indented) > LIMITS.maxDocumentBytes) {
      return rootFailure(
        {
          code: 'LIMIT_EXCEEDED',
          segments: [],
          message: `The stack, written as indented JSON, is longer than ${LIMITS.maxDocumentBytes} bytes in UTF-8.`,
          expected: `a stack of at most ${LIMITS.maxDocumentBytes} bytes as indented JSON`,
          hint: 'Remove cards, objects, or long text values until the document is smaller.',
          actual: candidate,
        },
        candidate,
      );
    }
  }
  return finalize(raws, candidate);
}

/**
 * Validates a candidate Stack. A string is treated as JSON text. Never throws,
 * never modifies the candidate, and does no I/O.
 */
export function validateStack(candidate: unknown): ValidationResult {
  try {
    return typeof candidate === 'string'
      ? validateStackText(candidate)
      : validateStackValue(candidate);
  } catch {
    return unreadable(candidate);
  }
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
    return unreadable(candidate);
  }
}
