import type { z } from 'zod';
import type { ValidationErrorCode } from './errors.ts';
import { ACTION_TYPES, ENTITY_ID_PATTERN, IMAGE_SRC_PATTERN, OBJECT_TYPES } from './limits.ts';
import { limitMessages } from './limit-messages.ts';
import { codePointLength } from './text.ts';

/** One Zod issue. `ZodError.issues` is a list of these. */
export type ZodIssueLike = z.core.$ZodIssue;

/** One step of a path into the candidate: a property name or an array index. */
export type PathSegment = string | number;

/** Marker for "the property does not exist". Not a JSON value, so it cannot clash with one. */
export const ABSENT = Symbol('absent');

/**
 * A violation before finalizing. `segments` is the path as an array (the JSON
 * Pointer string is built later, in `finalize.ts`). `actual` is the offending
 * value, or `ABSENT` when the property does not exist.
 */
export type RawError = {
  readonly code: ValidationErrorCode;
  readonly segments: readonly PathSegment[];
  readonly message: string;
  readonly expected: string;
  readonly hint: string;
  readonly actual: unknown;
};

type Lookup = { readonly found: true; readonly value: unknown } | { readonly found: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the value at `segments` using own-property checks only. */
function lookup(root: unknown, segments: readonly PathSegment[]): Lookup {
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current) && typeof segment === 'number') {
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = current[segment];
    } else if (isRecord(current)) {
      const key = String(segment);
      if (!Object.hasOwn(current, key)) return { found: false };
      current = current[key];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function actualAt(candidate: unknown, segments: readonly PathSegment[]): unknown {
  const found = lookup(candidate, segments);
  return found.found ? found.value : ABSENT;
}

function toSegments(path: readonly PropertyKey[]): PathSegment[] {
  return path.map((part) => (typeof part === 'symbol' ? part.toString() : part));
}

/** Quotes text for a message and cuts long user-supplied text. */
function quote(text: string): string {
  const points = [...text];
  const shown = points.length > 40 ? `${points.slice(0, 40).join('')}…` : text;
  return `"${shown}"`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function isOneOf(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

/** Describes a JSON value's type for "received ..." text. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined || value === ABSENT) return 'nothing';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return Number.isFinite(value) ? 'a number' : 'a non-finite number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'an object';
    default:
      return `a ${typeof value}`;
  }
}

/** Names the Zod `expected` type for "expected ..." text. */
function describeExpected(expected: string): string {
  switch (expected) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'int':
      return 'an integer';
    case 'boolean':
      return 'a boolean';
    case 'array':
      return 'an array';
    case 'object':
      return 'an object';
    case 'null':
      return 'null';
    default:
      return `a value of type ${expected}`;
  }
}

function showPrimitive(value: unknown): string {
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  return JSON.stringify(value) ?? String(value);
}

function describeValues(values: readonly unknown[]): string {
  if (values.length === 1) return `the value ${showPrimitive(values[0])}`;
  return `one of: ${values.map(showPrimitive).join(', ')}`;
}

function primitiveKind(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

function lengthOf(value: unknown): number | undefined {
  if (typeof value === 'string') return codePointLength(value);
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function limitOf(
  bound: number | bigint,
  inclusive: boolean | undefined,
  direction: 1 | -1,
): number {
  const base = Number(bound);
  return inclusive === false ? base + direction : base;
}

function error(
  code: ValidationErrorCode,
  segments: readonly PathSegment[],
  actual: unknown,
  text: { message: string; expected: string; hint: string },
): RawError {
  return { code, segments, actual, ...text };
}

/** A required property is absent. The path is the nearest existing ancestor. */
function mapMissing(parent: readonly PathSegment[], key: string, what: string): RawError {
  return error('MISSING_PROPERTY', parent, ABSENT, {
    message: `The required property ${quote(key)} is missing.`,
    expected: `a property ${quote(key)} holding ${what}`,
    hint: `Add the property ${quote(key)} with ${what}.`,
  });
}

function mapWrongType(
  segments: readonly PathSegment[],
  actual: unknown,
  expectedLabel: string,
): RawError {
  return error('WRONG_TYPE', segments, actual, {
    message: `Expected ${expectedLabel}, received ${describeType(actual)}.`,
    expected: expectedLabel,
    hint: `Replace this value with ${expectedLabel}.`,
  });
}

function mapUnrecognizedKeys(
  issue: Extract<ZodIssueLike, { code: 'unrecognized_keys' }>,
  candidate: unknown,
): RawError[] {
  const parent = toSegments(issue.path);
  return issue.keys.map((key) => {
    const segments = [...parent, key];
    return error('UNKNOWN_PROPERTY', segments, actualAt(candidate, segments), {
      message: `The property ${quote(key)} is not defined for this entry.`,
      expected: 'only the properties defined by the stack format',
      hint: `Remove the property ${quote(key)}.`,
    });
  });
}

function mapInvalidType(
  issue: Extract<ZodIssueLike, { code: 'invalid_type' }>,
  candidate: unknown,
): RawError[] {
  const segments = toSegments(issue.path);
  const found = lookup(candidate, segments);
  const expectedLabel = describeExpected(issue.expected);
  const key = segments[segments.length - 1];
  if (!found.found && typeof key === 'string') {
    return [mapMissing(segments.slice(0, -1), key, expectedLabel)];
  }
  const actual = found.found ? found.value : ABSENT;
  if (issue.expected === 'int' && typeof actual === 'number') {
    return [
      error('INVALID_VALUE', segments, actual, {
        message: `Expected an integer, received the number ${String(actual)}.`,
        expected: 'an integer',
        hint: Number.isFinite(actual)
          ? `Use a whole number such as ${Math.round(actual)}.`
          : 'Use a whole number.',
      }),
    ];
  }
  return [mapWrongType(segments, actual, expectedLabel)];
}

function mapInvalidValue(
  issue: Extract<ZodIssueLike, { code: 'invalid_value' }>,
  candidate: unknown,
): RawError[] {
  const segments = toSegments(issue.path);
  const found = lookup(candidate, segments);
  const expectedLabel = describeValues(issue.values);
  const key = segments[segments.length - 1];
  if (!found.found && typeof key === 'string') {
    return [mapMissing(segments.slice(0, -1), key, expectedLabel)];
  }
  const actual = found.found ? found.value : ABSENT;
  if (!issue.values.some((allowed) => primitiveKind(allowed) === primitiveKind(actual))) {
    return [
      error('WRONG_TYPE', segments, actual, {
        message: `Expected ${expectedLabel}, received ${describeType(actual)}.`,
        expected: expectedLabel,
        hint: `Replace this value with ${expectedLabel}.`,
      }),
    ];
  }
  return [
    error('INVALID_VALUE', segments, actual, {
      message: `The value is not allowed. Expected ${expectedLabel}.`,
      expected: expectedLabel,
      hint: `Use ${expectedLabel}.`,
    }),
  ];
}

function mapTooBig(
  issue: Extract<ZodIssueLike, { code: 'too_big' }>,
  candidate: unknown,
): RawError[] {
  const segments = toSegments(issue.path);
  const actual = actualAt(candidate, segments);
  const max = limitOf(issue.maximum, issue.inclusive, -1);
  if (issue.origin === 'string' || issue.origin === 'array') {
    const kind = issue.origin === 'string' ? 'text' : 'array';
    return [error('LIMIT_EXCEEDED', segments, actual, limitMessages(kind, max, lengthOf(actual)))];
  }
  const noun =
    issue.origin === 'int' ? 'an integer' : issue.origin === 'number' ? 'a number' : 'a value';
  const exclusive = issue.inclusive === false;
  const limit = String(issue.maximum);
  return [
    error('INVALID_VALUE', segments, actual, {
      message: exclusive
        ? `The value is not below the limit of ${limit}.`
        : `The value is above the maximum of ${limit}.`,
      expected: exclusive ? `${noun} below ${limit}` : `${noun} of at most ${limit}`,
      hint: exclusive ? `Use a value below ${limit}.` : `Use a value of ${limit} or less.`,
    }),
  ];
}

function mapTooSmall(
  issue: Extract<ZodIssueLike, { code: 'too_small' }>,
  candidate: unknown,
): RawError[] {
  const segments = toSegments(issue.path);
  const actual = actualAt(candidate, segments);
  if (issue.origin === 'string' || issue.origin === 'array') {
    const isText = issue.origin === 'string';
    const unit = isText ? 'character' : 'item';
    const min = limitOf(issue.minimum, issue.inclusive, 1);
    const length = lengthOf(actual);
    const missing = length === undefined ? undefined : min - length;
    return [
      error('INVALID_VALUE', segments, actual, {
        message: `The ${isText ? 'text' : 'array'} is shorter than the minimum of ${plural(min, unit)}.`,
        expected: isText
          ? `text of at least ${plural(min, unit)}`
          : `an array of at least ${plural(min, unit)}`,
        hint:
          missing === undefined || missing < 1
            ? isText
              ? `Use at least ${plural(min, unit)}.`
              : `Add items so that at least ${plural(min, unit)} are present.`
            : isText
              ? `Add ${plural(missing, unit)} to this text.`
              : `Add ${plural(missing, unit)} to this array.`,
      }),
    ];
  }
  const noun =
    issue.origin === 'int' ? 'an integer' : issue.origin === 'number' ? 'a number' : 'a value';
  const exclusive = issue.inclusive === false;
  const limit = String(issue.minimum);
  return [
    error('INVALID_VALUE', segments, actual, {
      message: exclusive
        ? `The value is not above the limit of ${limit}.`
        : `The value is below the minimum of ${limit}.`,
      expected: exclusive ? `${noun} above ${limit}` : `${noun} of at least ${limit}`,
      hint: exclusive ? `Use a value above ${limit}.` : `Use a value of ${limit} or more.`,
    }),
  ];
}

type MessageText = { readonly message: string; readonly expected: string; readonly hint: string };

/** Names the Object that owns the property at `segments` as `with the id "x"`, or "" when it has no usable id. */
function ownerLabel(candidate: unknown, segments: readonly PathSegment[]): string {
  const owner = lookup(candidate, segments.slice(0, -1));
  if (owner.found && isRecord(owner.value)) {
    const id = owner.value['id'];
    if (typeof id === 'string' && id.length > 0) return `with the id ${quote(id)}`;
  }
  return '';
}

/** Regular expressions that have their own message. Anything else gets the generic text. */
const KNOWN_PATTERNS: readonly {
  readonly pattern: string;
  readonly describe: (candidate: unknown, segments: readonly PathSegment[]) => MessageText;
}[] = [
  {
    pattern: String(ENTITY_ID_PATTERN),
    describe: () => ({
      message: 'The id has characters or a length that ids do not allow.',
      expected:
        'an id of 1 to 64 characters: lowercase letters, digits, "_" or "-", starting with a letter or digit',
      hint: 'Use lowercase letters, digits, "_" and "-" only, for example "card-1".',
    }),
  },
  {
    pattern: String(IMAGE_SRC_PATTERN),
    describe: (candidate, segments) => {
      const owner = ownerLabel(candidate, segments);
      return {
        message: `The source of the image${owner === '' ? '' : ` ${owner}`} is not an allowed image source.`,
        expected:
          'an https: URL, or a base64 data:image URI of type png, jpeg, gif, or webp, with a non-empty payload',
        hint: 'Use an https: URL, or a base64 data:image URI of type png, jpeg, gif, or webp.',
      };
    },
  },
];

function mapInvalidFormat(
  issue: Extract<ZodIssueLike, { code: 'invalid_format' }>,
  candidate: unknown,
): RawError[] {
  const segments = toSegments(issue.path);
  const actual = actualAt(candidate, segments);
  if (issue.format === 'regex') {
    const known = KNOWN_PATTERNS.find((entry) => entry.pattern === issue.pattern);
    if (known !== undefined) {
      return [error('INVALID_VALUE', segments, actual, known.describe(candidate, segments))];
    }
  }
  if (issue.format === 'datetime') {
    return [
      error('INVALID_VALUE', segments, actual, {
        message: 'The time is not a valid UTC timestamp.',
        expected: 'a UTC timestamp such as 2026-12-01T09:00:00Z',
        hint: 'Write the time in UTC with seconds and a trailing Z.',
      }),
    ];
  }
  const expected =
    issue.format === 'regex' && issue.pattern !== undefined
      ? `a string matching the pattern ${issue.pattern}`
      : `a string in the "${issue.format}" format`;
  return [
    error('INVALID_VALUE', segments, actual, {
      message: `The text does not match the required format. ${issue.message}`,
      expected,
      hint: `Change the text so that it is ${expected}.`,
    }),
  ];
}

type DiscriminatorKind = 'object' | 'action';

function discriminatorKind(
  options: readonly unknown[] | undefined,
  nodeSegments: readonly PathSegment[],
): DiscriminatorKind {
  const known = options ?? [];
  if (known.some((option) => isOneOf(OBJECT_TYPES, option))) return 'object';
  if (known.some((option) => isOneOf(ACTION_TYPES, option))) return 'action';
  return nodeSegments[nodeSegments.length - 2] === 'objects' ? 'object' : 'action';
}

/** Handles `invalid_union` issues raised by a discriminated union on `type`. */
function mapDiscriminator(
  issue: Extract<ZodIssueLike, { code: 'invalid_union' }>,
  key: string,
  candidate: unknown,
): RawError[] {
  const segments = toSegments(issue.path);
  const nodeSegments = segments.slice(0, -1);
  const kind = discriminatorKind(
    issue.inclusive === false ? undefined : issue.options,
    nodeSegments,
  );
  const known = kind === 'object' ? OBJECT_TYPES : ACTION_TYPES;
  const list = known.join(', ');
  const found = lookup(candidate, segments);

  if (!found.found) {
    return [mapMissing(nodeSegments, key, `one of: ${list}`)];
  }
  const value = found.value;
  if (typeof value !== 'string') {
    return [
      error('WRONG_TYPE', segments, value, {
        message: `The ${quote(key)} property must be a string, received ${describeType(value)}.`,
        expected: `a string naming one of: ${list}`,
        hint: `Set ${quote(key)} to one of: ${list}.`,
      }),
    ];
  }
  return [
    error('INVALID_VALUE', segments, value, {
      message: `The ${kind} type ${quote(value)} is unknown.`,
      expected: `one of: ${list}`,
      hint: `Use one of: ${list}.`,
    }),
  ];
}

function mapInvalidUnion(
  issue: Extract<ZodIssueLike, { code: 'invalid_union' }>,
  candidate: unknown,
): RawError[] {
  const last = issue.path[issue.path.length - 1];
  if (typeof issue.discriminator === 'string' && last === issue.discriminator) {
    return mapDiscriminator(issue, issue.discriminator, candidate);
  }
  return mapFallback(issue, candidate);
}

/** Any issue the table does not name becomes `INVALID_VALUE` with Zod's own message. */
function mapFallback(issue: ZodIssueLike, candidate: unknown): RawError[] {
  const segments = toSegments(issue.path);
  return [
    error('INVALID_VALUE', segments, actualAt(candidate, segments), {
      message: issue.message.length > 0 ? issue.message : 'The value is not valid.',
      expected: 'a value that the stack format accepts',
      hint: 'Change this value so that it follows the stack format.',
    }),
  ];
}

function mapIssue(issue: ZodIssueLike, candidate: unknown): RawError[] {
  switch (issue.code) {
    case 'unrecognized_keys':
      return mapUnrecognizedKeys(issue, candidate);
    case 'invalid_type':
      return mapInvalidType(issue, candidate);
    case 'invalid_value':
      return mapInvalidValue(issue, candidate);
    case 'too_big':
      return mapTooBig(issue, candidate);
    case 'too_small':
      return mapTooSmall(issue, candidate);
    case 'invalid_format':
      return mapInvalidFormat(issue, candidate);
    case 'invalid_union':
      return mapInvalidUnion(issue, candidate);
    default:
      return mapFallback(issue, candidate);
  }
}

/**
 * Maps Zod issues to raw errors, in issue order. Pure: reads `candidate`
 * (to tell absent properties from wrong ones and to find `actual`), never
 * writes to it, and never throws for any JSON value.
 */
export function mapZodIssues(issues: readonly ZodIssueLike[], candidate: unknown): RawError[] {
  return issues
    .flatMap((issue) => mapIssue(issue, candidate))
    .map((raw) => nameObject(raw, candidate));
}

/** Object types whose errors must name the Object id (Requirements 4.8, 4.9). */
const NAMED_OBJECT_TYPES: readonly string[] = ['image', 'ai-field'];

/**
 * An error inside an image or ai-field Object gets a closing sentence that names the Object
 * id, unless the message already names it. The path alone does not hold the id, because it
 * holds array indexes.
 */
function nameObject(raw: RawError, candidate: unknown): RawError {
  const { segments } = raw;
  if (segments.length < 4 || segments[0] !== 'cards' || segments[2] !== 'objects') return raw;
  // An error about `type` itself means the Object has no known type, so it is not one of ours.
  if (segments.length === 5 && segments[4] === 'type') return raw;
  const owner = lookup(candidate, segments.slice(0, 4));
  if (!owner.found || !isRecord(owner.value)) return raw;
  const type = owner.value['type'];
  const id = owner.value['id'];
  if (typeof type !== 'string' || !NAMED_OBJECT_TYPES.includes(type)) return raw;
  if (typeof id !== 'string' || id.length === 0 || raw.message.includes(quote(id))) return raw;
  return { ...raw, message: `${raw.message} This is in the ${type} object ${quote(id)}.` };
}
