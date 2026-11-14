import type { ValidationError, ValidationResult } from './errors.ts';
import { LIMITS } from './limits.ts';
import type { SemanticError } from './semantic.ts';
import { toJsonPointer } from './text.ts';
import { ABSENT } from './zod-issues.ts';
import type { PathSegment, RawError } from './zod-issues.ts';

/**
 * Last stage of validation: puts raw errors into document order, keeps the
 * first 100, and builds the final `ValidationError` values (JSON Pointer
 * paths and `actual` text).
 */

/** Position of one path segment inside its container. */
type KeyPart = number;

/** Document-order key: one position per path segment. */
type DocumentKey = readonly KeyPart[];

/** Sorts after every real position. Used when a segment cannot be found in the candidate. */
const UNRESOLVED: KeyPart = Number.MAX_SAFE_INTEGER;

/** Converts a semantic error to a raw error, mapping "not present" to `ABSENT`. */
export function fromSemanticError(error: SemanticError): RawError {
  return {
    code: error.code,
    segments: error.segments,
    message: error.message,
    expected: error.expected,
    hint: error.hint,
    actual: error.actual.present ? error.actual.value : ABSENT,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps each own property name of an object to its position in `Object.keys` order. */
type PropertyPositions = ReadonlyMap<string, number>;

function positionsOf(
  record: Record<string, unknown>,
  cache: WeakMap<object, PropertyPositions>,
): PropertyPositions {
  const cached = cache.get(record);
  if (cached !== undefined) return cached;
  const positions = new Map<string, number>();
  Object.keys(record).forEach((key, position) => {
    positions.set(key, position);
  });
  cache.set(record, positions);
  return positions;
}

/**
 * Walks the candidate along `segments`. An array element contributes its
 * index, an object property contributes its position in `Object.keys` order.
 * A segment that cannot be found contributes `UNRESOLVED` and ends the walk.
 */
function documentKey(
  candidate: unknown,
  segments: readonly PathSegment[],
  cache: WeakMap<object, PropertyPositions>,
): DocumentKey {
  const key: KeyPart[] = [];
  let current: unknown = candidate;
  for (const segment of segments) {
    if (Array.isArray(current) && typeof segment === 'number') {
      if (segment < 0 || segment >= current.length) {
        key.push(UNRESOLVED);
        break;
      }
      key.push(segment);
      current = current[segment];
    } else if (isRecord(current)) {
      const name = String(segment);
      const position = positionsOf(current, cache).get(name);
      if (position === undefined) {
        key.push(UNRESOLVED);
        break;
      }
      key.push(position);
      current = current[name];
    } else {
      key.push(UNRESOLVED);
      break;
    }
  }
  return key;
}

/** Element by element; when one key is a prefix of the other, the shorter (the parent) comes first. */
function compareKeys(a: DocumentKey, b: DocumentKey): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const left = a[i] as number;
    const right = b[i] as number;
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.length - b.length;
}

/** Ascending code-point order. Codes are ASCII, so UTF-16 comparison gives the same result. */
function compareCodes(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** First `max` code points of `text`, never splitting a surrogate pair. */
function cutToCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  let count = 0;
  while (end < text.length && count < max) {
    const unit = text.charCodeAt(end);
    const next = end + 1 < text.length ? text.charCodeAt(end + 1) : 0;
    end += unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
    count += 1;
  }
  return text.slice(0, end);
}

/** The offending value as JSON text. Falls back to `String(value)` when JSON cannot hold it. */
function serializeActual(value: unknown): string {
  try {
    const json: string | undefined = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Not serializable (cycle, bigint, throwing getter): use the fallback below.
  }
  try {
    return String(value);
  } catch {
    return '[unprintable value]';
  }
}

/** Builds the final error for one raw error. */
export function buildValidationError(raw: RawError): ValidationError {
  return {
    code: raw.code,
    path: toJsonPointer(raw.segments),
    message: raw.message,
    expected: raw.expected,
    actual:
      raw.actual === ABSENT
        ? null
        : cutToCodePoints(serializeActual(raw.actual), LIMITS.actualMaxChars),
    hint: raw.hint,
  };
}

/**
 * Sorts raw errors into document order of their paths (ties by `code`), keeps
 * the first `LIMITS.maxErrors`, and builds the Validation_Result. `candidate`
 * is the value the paths point into. The sort is stable, so errors with the
 * same path and code keep their emission order.
 */
export function finalize(raws: readonly RawError[], candidate: unknown): ValidationResult {
  const cache = new WeakMap<object, PropertyPositions>();
  const keyed = raws.map((raw) => ({ raw, key: documentKey(candidate, raw.segments, cache) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key) || compareCodes(a.raw.code, b.raw.code));
  const kept = keyed.slice(0, LIMITS.maxErrors).map((entry) => buildValidationError(entry.raw));
  return {
    valid: raws.length === 0,
    errors: kept,
    truncated: raws.length > LIMITS.maxErrors,
  };
}
