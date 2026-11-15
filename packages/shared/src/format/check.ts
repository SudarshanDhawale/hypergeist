import type { ValidationResult } from './errors.ts';
import { finalize, fromSemanticError } from './finalize.ts';
import { findJsonSyntaxError } from './json-text.ts';
import type { JsonSyntaxError } from './json-text.ts';
import { FORMAT_VERSION, LIMITS } from './limits.ts';
import { StackSchema } from './schemas.ts';
import type { Stack } from './schemas.ts';
import { runSemanticPass } from './semantic.ts';
import { utf8ByteLength } from './text.ts';
import { ABSENT, mapZodIssues } from './zod-issues.ts';
import type { RawError } from './zod-issues.ts';

/**
 * The shared validation pipeline behind `validateStack`, `parseStack`, and `serializeStack`.
 * Nothing here throws, modifies the candidate, or does I/O.
 */

/**
 * What one run of the pipeline produces. `stack` and `canonical` are present only when
 * `result.valid` is true. `stack` is the Zod output (keys in canonical order) and `canonical`
 * is `JSON.stringify(stack, null, 2)` plus one newline.
 */
export type Checked = {
  readonly result: ValidationResult;
  readonly stack?: Stack;
  readonly canonical?: string;
};

/** A failed run: only the result. */
function failed(result: ValidationResult): Checked {
  return { result };
}

const BYTE_ORDER_MARK = 0xfeff;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A result with exactly one error at the root, built through the same path as every other result. */
function rootFailure(error: RawError, candidate: unknown): ValidationResult {
  return finalize([error], candidate);
}

/** Last resort for values that are not JSON data at all (cycles, throwing getters). */
export function unreadableResult(candidate: unknown): ValidationResult {
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

/** U+XXXX, at least four hex digits. */
function codePointLabel(point: number): string {
  return `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** True for characters that are unreadable or invisible in a message: shown as a code point instead. */
function isUnprintable(point: number): boolean {
  return (
    point < 0x20 ||
    (point >= 0x7f && point <= 0x9f) ||
    point === 0x2028 ||
    point === 0x2029 ||
    point === BYTE_ORDER_MARK ||
    (point >= 0xd800 && point <= 0xdfff)
  );
}

function describeFound(found: string | null): string {
  if (found === null) return 'unexpected end of text';
  const point = found.codePointAt(0);
  if (point === undefined || isUnprintable(point)) {
    return `unexpected character ${codePointLabel(point ?? 0)}`;
  }
  return `unexpected "${found}"`;
}

/** The INVALID_JSON error for text that `JSON.parse` rejected. `located` is the scanner's finding. */
function invalidJson(text: string, located: JsonSyntaxError | undefined): RawError {
  const line = located?.line ?? 1;
  const column = located?.column ?? 1;
  const message =
    located === undefined
      ? `The text is not well-formed JSON at line ${line}, column ${column}.`
      : `The text is not well-formed JSON: ${describeFound(located.found)} at line ${line}, column ${column}.`;
  const base = `Fix the JSON syntax at line ${line}, column ${column}, for example a missing quote, comma, or bracket.`;
  const startsWithMark = text.length > 0 && text.charCodeAt(0) === BYTE_ORDER_MARK;
  return {
    code: 'INVALID_JSON',
    segments: [],
    message,
    expected: 'well-formed JSON text',
    hint: startsWithMark ? `${base} Remove the byte order mark at the start of the text.` : base,
    actual: text,
  };
}

function checkTextUnguarded(text: string): Checked {
  if (utf8ByteLength(text) > LIMITS.maxDocumentBytes) {
    return failed(
      rootFailure(
        {
          code: 'LIMIT_EXCEEDED',
          segments: [],
          message: `The text is longer than ${LIMITS.maxDocumentBytes} bytes in UTF-8.`,
          expected: `text of at most ${LIMITS.maxDocumentBytes} bytes in UTF-8`,
          hint: 'Shorten the document, for example by removing cards or long text values.',
          actual: text,
        },
        text,
      ),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The scanner runs only after JSON.parse has failed, because engine messages carry no position.
    return failed(rootFailure(invalidJson(text, findJsonSyntaxError(text)), text));
  }
  return checkValueUnguarded(parsed);
}

function checkValueUnguarded(candidate: unknown): Checked {
  if (!isRecord(candidate)) {
    return failed(
      rootFailure(
        {
          code: 'WRONG_TYPE',
          segments: [],
          message: 'The stack must be a JSON object.',
          expected: 'a JSON object',
          hint: 'Wrap the stack in an object with the properties "formatVersion", "id", "name", and "cards".',
          actual: candidate === undefined ? ABSENT : candidate,
        },
        candidate,
      ),
    );
  }

  const version = Object.hasOwn(candidate, 'formatVersion') ? candidate['formatVersion'] : ABSENT;
  if (typeof version === 'number' && Number.isInteger(version) && version !== FORMAT_VERSION) {
    return failed(
      rootFailure(
        {
          code: 'UNSUPPORTED_VERSION',
          segments: ['formatVersion'],
          message: `The format version ${String(version)} is not supported.`,
          expected: `formatVersion ${FORMAT_VERSION}`,
          hint: `Set "formatVersion" to ${FORMAT_VERSION}, the only supported version.`,
          actual: version,
        },
        candidate,
      ),
    );
  }

  const parsed = StackSchema.safeParse(candidate);
  const raws: RawError[] = parsed.success ? [] : mapZodIssues(parsed.error.issues, candidate);
  raws.push(...runSemanticPass(candidate).map(fromSemanticError));

  if (raws.length === 0 && parsed.success) {
    // Built from the Zod output, so key order is the declaration order of the shapes.
    const canonical = `${JSON.stringify(parsed.data, null, 2)}\n`;
    if (utf8ByteLength(canonical) > LIMITS.maxDocumentBytes) {
      return failed(
        rootFailure(
          {
            code: 'LIMIT_EXCEEDED',
            segments: [],
            message: `The stack, written as indented JSON, is longer than ${LIMITS.maxDocumentBytes} bytes in UTF-8.`,
            expected: `a stack of at most ${LIMITS.maxDocumentBytes} bytes as indented JSON`,
            hint: 'Remove cards, objects, or long text values until the document is smaller.',
            actual: candidate,
          },
          candidate,
        ),
      );
    }
    return { result: finalize(raws, candidate), stack: parsed.data, canonical };
  }
  return failed(finalize(raws, candidate));
}

/** Checks JSON text. Never throws. */
export function checkText(text: string): Checked {
  try {
    return checkTextUnguarded(text);
  } catch {
    return failed(unreadableResult(text));
  }
}

/** Checks a candidate value. Never throws. */
export function checkValue(candidate: unknown): Checked {
  try {
    return checkValueUnguarded(candidate);
  } catch {
    return failed(unreadableResult(candidate));
  }
}

/** The dispatch shared by `validateStack` and `parseStack`: a string is JSON text, anything else is a candidate. */
export function checkInput(input: unknown): Checked {
  return typeof input === 'string' ? checkText(input) : checkValue(input);
}
