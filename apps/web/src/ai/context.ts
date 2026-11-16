import { ENTITY_ID_PATTERN, LIMITS } from '@hypergeist/shared/format';
import type { Card, Stack, StackObject } from '@hypergeist/shared/format';

/*
 * The context the model sees with every request: a compact JSON text about the stack.
 *
 * The text is JSON, so every string taken from the stack is a quoted, escaped value and
 * never a bare instruction. The builder is a pure function of its three arguments.
 *
 * Reduction order. The builder renders the context at the first level below and stops
 * at the first level whose text is at most CONTEXT_MAX_CHARS UTF-16 units long. Each
 * level keeps what the level before it removed, so the levels only shrink.
 *   1. Full detail. Strings are cut to 200 code points.
 *   2. Strings are cut to 80 code points.
 *   3. The objects of the current card become one-line summaries.
 *   4. At most 50 cards are listed (the current card and the start card always stay).
 *   5. `links` and `onOpen` of the current card are dropped.
 *   6. Safety net, because steps 1 to 5 alone do not bound a card with 100 objects:
 *      strings 40, summary text 20, at most 20 cards, 5 link targets per card,
 *      30 summaries, 20 items per list.
 *   7. Strings 20, summary text 10, 5 cards, 2 link targets, 10 summaries, 5 items.
 *   8. Strings 10, no card list, no summaries, 2 items. This level always fits.
 * The selected object is never summarised: it has its own full section at every level.
 * Every removal adds a sentence to `omitted`, inside the text, so the model knows what
 * it cannot see.
 */

/** The text of a context is never longer than this many UTF-16 units. */
export const CONTEXT_MAX_CHARS = 12_000;

/** What `buildContext` returns. */
export type BuiltContext = {
  /** The JSON text to put into the request. */
  readonly text: string;
  /** The `omitted` sentences of the text, plus notes about ids that were not found. */
  readonly notes: readonly string[];
};

type Level = {
  /** Cut for names and for strings in full objects, in code points. */
  readonly textCut: number;
  /** Cut for `label` and `value` in one-line summaries, in code points. */
  readonly summaryCut: number;
  /** The objects of the current card are one-line summaries. */
  readonly summaries: boolean;
  /** At most this many summaries are listed. */
  readonly maxSummaries: number;
  /** At most this many cards are listed. */
  readonly maxCards: number;
  /** At most this many link targets are listed for a card. */
  readonly maxLinkTargets: number;
  /** At most this many items of any array in a full object. */
  readonly maxItems: number;
  /** The current card keeps `links` and `onOpen`. */
  readonly cardDetail: boolean;
};

const ALL = Number.POSITIVE_INFINITY;

const LEVELS: readonly Level[] = [
  {
    textCut: 200,
    summaryCut: 40,
    summaries: false,
    maxSummaries: ALL,
    maxCards: ALL,
    maxLinkTargets: ALL,
    maxItems: ALL,
    cardDetail: true,
  },
  {
    textCut: 80,
    summaryCut: 40,
    summaries: false,
    maxSummaries: ALL,
    maxCards: ALL,
    maxLinkTargets: ALL,
    maxItems: ALL,
    cardDetail: true,
  },
  {
    textCut: 80,
    summaryCut: 40,
    summaries: true,
    maxSummaries: ALL,
    maxCards: ALL,
    maxLinkTargets: ALL,
    maxItems: ALL,
    cardDetail: true,
  },
  {
    textCut: 80,
    summaryCut: 40,
    summaries: true,
    maxSummaries: ALL,
    maxCards: 50,
    maxLinkTargets: ALL,
    maxItems: ALL,
    cardDetail: true,
  },
  {
    textCut: 80,
    summaryCut: 40,
    summaries: true,
    maxSummaries: ALL,
    maxCards: 50,
    maxLinkTargets: ALL,
    maxItems: ALL,
    cardDetail: false,
  },
  {
    textCut: 40,
    summaryCut: 20,
    summaries: true,
    maxSummaries: 30,
    maxCards: 20,
    maxLinkTargets: 5,
    maxItems: 20,
    cardDetail: false,
  },
  {
    textCut: 20,
    summaryCut: 10,
    summaries: true,
    maxSummaries: 10,
    maxCards: 5,
    maxLinkTargets: 2,
    maxItems: 5,
    cardDetail: false,
  },
  {
    textCut: 10,
    summaryCut: 0,
    summaries: true,
    maxSummaries: 0,
    maxCards: 0,
    maxLinkTargets: 0,
    maxItems: 2,
    cardDetail: false,
  },
];

/** Keys whose string values are ids or fixed words. They are never cut. */
const UNCUT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'at',
  'cardId',
  'targetCardId',
  'targetObjectId',
  'fromObjectId',
  'atFromObjectId',
  'inputObjectIds',
]);

/** What a render counts, to write the `omitted` sentences. */
type Tally = { cuts: number; shortened: number };

/**
 * Cuts `value` to `max` code points (never in the middle of a surrogate pair) and ends
 * it with a marker that says how many code points were removed.
 */
function cutText(value: string, max: number, tally: Tally): string {
  // The UTF-16 length is never smaller than the code point count, so this is exact.
  if (value.length <= max) return value;
  let count = 0;
  let endIndex = 0;
  for (const codePoint of value) {
    if (count < max) endIndex += codePoint.length;
    count += 1;
  }
  if (count <= max) return value;
  tally.cuts += 1;
  return `${value.slice(0, endIndex)}…[${count - max} more characters]`;
}

/** Copies a JSON value with strings cut and arrays shortened. Never changes the input. */
function shrink(value: unknown, key: string | undefined, level: Level, tally: Tally): unknown {
  if (typeof value === 'string') {
    return key !== undefined && UNCUT_KEYS.has(key) ? value : cutText(value, level.textCut, tally);
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    let kept = items;
    if (items.length > level.maxItems) {
      kept = items.slice(0, level.maxItems);
      tally.shortened += 1;
    }
    return kept.map((item) => shrink(item, key, level, tally));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, inner]) => [name, shrink(inner, name, level, tally)]),
    );
  }
  return value;
}

/** A one-line summary of an object: where it is, how big it is, and a little of its text. */
function summarize(object: StackObject, level: Level, tally: Tally): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: object.id,
    type: object.type,
    name: cutText(object.name, level.textCut, tally),
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
  };
  if (object.type === 'button') {
    summary['label'] = cutText(object.label, level.summaryCut, tally);
  } else if (object.type === 'field' || object.type === 'ai-field') {
    summary['value'] = cutText(object.value, level.summaryCut, tally);
  } else if (object.type === 'list') {
    summary['itemCount'] = object.items.length;
  }
  return summary;
}

/** The link targets of a card, without repeats, in link order. */
function linkTargets(card: Card): string[] {
  const targets: string[] = [];
  for (const link of card.links) {
    if (!targets.includes(link.targetCardId)) targets.push(link.targetCardId);
  }
  return targets;
}

/** The indices of the cards to list: the current card and the start card first, then in order. */
function listedCardIndices(
  stack: Stack,
  currentCardId: string,
  maxCards: number,
): readonly number[] {
  const total = stack.cards.length;
  if (maxCards >= total) return stack.cards.map((_card, index) => index);
  const chosen = new Set<number>();
  for (const wanted of [currentCardId, stack.startCardId]) {
    const index = stack.cards.findIndex((card) => card.id === wanted);
    if (index >= 0 && chosen.size < maxCards) chosen.add(index);
  }
  for (let index = 0; index < total && chosen.size < maxCards; index += 1) chosen.add(index);
  return [...chosen].sort((a, b) => a - b);
}

/** The numbers the model must respect. Built from `LIMITS`, so there is one source. */
function buildLimits(): Record<string, unknown> {
  return {
    cards: LIMITS.cards.max,
    objectsPerCard: LIMITS.objectsPerCard.max,
    linksPerCard: LIMITS.linksPerCard.max,
    actionsPerHandler: LIMITS.handlerActions.max,
    listItems: LIMITS.listItems.max,
    aiInputObjects: LIMITS.aiInputObjects.max,
    newsTopics: LIMITS.newsTopics.max,
    cardSize: { min: LIMITS.cardSize.min, max: LIMITS.cardSize.max },
    objectSize: { min: LIMITS.objectSize.min, max: LIMITS.objectSize.max },
    objectPositionMax: LIMITS.objectPosition.max,
    objectMustFitOnCard: 'x + width at most cardWidth, and y + height at most cardHeight',
    idPattern: ENTITY_ID_PATTERN.source,
    textLength: {
      stackName: LIMITS.stackName.max,
      cardName: LIMITS.cardName.max,
      objectName: LIMITS.objectName.max,
      linkLabel: LIMITS.linkLabel.max,
      buttonLabel: LIMITS.buttonLabel.max,
      fieldValue: LIMITS.fieldValue.max,
      fieldPlaceholder: LIMITS.fieldPlaceholder.max,
      listItem: LIMITS.listItemText.max,
      setValueText: LIMITS.setValueText.max,
      appendItemText: LIMITS.appendItemText.max,
      messageText: LIMITS.messageText.max,
      imageAlt: LIMITS.imageAlt.max,
      aiPrompt: LIMITS.aiPrompt.max,
      aiFieldValue: LIMITS.aiFieldValue.max,
      newsTopic: LIMITS.newsTopicText.max,
      notificationMessage: LIMITS.notificationMessage.max,
    },
  };
}

type Rendered = { readonly text: string; readonly omitted: readonly string[] };

function render(
  stack: Stack,
  currentCard: Card | undefined,
  selectedObject: StackObject | undefined,
  level: Level,
  currentCardId: string,
): Rendered {
  const tally: Tally = { cuts: 0, shortened: 0 };
  const omitted: string[] = [];

  const stackSection = {
    id: stack.id,
    name: cutText(stack.name, level.textCut, tally),
    cardWidth: stack.cardWidth,
    cardHeight: stack.cardHeight,
    startCardId: stack.startCardId,
  };

  const listed = listedCardIndices(stack, currentCardId, level.maxCards);
  const cardsSection = listed.flatMap((index) => {
    const card = stack.cards[index];
    if (card === undefined) return [];
    const targets = linkTargets(card);
    return [
      {
        id: card.id,
        name: cutText(card.name, level.textCut, tally),
        objectCount: card.objects.length,
        linksTo: targets.slice(0, level.maxLinkTargets),
      },
    ];
  });
  const unlisted = stack.cards.length - listed.length;
  if (unlisted > 0) omitted.push(`and ${unlisted} more cards are not listed.`);
  const targetsCapped = listed.some((index) => {
    const card = stack.cards[index];
    return card !== undefined && linkTargets(card).length > level.maxLinkTargets;
  });
  if (targetsCapped) {
    omitted.push(
      `Only the first ${level.maxLinkTargets} link targets of each listed card are shown.`,
    );
  }

  let currentSection: Record<string, unknown> | null = null;
  if (currentCard !== undefined) {
    let objects: unknown[];
    if (level.summaries) {
      const shown = currentCard.objects.slice(0, level.maxSummaries);
      objects = shown.map((object) => summarize(object, level, tally));
      if (currentCard.objects.length > 0) {
        omitted.push(
          'The objects of the current card are one-line summaries; the selected object, if any, is shown in full in selectedObject.',
        );
      }
      const hidden = currentCard.objects.length - shown.length;
      if (hidden > 0) {
        omitted.push(`and ${hidden} more objects of the current card are not listed.`);
      }
    } else {
      objects = currentCard.objects.map((object) => shrink(object, undefined, level, tally));
    }
    currentSection = {
      id: currentCard.id,
      name: cutText(currentCard.name, level.textCut, tally),
      objects,
    };
    if (level.cardDetail) {
      currentSection['links'] = shrink(currentCard.links, 'links', level, tally);
      currentSection['onOpen'] = shrink(currentCard.onOpen, 'onOpen', level, tally);
    } else if (currentCard.links.length > 0 || currentCard.onOpen.length > 0) {
      omitted.push('The links and the onOpen actions of the current card are left out.');
    }
  }

  const selectedSection =
    selectedObject === undefined ? null : shrink(selectedObject, undefined, level, tally);

  if (tally.cuts > 0) {
    omitted.push(
      `Text longer than ${level.textCut} characters was cut; a cut ends with …[N more characters].`,
    );
  }
  if (tally.shortened > 0) {
    omitted.push(
      `Lists longer than ${level.maxItems} items show only their first ${level.maxItems}.`,
    );
  }

  const text = JSON.stringify({
    stack: stackSection,
    limits: buildLimits(),
    cards: cardsSection,
    currentCard: currentSection,
    selectedObject: selectedSection,
    omitted,
  });
  return { text, omitted };
}

/** Used only when even the last level is too long, which a valid stack cannot cause. */
const FALLBACK_NOTE = 'The stack is too large to describe. Ask the user to open a smaller card.';

/**
 * Builds the context text for one request. Pure and deterministic: the same stack,
 * current card id and selected object id always give the same text. `selectedObjectId`
 * is looked up on the current card only.
 */
export function buildContext(
  stack: Stack,
  currentCardId: string,
  selectedObjectId?: string | null,
): BuiltContext {
  const currentCard = stack.cards.find((card) => card.id === currentCardId);
  const selectedObject =
    selectedObjectId === undefined || selectedObjectId === null
      ? undefined
      : currentCard?.objects.find((object) => object.id === selectedObjectId);

  const warnings: string[] = [];
  if (currentCard === undefined) {
    warnings.push('The current card was not found in the stack.');
  }
  if (selectedObjectId !== undefined && selectedObjectId !== null && selectedObject === undefined) {
    warnings.push('The selected object was not found on the current card.');
  }

  for (const level of LEVELS) {
    const rendered = render(stack, currentCard, selectedObject, level, currentCardId);
    if (rendered.text.length <= CONTEXT_MAX_CHARS) {
      return { text: rendered.text, notes: [...rendered.omitted, ...warnings] };
    }
  }
  const omitted = [FALLBACK_NOTE];
  return { text: JSON.stringify({ omitted }), notes: [...omitted, ...warnings] };
}
