import * as fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { ENTITY_ID_PATTERN, LIMITS, validateHandler, validateStack } from '../src/format/index.ts';
import type { Action, Handler, Stack } from '../src/format/index.ts';
import { arbCandidate, arbEntityId, arbHandlerFor, arbMutation, arbStack } from './arbitraries.ts';
import { assertProperty, getTestSeed } from './seed.ts';

const SAMPLE_SIZE = 300;
const SLOW = 60_000;

function allActions(stack: Stack): Action[] {
  const actions: Action[] = [];
  for (const card of stack.cards) {
    actions.push(...card.onOpen);
    for (const object of card.objects) {
      if (object.type === 'button') {
        actions.push(...object.onClick);
      }
    }
  }
  return actions;
}

function handlers(stack: Stack): Handler[] {
  const found: Handler[] = [];
  for (const card of stack.cards) {
    found.push(card.onOpen);
    for (const object of card.objects) {
      if (object.type === 'button') {
        found.push(object.onClick);
      }
    }
  }
  return found;
}

describe('arbStack', () => {
  let samples: Stack[] = [];

  beforeAll(() => {
    samples = fc.sample(arbStack, { numRuns: SAMPLE_SIZE, seed: getTestSeed() });
  }, SLOW);

  it(`generates ${SAMPLE_SIZE} stacks that all pass validateStack`, () => {
    expect(samples).toHaveLength(SAMPLE_SIZE);
    for (const stack of samples) {
      const result = validateStack(stack);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it('also validates when the stack is passed as JSON text', () => {
    for (const stack of samples.slice(0, 50)) {
      expect(validateStack(JSON.stringify(stack)).valid).toBe(true);
    }
  });

  it('covers every Object type, every Action type, Links, and the limits', () => {
    const objects = samples.flatMap((stack) => stack.cards.flatMap((card) => card.objects));
    expect(new Set(objects.map((object) => object.type))).toEqual(
      new Set(['button', 'field', 'list']),
    );

    const actions = samples.flatMap(allActions);
    expect(new Set(actions.map((action) => action.type))).toEqual(
      new Set(['go_to_card', 'set_value', 'append_item', 'show_message']),
    );
    expect(actions.some((a) => a.type === 'set_value' && a.fromObjectId !== undefined)).toBe(true);
    expect(actions.some((a) => a.type === 'append_item' && a.fromObjectId !== undefined)).toBe(
      true,
    );

    const cards = samples.flatMap((stack) => stack.cards);
    expect(cards.some((card) => card.links.length > 0)).toBe(true);
    const cardCounts = new Set(samples.map((stack) => stack.cards.length));
    expect(cardCounts.has(LIMITS.cards.min)).toBe(true);
    expect(cardCounts.has(5)).toBe(true);

    const dimensions = samples.flatMap((stack) => [stack.cardWidth, stack.cardHeight]);
    expect(dimensions).toContain(LIMITS.cardSize.min);
    expect(dimensions).toContain(LIMITS.cardSize.max);

    expect(cards.some((card) => card.objects.length === 0)).toBe(true);
    expect(cards.some((card) => card.objects.length === LIMITS.objectsPerCard.max)).toBe(true);
    const handlerLengths = samples.flatMap(handlers).map((handler) => handler.length);
    expect(handlerLengths).toContain(0);
    expect(handlerLengths).toContain(LIMITS.handlerActions.max);

    expect(
      objects.some(
        (object) => object.type === 'list' && object.items.length === LIMITS.listItems.max,
      ),
    ).toBe(true);
    expect(
      samples.some((stack) =>
        stack.cards.some((card) =>
          card.objects.some(
            (o) => o.x + o.width === stack.cardWidth || o.y + o.height === stack.cardHeight,
          ),
        ),
      ),
    ).toBe(true);
    expect(samples.some((stack) => JSON.stringify(stack).match(/[\u{10000}-\u{10ffff}]/u))).toBe(
      true,
    );
    expect(samples.some((stack) => stack.remixedFrom !== undefined)).toBe(true);
    expect(samples.some((stack) => stack.remixedFrom === undefined)).toBe(true);
  });

  it('includes Fields longer than a list item may be, so some copies are skipped by the executor', () => {
    const longFields = samples.flatMap((stack) =>
      stack.cards.flatMap((card) =>
        card.objects.filter(
          (o) => o.type === 'field' && [...o.value].length > LIMITS.listItemText.max,
        ),
      ),
    );
    expect(longFields.length).toBeGreaterThan(0);
  });
});

describe('arbEntityId', () => {
  it('always matches the Entity_ID pattern', () => {
    assertProperty(
      fc.property(arbEntityId, (id) => ENTITY_ID_PATTERN.test(id)),
      { numRuns: 300 },
    );
  });
});

describe('arbHandlerFor', () => {
  it(
    'generates Handlers that pass validateHandler for their stack',
    () => {
      assertProperty(
        fc.property(
          arbStack.chain((stack) => fc.tuple(fc.constant(stack), arbHandlerFor(stack))),
          ([stack, handler]) => {
            expect(handler.length).toBeLessThanOrEqual(LIMITS.handlerActions.max);
            expect(validateHandler(stack, handler).valid).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    },
    SLOW,
  );
});

describe('arbMutation', () => {
  it(
    'generates mutated stacks that fail validateStack and leave the original valid',
    () => {
      assertProperty(
        fc.property(arbMutation, (mutation) => {
          expect(validateStack(mutation.original).valid).toBe(true);
          expect(validateStack(mutation.mutated).valid).toBe(false);
        }),
        { numRuns: 200 },
      );
    },
    SLOW,
  );

  it(
    'uses every mutation kind',
    () => {
      const kinds = new Set(
        fc.sample(arbMutation, { numRuns: 200, seed: getTestSeed() }).map((m) => m.kind),
      );
      expect(kinds).toEqual(
        new Set([
          'delete-property',
          'swap-type',
          'exceed-limit',
          'add-unknown-property',
          'retarget-reference',
        ]),
      );
    },
    SLOW,
  );
});

describe('arbCandidate', () => {
  it(
    'produces values validateStack accepts without throwing',
    () => {
      assertProperty(
        fc.property(arbCandidate, (candidate) => {
          expect(typeof validateStack(candidate).valid).toBe('boolean');
        }),
        { numRuns: 200 },
      );
    },
    SLOW,
  );
});
