import { ENTITY_ID_PATTERN, createValidationError, parseStack } from '../format/index.ts';
import type { Stack, ValidationError } from '../format/index.ts';

/**
 * The result of `remixStack`: a new Stack, or errors and no Stack. Two kinds of errors can
 * come back and are told apart by path. A bad new id gives one `INVALID_VALUE` error at
 * `/newId`. An invalid input Stack gives the errors of `validateStack`, with paths into the Stack.
 */
export type RemixResult =
  | { readonly ok: true; readonly stack: Stack }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

function invalidNewId(newId: unknown): RemixResult {
  return {
    ok: false,
    errors: [
      createValidationError({
        code: 'INVALID_VALUE',
        path: '/newId',
        message: 'The new stack id must be a string that matches the entity id pattern.',
        expected: `a string matching ${ENTITY_ID_PATTERN.source}`,
        hint: 'Use 1 to 64 characters from a-z, 0-9, "_" and "-", starting with a letter or digit.',
        actual: newId,
      }),
    ],
  };
}

/**
 * Copies a Stack under a new `id` and records the old `id` in `remixedFrom`. Every other field
 * is unchanged, so every Card, Object and Link keeps its id. An existing `remixedFrom` is
 * replaced. The new id is checked first, then the Stack, so a call with both wrong reports only
 * the new id. Pure: no input is modified, and the result shares nothing with the input.
 */
export function remixStack(stack: unknown, newId: unknown): RemixResult {
  if (typeof newId !== 'string' || !ENTITY_ID_PATTERN.test(newId)) {
    return invalidNewId(newId);
  }
  // Same pipeline as `validateStack`, so the errors are exactly the validator's errors.
  const parsed = parseStack(stack);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors };
  }
  const source = parsed.value;
  // Written out in the canonical key order of the format, with `remixedFrom` after `startCardId`.
  const remixed: Stack = {
    formatVersion: source.formatVersion,
    id: newId,
    name: source.name,
    cardWidth: source.cardWidth,
    cardHeight: source.cardHeight,
    startCardId: source.startCardId,
    remixedFrom: source.id,
    cards: source.cards,
  };
  return { ok: true, stack: remixed };
}
