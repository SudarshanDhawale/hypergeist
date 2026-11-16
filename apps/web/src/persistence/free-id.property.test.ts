import { ENTITY_ID_PATTERN } from '@hypergeist/shared/format';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbEntityId } from '../../../../packages/shared/test-support/arbitraries.ts';
import { assertProperty } from '../../../../packages/shared/test-support/seed.ts';
import { suggestFreeId } from './free-id.ts';

const MAX_ID_LENGTH = 64;
const MAX_TAKEN = 200;
const MAX_COLLISIONS = 30;

/** The first `count` copy candidates for `base`: `-copy`, `-copy-2`, `-copy-3`, ... */
function copyCandidates(base: string, count: number): string[] {
  const candidates: string[] = [];
  for (let attempt = 1; attempt <= count; attempt += 1) {
    const suffix = attempt === 1 ? '-copy' : `-copy-${attempt}`;
    candidates.push(base.slice(0, MAX_ID_LENGTH - suffix.length) + suffix);
  }
  return candidates;
}

interface Scenario {
  readonly base: string;
  readonly taken: readonly string[];
}

/** An arbitrary taken set, unioned with a random number of the base's copy candidates. */
const arbScenario: fc.Arbitrary<Scenario> = fc
  .tuple(
    arbEntityId,
    fc.uniqueArray(arbEntityId, { maxLength: MAX_TAKEN }),
    fc.integer({ min: 0, max: MAX_COLLISIONS }),
    fc.boolean(),
  )
  .map(([base, arbitraryTaken, collisions, includeBase]): Scenario => {
    const union = new Set<string>(arbitraryTaken);
    for (const candidate of copyCandidates(base, collisions)) {
      union.add(candidate);
    }
    if (includeBase) {
      union.add(base);
    }
    return { base, taken: [...union] };
  });

describe('suggestFreeId properties', () => {
  // Feature: local-persistence, Property 6: Free ids are free
  // **Validates: Requirements 5.4, 7.4**
  it('returns a valid id that is not taken and leaves the input unchanged', () => {
    assertProperty(
      fc.property(arbScenario, ({ base, taken }) => {
        const frozen = Object.freeze([...taken]);
        const takenSet = new Set(frozen);

        const fromArray = suggestFreeId(base, frozen);
        const fromSet = suggestFreeId(base, takenSet);

        for (const result of [fromArray, fromSet]) {
          expect(result).toMatch(ENTITY_ID_PATTERN);
          expect(result.length).toBeLessThanOrEqual(MAX_ID_LENGTH);
          expect(takenSet.has(result)).toBe(false);
        }
        expect(fromSet).toBe(fromArray);
        expect(frozen).toEqual(taken);
        expect(takenSet.size).toBe(frozen.length);
      }),
    );
  });
});
