import * as fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ACTION_TYPES,
  ENTITY_ID_PATTERN,
  LIMITS,
  validateHandler,
  validateStack,
} from '../src/format/index.ts';
import type { Action, Handler, Stack } from '../src/format/index.ts';
import {
  arbCandidate,
  arbEntityId,
  arbHandlerFor,
  arbImageSrc,
  arbMutation,
  arbStack,
} from './arbitraries.ts';
import { isValidImageSrc, isValidUtcTimestamp } from './oracles.ts';
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
      new Set(['button', 'field', 'image', 'list', 'ai-field']),
    );

    const actions = samples.flatMap(allActions);
    expect(new Set(actions.map((action) => action.type))).toEqual(new Set(ACTION_TYPES));
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

/** Code point count, which is how the format measures text. */
function cp(text: string): number {
  return [...text].length;
}

type LimitSite = {
  /** The `LIMITS` row this site exercises. */
  readonly row: keyof typeof LIMITS;
  /** What the sample must contain: the smallest and the largest observed value. */
  readonly min: number;
  readonly max: number;
  readonly observe: (stack: Stack) => number[];
};

function cards(stack: Stack) {
  return stack.cards;
}

function objectsOf(stack: Stack) {
  return stack.cards.flatMap((card) => card.objects);
}

function actionsOf(stack: Stack): Action[] {
  return allActions(stack);
}

/**
 * Every `LIMITS` row that bounds a generated value, with the smallest and largest value the
 * sample must contain. For most rows these are the limits themselves. The rows whose
 * smallest or largest valid value is not the limit are spelled out:
 * - `imageHttpsSrc` starts at `https://a` (9 characters), the shortest valid URL.
 * - `imageDataSrc` starts at 26 characters (`data:image/png;base64,` plus one group of 4)
 *   and ends at 999,999 (`jpeg` and `webp`; `png` and `gif` end at 999,998), because a valid
 *   payload is a multiple of 4 characters.
 * - `objectPosition` ends at 4,088, because an Object must fit inside the Card:
 *   `x + width <= cardWidth`, with a width of at least 8 and a Card at most 4,096 wide.
 */
const LIMIT_SITES: readonly LimitSite[] = [
  {
    row: 'stackName',
    min: LIMITS.stackName.min,
    max: LIMITS.stackName.max,
    observe: (s) => [cp(s.name)],
  },
  {
    row: 'cardSize',
    min: LIMITS.cardSize.min,
    max: LIMITS.cardSize.max,
    observe: (s) => [s.cardWidth, s.cardHeight],
  },
  {
    row: 'cards',
    min: LIMITS.cards.min,
    max: LIMITS.cards.max,
    observe: (s) => [s.cards.length],
  },
  {
    row: 'cardName',
    min: LIMITS.cardName.min,
    max: LIMITS.cardName.max,
    observe: (s) => cards(s).map((c) => cp(c.name)),
  },
  {
    row: 'objectsPerCard',
    min: LIMITS.objectsPerCard.min,
    max: LIMITS.objectsPerCard.max,
    observe: (s) => cards(s).map((c) => c.objects.length),
  },
  {
    row: 'linksPerCard',
    min: LIMITS.linksPerCard.min,
    max: LIMITS.linksPerCard.max,
    observe: (s) => cards(s).map((c) => c.links.length),
  },
  {
    row: 'linkLabel',
    min: LIMITS.linkLabel.min,
    max: LIMITS.linkLabel.max,
    observe: (s) => cards(s).flatMap((c) => c.links.map((l) => cp(l.label))),
  },
  {
    row: 'objectName',
    min: LIMITS.objectName.min,
    max: LIMITS.objectName.max,
    observe: (s) => objectsOf(s).map((o) => cp(o.name)),
  },
  {
    row: 'objectPosition',
    min: LIMITS.objectPosition.min,
    max: LIMITS.cardSize.max - LIMITS.objectSize.min,
    observe: (s) => objectsOf(s).flatMap((o) => [o.x, o.y]),
  },
  {
    row: 'objectSize',
    min: LIMITS.objectSize.min,
    max: LIMITS.objectSize.max,
    observe: (s) => objectsOf(s).flatMap((o) => [o.width, o.height]),
  },
  {
    row: 'buttonLabel',
    min: LIMITS.buttonLabel.min,
    max: LIMITS.buttonLabel.max,
    observe: (s) => objectsOf(s).flatMap((o) => (o.type === 'button' ? [cp(o.label)] : [])),
  },
  {
    row: 'fieldValue',
    min: LIMITS.fieldValue.min,
    max: LIMITS.fieldValue.max,
    observe: (s) => objectsOf(s).flatMap((o) => (o.type === 'field' ? [cp(o.value)] : [])),
  },
  {
    row: 'fieldPlaceholder',
    min: LIMITS.fieldPlaceholder.min,
    max: LIMITS.fieldPlaceholder.max,
    observe: (s) => objectsOf(s).flatMap((o) => (o.type === 'field' ? [cp(o.placeholder)] : [])),
  },
  {
    row: 'listItems',
    min: LIMITS.listItems.min,
    max: LIMITS.listItems.max,
    observe: (s) => objectsOf(s).flatMap((o) => (o.type === 'list' ? [o.items.length] : [])),
  },
  {
    row: 'listItemText',
    min: LIMITS.listItemText.min,
    max: LIMITS.listItemText.max,
    observe: (s) => objectsOf(s).flatMap((o) => (o.type === 'list' ? o.items.map(cp) : [])),
  },
  {
    row: 'handlerActions',
    min: LIMITS.handlerActions.min,
    max: LIMITS.handlerActions.max,
    observe: (s) => handlers(s).map((h) => h.length),
  },
  {
    row: 'setValueText',
    min: LIMITS.setValueText.min,
    max: LIMITS.setValueText.max,
    observe: (s) =>
      actionsOf(s).flatMap((a) =>
        a.type === 'set_value' && a.value !== undefined ? [cp(a.value)] : [],
      ),
  },
  {
    row: 'appendItemText',
    min: LIMITS.appendItemText.min,
    max: LIMITS.appendItemText.max,
    observe: (s) =>
      actionsOf(s).flatMap((a) =>
        a.type === 'append_item' && a.item !== undefined ? [cp(a.item)] : [],
      ),
  },
  {
    row: 'messageText',
    min: LIMITS.messageText.min,
    max: LIMITS.messageText.max,
    observe: (s) => actionsOf(s).flatMap((a) => (a.type === 'show_message' ? [cp(a.text)] : [])),
  },
  {
    row: 'imageAlt',
    min: LIMITS.imageAlt.min,
    max: LIMITS.imageAlt.max,
    observe: (s) => objectsOf(s).flatMap((o) => (o.type === 'image' ? [cp(o.alt)] : [])),
  },
  {
    row: 'imageHttpsSrc',
    min: 'https://a'.length,
    max: LIMITS.imageHttpsSrc.max,
    observe: (s) =>
      objectsOf(s).flatMap((o) =>
        o.type === 'image' && o.src.startsWith('https:') ? [o.src.length] : [],
      ),
  },
  {
    row: 'imageDataSrc',
    min: 'data:image/png;base64,AAAA'.length,
    max: 999_999,
    observe: (s) =>
      objectsOf(s).flatMap((o) =>
        o.type === 'image' && o.src.startsWith('data:') ? [o.src.length] : [],
      ),
  },
  {
    row: 'aiPrompt',
    min: LIMITS.aiPrompt.min,
    max: LIMITS.aiPrompt.max,
    observe: (s) => objectsOf(s).flatMap((o) => (o.type === 'ai-field' ? [cp(o.prompt)] : [])),
  },
  {
    row: 'aiInputObjects',
    min: LIMITS.aiInputObjects.min,
    max: LIMITS.aiInputObjects.max,
    observe: (s) =>
      objectsOf(s).flatMap((o) => (o.type === 'ai-field' ? [o.inputObjectIds.length] : [])),
  },
  {
    row: 'aiFieldValue',
    min: LIMITS.aiFieldValue.min,
    max: LIMITS.aiFieldValue.max,
    observe: (s) => objectsOf(s).flatMap((o) => (o.type === 'ai-field' ? [cp(o.value)] : [])),
  },
  {
    row: 'newsTopics',
    min: LIMITS.newsTopics.min,
    max: LIMITS.newsTopics.max,
    observe: (s) => actionsOf(s).flatMap((a) => (a.type === 'fetch_news' ? [a.topics.length] : [])),
  },
  {
    row: 'newsTopicText',
    min: LIMITS.newsTopicText.min,
    max: LIMITS.newsTopicText.max,
    observe: (s) => actionsOf(s).flatMap((a) => (a.type === 'fetch_news' ? a.topics.map(cp) : [])),
  },
  {
    row: 'notificationMessage',
    min: LIMITS.notificationMessage.min,
    max: LIMITS.notificationMessage.max,
    observe: (s) =>
      actionsOf(s).flatMap((a) => (a.type === 'schedule_notification' ? [cp(a.message)] : [])),
  },
];

/**
 * The sample for the limit coverage test has a fixed seed, so the rare cases (200 Cards, a
 * megabyte data URI) are either always in it or the test fails the same way every time.
 */
const COVERAGE_SEED = 20_261_115;

describe('arbStack limit coverage', () => {
  let samples: Stack[] = [];

  beforeAll(() => {
    samples = fc.sample(arbStack, { numRuns: SAMPLE_SIZE, seed: COVERAGE_SEED });
  }, SLOW);

  it('has a coverage site for every bounded LIMITS row', () => {
    const covered = new Set<string>(LIMIT_SITES.map((site) => site.row));
    // `removeItemIndex` has no maximum and is covered below. The rest are not generated values.
    const notValues = ['maxDocumentBytes', 'maxErrors', 'actualMaxChars', 'removeItemIndex'];
    const missing = Object.keys(LIMITS).filter(
      (row) => !covered.has(row) && !notValues.includes(row),
    );
    expect(missing).toEqual([]);
  });

  it.each(LIMIT_SITES.map((site) => [site.row, site] as const))(
    'contains the minimum and the maximum of %s',
    (_row, site) => {
      const observed = samples.flatMap(site.observe);
      expect(observed.length).toBeGreaterThan(0);
      expect(Math.min(...observed)).toBe(site.min);
      expect(Math.max(...observed)).toBe(site.max);
    },
  );

  it('contains the minimum of removeItemIndex, which has no maximum', () => {
    const indexes = samples.flatMap((s) =>
      actionsOf(s).flatMap((a) => (a.type === 'remove_item' ? [a.index] : [])),
    );
    expect(Math.min(...indexes)).toBe(LIMITS.removeItemIndex.min);
  });

  it('contains stacks with remixedFrom present and absent', () => {
    expect(samples.some((s) => s.remixedFrom !== undefined)).toBe(true);
    expect(samples.some((s) => s.remixedFrom === undefined)).toBe(true);
  });
});

describe('arbStack Images and AI Fields', () => {
  let samples: Stack[] = [];

  beforeAll(() => {
    samples = fc.sample(arbStack, { numRuns: SAMPLE_SIZE, seed: getTestSeed() });
  }, SLOW);

  it('gives every AI Field unique inputs from the Field, List, and AI Field Objects on its own Card', () => {
    let withInputs = 0;
    let withMaxInputs = 0;
    for (const stack of samples) {
      for (const card of stack.cards) {
        for (const object of card.objects) {
          if (object.type !== 'ai-field') {
            continue;
          }
          const ids = object.inputObjectIds;
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids.length).toBeLessThanOrEqual(LIMITS.aiInputObjects.max);
          expect(ids).not.toContain(object.id);
          for (const id of ids) {
            const target = card.objects.find((o) => o.id === id);
            expect(target).toBeDefined();
            expect(['field', 'list', 'ai-field']).toContain(target?.type);
          }
          if (ids.length > 0) {
            withInputs += 1;
          }
          if (ids.length === LIMITS.aiInputObjects.max) {
            withMaxInputs += 1;
          }
        }
      }
    }
    expect(withInputs).toBeGreaterThan(0);
    expect(withMaxInputs).toBeGreaterThan(0);
  });

  it('covers AI Field and Image text at both ends of the limits', () => {
    const aiFields = samples.flatMap((stack) =>
      stack.cards.flatMap((card) => card.objects.filter((o) => o.type === 'ai-field')),
    );
    const images = samples.flatMap((stack) =>
      stack.cards.flatMap((card) => card.objects.filter((o) => o.type === 'image')),
    );
    expect(aiFields.length).toBeGreaterThan(0);
    expect(images.length).toBeGreaterThan(0);
    expect(aiFields.some((o) => o.type === 'ai-field' && [...o.prompt].length === 1)).toBe(true);
    expect(
      aiFields.some((o) => o.type === 'ai-field' && [...o.prompt].length === LIMITS.aiPrompt.max),
    ).toBe(true);
    expect(images.some((o) => o.type === 'image' && o.alt === '')).toBe(true);
  });
});

describe('arbImageSrc', () => {
  const sources = fc.sample(arbImageSrc, { numRuns: 1500, seed: getTestSeed() });

  it('only produces sources the independent oracle accepts', () => {
    for (const src of sources) {
      expect(isValidImageSrc(src)).toBe(true);
    }
  });

  it('covers short and 2,000-character https URLs and every data type', () => {
    expect(sources.some((src) => src.startsWith('https://') && src.length < 100)).toBe(true);
    expect(sources.some((src) => src.startsWith('https://') && src.length === 2000)).toBe(true);
    for (const type of ['png', 'jpeg', 'gif', 'webp']) {
      const prefix = `data:image/${type};base64,`;
      expect(sources.some((src) => src.startsWith(prefix) && src.length < 200)).toBe(true);
    }
  });

  it('rarely produces the longest valid data URI, at most 1,000,000 characters', () => {
    const large = sources.filter((src) => src.length > 100_000);
    expect(large.length).toBeGreaterThan(0);
    expect(large.length).toBeLessThan(sources.length / 10);
    for (const src of large) {
      expect(src.length).toBeGreaterThanOrEqual(999_998);
      expect(src.length).toBeLessThanOrEqual(LIMITS.imageDataSrc.max);
    }
    // One cached constant per type, so the same string is shared.
    expect(new Set(large).size).toBeLessThanOrEqual(4);
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

const EXECUTABLE_TYPES = new Set(['go_to_card', 'show_message', 'set_value', 'append_item']);

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

  it(
    "in the default 'executable' mode, produces only the four executable Action types, over Fields and Lists",
    () => {
      assertProperty(
        fc.property(
          arbStack.chain((stack) => fc.tuple(fc.constant(stack), arbHandlerFor(stack))),
          ([stack, handler]) => {
            const kinds = new Map(
              stack.cards.flatMap((card) => card.objects.map((o) => [o.id, o.type] as const)),
            );
            for (const action of handler) {
              expect(EXECUTABLE_TYPES.has(action.type)).toBe(true);
              if (action.type === 'set_value') {
                expect(kinds.get(action.targetObjectId)).toBe('field');
                expect(kinds.get(action.fromObjectId ?? '')).not.toBe('ai-field');
              } else if (action.type === 'append_item') {
                expect(kinds.get(action.fromObjectId ?? '')).not.toBe('ai-field');
              }
            }
          },
        ),
        { numRuns: 200 },
      );
    },
    SLOW,
  );

  it(
    "in 'all' mode, produces valid Handlers whose references have the right kinds",
    () => {
      assertProperty(
        fc.property(
          arbStack.chain((stack) => fc.tuple(fc.constant(stack), arbHandlerFor(stack, 'all'))),
          ([stack, handler]) => {
            expect(handler.length).toBeLessThanOrEqual(LIMITS.handlerActions.max);
            expect(validateHandler(stack, handler).valid).toBe(true);
            checkReferenceKinds(stack, handler);
          },
        ),
        { numRuns: 200 },
      );
    },
    SLOW,
  );
});

function kindsById(stack: Stack): Map<string, string> {
  return new Map(
    stack.cards.flatMap((card) => card.objects.map((o): [string, string] => [o.id, o.type])),
  );
}

/** Asserts the reference kind of every Action, independently of the validator. */
function checkReferenceKinds(stack: Stack, handler: Handler): void {
  const kinds = kindsById(stack);
  const kindOf = (id: string): string | undefined => kinds.get(id);
  for (const action of handler) {
    switch (action.type) {
      case 'set_value':
        expect(['field', 'ai-field']).toContain(kindOf(action.targetObjectId));
        if (action.fromObjectId !== undefined) {
          expect(['field', 'ai-field', 'list']).toContain(kindOf(action.fromObjectId));
        }
        break;
      case 'append_item':
        expect(kindOf(action.targetObjectId)).toBe('list');
        if (action.fromObjectId !== undefined) {
          expect(['field', 'ai-field']).toContain(kindOf(action.fromObjectId));
        }
        break;
      case 'remove_item':
      case 'fetch_news':
        expect(kindOf(action.targetObjectId)).toBe('list');
        break;
      case 'run_ai_field':
        expect(kindOf(action.targetObjectId)).toBe('ai-field');
        break;
      case 'transcribe_audio':
        expect(kindOf(action.targetObjectId)).toBe('field');
        break;
      case 'schedule_notification':
        expect(action.at === undefined).not.toBe(action.atFromObjectId === undefined);
        if (action.atFromObjectId !== undefined) {
          expect(kindOf(action.atFromObjectId)).toBe('field');
        }
        break;
      case 'go_to_card':
      case 'show_message':
        break;
    }
  }
}

describe("arbStack with every Action type ('all' mode)", () => {
  let actions: Action[] = [];
  let stacks: Stack[] = [];

  beforeAll(() => {
    stacks = fc.sample(arbStack, { numRuns: SAMPLE_SIZE, seed: getTestSeed() });
    actions = stacks.flatMap(allActions);
  }, SLOW);

  it('uses the right reference kinds in every generated Action', () => {
    for (const stack of stacks.slice(0, 100)) {
      for (const handler of handlers(stack)) {
        checkReferenceKinds(stack, handler);
      }
    }
  });

  it('names AI Fields as set_value targets and sources, and as append_item sources', () => {
    let target = false;
    let source = false;
    let appendSource = false;
    for (const stack of stacks) {
      const kinds = kindsById(stack);
      for (const action of allActions(stack)) {
        if (action.type === 'set_value') {
          target ||= kinds.get(action.targetObjectId) === 'ai-field';
          source ||= kinds.get(action.fromObjectId ?? '') === 'ai-field';
        } else if (action.type === 'append_item') {
          appendSource ||= kinds.get(action.fromObjectId ?? '') === 'ai-field';
        }
      }
    }
    expect(target).toBe(true);
    expect(source).toBe(true);
    expect(appendSource).toBe(true);
  });

  it('generates fetch_news with 1 and 10 topics, and topics of 1 and 100 code points', () => {
    const news = actions.filter((a) => a.type === 'fetch_news');
    expect(news.length).toBeGreaterThan(0);
    const counts = new Set(news.map((a) => a.topics.length));
    expect(counts.has(LIMITS.newsTopics.min)).toBe(true);
    expect(counts.has(LIMITS.newsTopics.max)).toBe(true);
    const lengths = news.flatMap((a) => a.topics.map((topic) => [...topic].length));
    expect(lengths).toContain(LIMITS.newsTopicText.min);
    expect(lengths).toContain(LIMITS.newsTopicText.max);
  });

  it('generates schedule_notification with a valid UTC `at` and with `atFromObjectId`', () => {
    const notifications = actions.filter((a) => a.type === 'schedule_notification');
    const withAt = notifications.filter((a) => a.at !== undefined);
    expect(withAt.length).toBeGreaterThan(0);
    for (const action of withAt) {
      expect(isValidUtcTimestamp(action.at)).toBe(true);
    }
    expect(notifications.some((a) => a.atFromObjectId !== undefined)).toBe(true);
    const lengths = notifications.map((a) => [...a.message].length);
    expect(lengths).toContain(LIMITS.notificationMessage.min);
    expect(lengths).toContain(LIMITS.notificationMessage.max);
  });

  it('generates remove_item with index 0 and larger indexes, and show_message at both text limits', () => {
    const indexes = actions.filter((a) => a.type === 'remove_item').map((a) => a.index);
    expect(indexes).toContain(LIMITS.removeItemIndex.min);
    expect(indexes.some((index) => index > 0)).toBe(true);
    const lengths = actions.filter((a) => a.type === 'show_message').map((a) => [...a.text].length);
    expect(lengths).toContain(LIMITS.messageText.min);
    expect(lengths).toContain(LIMITS.messageText.max);
  });
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
