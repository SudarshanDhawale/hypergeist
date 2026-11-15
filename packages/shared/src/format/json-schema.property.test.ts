import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbMutationFor, arbStack } from '../../test-support/arbitraries.ts';
import type { Mutation } from '../../test-support/arbitraries.ts';
import { createSchemaValidator } from '../../test-support/schema-validator.ts';
import { assertProperty } from '../../test-support/seed.ts';
import { stackJsonSchema } from './json-schema.ts';
import { StackSchema } from './schemas.ts';

const validator = createSchemaValidator();
const checkSchema = validator.compile(stackJsonSchema());

/** The mutation kinds a structural JSON Schema can detect. Limits and references are semantic. */
const STRUCTURAL_KINDS: readonly Mutation['kind'][] = [
  'delete-property',
  'swap-type',
  'add-unknown-property',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The three Actions whose two optional properties must appear exactly one at a time. */
const PAIRS: Readonly<Record<string, readonly [string, string]>> = {
  set_value: ['value', 'fromObjectId'],
  append_item: ['item', 'fromObjectId'],
  schedule_notification: ['at', 'atFromObjectId'],
};

/** Valid-looking replacement values for the property that a "both" mutation adds. */
const PAIR_FILL: Readonly<Record<string, unknown>> = {
  value: 'x',
  item: 'x',
  at: '2026-12-01T09:00:00Z',
  fromObjectId: 'some-object',
  atFromObjectId: 'some-object',
};

type PairBreak = 'both' | 'neither';

/** Every Action in the (cloned) stack that belongs to an exactly-one-of pair. */
function pairActions(json: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visitHandler = (handler: unknown): void => {
    if (!Array.isArray(handler)) return;
    for (const action of handler) {
      if (isRecord(action) && typeof action['type'] === 'string' && action['type'] in PAIRS) {
        found.push(action);
      }
    }
  };
  if (isRecord(json) && Array.isArray(json['cards'])) {
    for (const card of json['cards']) {
      if (!isRecord(card)) continue;
      visitHandler(card['onOpen']);
      if (Array.isArray(card['objects'])) {
        for (const object of card['objects']) {
          if (isRecord(object)) visitHandler(object['onClick']);
        }
      }
    }
  }
  return found;
}

/**
 * A valid stack (as plain JSON) with one exactly-one-of pair broken: both properties present,
 * or neither. Stacks without such an Action are filtered out.
 */
function arbPairBreak(): fc.Arbitrary<unknown> {
  return arbStack
    .map((stack): unknown => JSON.parse(JSON.stringify(stack)))
    .filter((json) => pairActions(json).length > 0)
    .chain((json) =>
      fc
        .tuple(
          fc.integer({ min: 0, max: pairActions(json).length - 1 }),
          fc.constantFrom<PairBreak>('both', 'neither'),
        )
        .map(([index, how]): unknown => {
          const action = pairActions(json)[index];
          const type = action?.['type'];
          const pair = typeof type === 'string' ? PAIRS[type] : undefined;
          if (action === undefined || pair === undefined) {
            throw new Error('json-schema property: no pair action at the chosen index');
          }
          for (const key of pair) {
            if (how === 'neither') {
              delete action[key];
            } else if (!Object.hasOwn(action, key)) {
              action[key] = PAIR_FILL[key];
            }
          }
          return json;
        }),
    );
}

describe('stack JSON Schema property', () => {
  it('is itself a valid draft 2020-12 schema', () => {
    expect(validator.isValidSchema(stackJsonSchema())).toBe(true);
  });

  // Feature: stack-format-and-validator, Property 21: The JSON Schema accepts valid stacks and rejects structural violations
  // **Validates: Requirements 11.1, 12.7**
  it('accepts every valid stack', () => {
    assertProperty(
      fc.property(arbStack, (stack) => {
        const result = checkSchema(stack);
        expect(result.valid ? [] : result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      }),
    );
  });

  // Feature: stack-format-and-validator, Property 21: The JSON Schema accepts valid stacks and rejects structural violations
  // **Validates: Requirements 11.1, 12.7**
  it('rejects a deleted property, a swapped type, or an unknown property that Zod reports', () => {
    assertProperty(
      fc.property(
        arbStack
          .chain(arbMutationFor)
          .filter((mutation) => STRUCTURAL_KINDS.includes(mutation.kind)),
        (mutation) => {
          // Only mutations that Zod itself reports as a structural issue are in scope.
          fc.pre(!StackSchema.safeParse(mutation.mutated).success);
          expect(checkSchema(mutation.mutated).valid).toBe(false);
        },
      ),
    );
  });

  // Feature: stack-format-and-validator, Property 21: The JSON Schema accepts valid stacks and rejects structural violations
  // **Validates: Requirements 11.1, 12.7**
  it('rejects an Action that has both or neither property of an exactly-one-of pair', () => {
    assertProperty(
      fc.property(arbPairBreak(), (broken) => {
        expect(checkSchema(broken).valid).toBe(false);
      }),
    );
  });
});
