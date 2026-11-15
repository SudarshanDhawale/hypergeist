import * as fc from 'fast-check';
import { LIMITS } from '../src/format/index.ts';
import type {
  Action,
  AiFieldObject,
  ButtonObject,
  FieldObject,
  Handler,
  ImageObject,
  ListObject,
  Stack,
  StackObject,
} from '../src/format/index.ts';

/*
 * fast-check generators for the format.
 *
 * - `arbStack`: valid stacks (they pass `validateStack`), covering every Object type, every
 *   Action type, Links, and the limits at their minimum and maximum.
 * - `arbImageSrc`: valid Image sources (https URLs and data URIs of all four types).
 * - `arbHandlerFor(stack, mode)`: valid Handlers over the ids of one given stack, in the four
 *   executable Action types (default) or all nine (`'all'`).
 * - `arbMutation`: a valid stack with exactly one mutation that makes it invalid.
 * - `arbCandidate`: anything a caller might hand to `validateStack`.
 *
 * Everything here is pure: the same seed gives the same values.
 */

/* ---------- text and ids ---------- */

/**
 * Hostile single code points: the characters JSON must escape (`"`, `\`, line breaks, tab,
 * NUL and other control characters), the pointer metacharacters, the line separators
 * U+2028 and U+2029, the byte order mark, and two noncharacters.
 */
const HOSTILE_UNITS = [
  '"',
  '\\',
  '\n',
  '\r',
  '\t',
  '/',
  '~',
  '\u0000',
  '\u001f',
  '\u007f',
  '\u2028',
  '\u2029',
  '\ufeff',
  '\ufffe',
  '\uffff',
  '😀',
] as const;

/** One lone UTF-16 surrogate (high or low). It is one code point and one UTF-16 code unit. */
const arbLoneSurrogate: fc.Arbitrary<string> = fc
  .integer({ min: 0xd800, max: 0xdfff })
  .map((unit) => String.fromCharCode(unit));

function isLoneHigh(unit: string): boolean {
  const code = unit.charCodeAt(unit.length - 1);
  return unit.length === 1 && code >= 0xd800 && code <= 0xdbff;
}

function isLoneLow(unit: string): boolean {
  const code = unit.charCodeAt(0);
  return unit.length === 1 && code >= 0xdc00 && code <= 0xdfff;
}

/**
 * One Unicode code point per value: ASCII, Latin and BMP letters, astral characters, hostile
 * characters, and lone surrogates. Concatenating units can fuse a lone high surrogate and a
 * lone low surrogate into one astral code point, which would change the code point count;
 * `arbCodePointString` prevents that.
 */
const arbCodePoint: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.integer({ min: 0x20, max: 0x7e }).map((cp) => String.fromCodePoint(cp)),
  },
  {
    weight: 1,
    arbitrary: fc.integer({ min: 0xa0, max: 0xd7ff }).map((cp) => String.fromCodePoint(cp)),
  },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp)),
  },
  { weight: 1, arbitrary: fc.constantFrom(...HOSTILE_UNITS) },
  { weight: 1, arbitrary: arbLoneSurrogate },
);

/**
 * A string of `minLength` to `maxLength` code points built from `arbCodePoint`. A lone low
 * surrogate that would fuse with the lone high surrogate before it is replaced, so the
 * string has exactly as many code points as units drawn.
 */
function arbCodePointString(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc.array(arbCodePoint, { minLength, maxLength }).map((units) => {
    let previous = '';
    return units
      .map((unit) => {
        const safe = isLoneHigh(previous) && isLoneLow(unit) ? '\ufffd' : unit;
        previous = safe;
        return safe;
      })
      .join('');
  });
}

/** Single-code-point strings used to build the exact-minimum and exact-maximum texts. */
const EDGE_UNITS = ['a', 'é', '😀', '"', '\\', '\n', '\ud800', '\udc00'] as const;
/** Units for the long maxima: ASCII, with `"` as the one escaped character, so the document stays small. */
const LONG_EDGE_UNITS = ['a', '"'] as const;

function atMin(min: number): fc.Arbitrary<string> {
  return fc.constantFrom(...EDGE_UNITS).map((unit) => unit.repeat(min));
}

/** Exactly `max` code points. */
function atMax(max: number): fc.Arbitrary<string> {
  const units = max > 1000 ? LONG_EDGE_UNITS : EDGE_UNITS;
  return fc.constantFrom(...units).map((unit) => unit.repeat(max));
}

/**
 * Text of `min` to `max` code points. Usually short. With `edges`, exactly `min` and exactly
 * `max` code points also appear, so the limits themselves are exercised.
 */
function arbText(min: number, max: number, edges: boolean): fc.Arbitrary<string> {
  const short = arbCodePointString(min, Math.min(max, min + 24));
  if (!edges) {
    return short;
  }
  return fc.oneof(
    { weight: 12, arbitrary: short },
    { weight: 1, arbitrary: atMin(min) },
    { weight: 1, arbitrary: atMax(max) },
  );
}

const ID_HEAD = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
const ID_TAIL = [...ID_HEAD, '_', '-'];

/**
 * Valid ids that are also names of built-in properties (`constructor` is on every object,
 * `length` and `then` are special on arrays and promises). Code that keeps ids as keys of a
 * plain object, or tests `id in object`, breaks on these.
 */
const SPECIAL_IDS = ['constructor', 'prototype', 'length', 'then', 'name'] as const;

/**
 * An Entity_ID: 1 character, 2 to 12 characters, the 64-character maximum, or (rarely) a
 * name of a built-in property.
 */
export const arbEntityId: fc.Arbitrary<string> = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom(...ID_HEAD) },
  { weight: 1, arbitrary: fc.constantFrom(...SPECIAL_IDS) },
  {
    weight: 10,
    arbitrary: fc
      .tuple(
        fc.constantFrom(...ID_HEAD),
        fc.string({ unit: fc.constantFrom(...ID_TAIL), minLength: 1, maxLength: 11 }),
      )
      .map(([head, tail]) => head + tail),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        fc.constantFrom(...ID_HEAD),
        fc.string({ unit: fc.constantFrom(...ID_TAIL), minLength: 63, maxLength: 63 }),
      )
      .map(([head, tail]) => head + tail),
  },
);

function arbUniqueIds(count: number): fc.Arbitrary<string[]> {
  return fc.uniqueArray(arbEntityId, { minLength: count, maxLength: count });
}

/* ---------- geometry ---------- */

const arbCardDimension: fc.Arbitrary<number> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: LIMITS.cardSize.min, max: LIMITS.cardSize.max }) },
  { weight: 2, arbitrary: fc.constant(LIMITS.cardSize.min) },
  { weight: 2, arbitrary: fc.constant(LIMITS.cardSize.max) },
  { weight: 2, arbitrary: fc.constant(512) },
);

function arbSize(limit: number): fc.Arbitrary<number> {
  return fc.oneof(
    { weight: 8, arbitrary: fc.integer({ min: LIMITS.objectSize.min, max: limit }) },
    { weight: 2, arbitrary: fc.constant(LIMITS.objectSize.min) },
    { weight: 2, arbitrary: fc.constant(limit) },
  );
}

function arbPosition(maxPosition: number): fc.Arbitrary<number> {
  return fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: 0, max: maxPosition }) },
    { weight: 1, arbitrary: fc.constant(0) },
    // Flush with the far edge of the card: x + width equals the card size.
    { weight: 2, arbitrary: fc.constant(maxPosition) },
  );
}

type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** An in-bounds box. `x + width <= cardWidth` and `y + height <= cardHeight` always hold. */
function arbBox(cardWidth: number, cardHeight: number): fc.Arbitrary<Box> {
  return fc
    .tuple(arbSize(cardWidth), arbSize(cardHeight))
    .chain(([width, height]) =>
      fc
        .tuple(arbPosition(cardWidth - width), arbPosition(cardHeight - height))
        .map(([x, y]): Box => ({ x, y, width, height })),
    );
}

/* ---------- objects ---------- */

const KINDS = ['button', 'field', 'image', 'list', 'ai-field'] as const;
type Kind = (typeof KINDS)[number];

/* ---------- image sources ---------- */

const DATA_IMAGE_TYPES = ['png', 'jpeg', 'gif', 'webp'] as const;
type DataImageType = (typeof DATA_IMAGE_TYPES)[number];

/** The longest `src` the format allows for an `https:` URL. */
const HTTPS_SRC_MAX = LIMITS.imageHttpsSrc.max;
/** The longest `src` the format allows for a data URI. */
const DATA_SRC_MAX = LIMITS.imageDataSrc.max;

const HOST_CHARS = [...'abcdefghijklmnopqrstuvwxyz0123456789-'];
const URL_TAIL_CHARS = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~/%?#=&+',
];

/** A short `https:` URL: a host, and often a path, query, or fragment. */
const arbShortHttps: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ unit: fc.constantFrom(...HOST_CHARS), minLength: 1, maxLength: 20 }),
    fc.constantFrom('com', 'org', 'io', 'net'),
    fc.oneof(
      { weight: 1, arbitrary: fc.constant('') },
      {
        weight: 3,
        arbitrary: fc
          .string({ unit: fc.constantFrom(...URL_TAIL_CHARS), minLength: 0, maxLength: 60 })
          .map((tail) => `/${tail}`),
      },
      {
        weight: 1,
        arbitrary: fc
          .string({ unit: fc.constantFrom(...URL_TAIL_CHARS), minLength: 0, maxLength: 20 })
          .map((tail) => `?${tail}`),
      },
    ),
  )
  .map(([host, tld, tail]) => `https://${host}.${tld}${tail}`);

/** An `https:` URL of exactly 2,000 characters (the longest allowed), and one of 1,999. */
function httpsOfLength(length: number): string {
  const head = 'https://example.com/';
  return head + 'a'.repeat(length - head.length);
}

const arbHttpsSrc: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: arbShortHttps },
  { weight: 1, arbitrary: fc.constant(httpsOfLength(HTTPS_SRC_MAX)) },
  { weight: 1, arbitrary: fc.constant(httpsOfLength(HTTPS_SRC_MAX - 1)) },
  { weight: 1, arbitrary: fc.constant('https://a') },
);

/** A small canonical base64 data URI. 1 to 3 bytes cover the `==`, `=`, and unpadded endings. */
const arbSmallDataUri: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...DATA_IMAGE_TYPES),
    fc.oneof(
      { weight: 1, arbitrary: fc.uint8Array({ minLength: 1, maxLength: 3 }) },
      { weight: 3, arbitrary: fc.uint8Array({ minLength: 1, maxLength: 64 }) },
    ),
  )
  .map(([type, bytes]) => `data:image/${type};base64,${Buffer.from(bytes).toString('base64')}`);

const largeDataUris = new Map<DataImageType, string>();

/**
 * The longest valid data URI of a type. A valid payload has a length that is a multiple of 4,
 * so the longest URI is 999,998 or 999,999 characters, the closest to the 1,000,000 limit.
 * Built once per type, because it is a megabyte of text.
 */
function largestDataUri(type: DataImageType): string {
  const cached = largeDataUris.get(type);
  if (cached !== undefined) {
    return cached;
  }
  const prefix = `data:image/${type};base64,`;
  const payloadLength = Math.floor((DATA_SRC_MAX - prefix.length) / 4) * 4;
  const uri = `${prefix}${'A'.repeat(payloadLength - 2)}==`;
  largeDataUris.set(type, uri);
  return uri;
}

function arbImageSrcFor(light: boolean): fc.Arbitrary<string> {
  const parts: { weight: number; arbitrary: fc.Arbitrary<string> }[] = [
    { weight: 80, arbitrary: arbHttpsSrc },
    { weight: 60, arbitrary: arbSmallDataUri },
  ];
  if (light) {
    // Rare: a megabyte of text.
    parts.push({
      weight: 1,
      arbitrary: fc.constantFrom(...DATA_IMAGE_TYPES).map(largestDataUri),
    });
  }
  return fc.oneof(...parts);
}

/**
 * Valid Image sources: short and 2,000-character `https:` URLs, data URIs of all four types,
 * and rarely the largest valid data URI (about 1,000,000 characters).
 */
export const arbImageSrc: fc.Arbitrary<string> = arbImageSrcFor(true);

/** A Card with at most this many Objects may use the expensive variants (500-item Lists, 10,000-character Fields). */
const LIGHT_CARD_MAX_OBJECTS = 6;

function arbFieldValue(light: boolean): fc.Arbitrary<string> {
  const parts: { weight: number; arbitrary: fc.Arbitrary<string> }[] = [
    { weight: 10, arbitrary: arbText(LIMITS.fieldValue.min, LIMITS.fieldValue.max, false) },
    { weight: 1, arbitrary: fc.constant('') },
    // Longer than a list item may be (500), so copying it into a List is a skipped Action.
    { weight: 2, arbitrary: arbCodePointString(501, 640) },
  ];
  if (light) {
    parts.push({ weight: 1, arbitrary: atMax(LIMITS.fieldValue.max) });
  }
  return fc.oneof(...parts);
}

function arbAiFieldValue(light: boolean): fc.Arbitrary<string> {
  const parts: { weight: number; arbitrary: fc.Arbitrary<string> }[] = [
    { weight: 10, arbitrary: arbText(LIMITS.aiFieldValue.min, LIMITS.aiFieldValue.max, false) },
    { weight: 2, arbitrary: fc.constant('') },
  ];
  if (light) {
    parts.push({ weight: 1, arbitrary: atMax(LIMITS.aiFieldValue.max) });
  }
  return fc.oneof(...parts);
}

function arbListItems(light: boolean): fc.Arbitrary<string[]> {
  const item = (edges: boolean) => arbText(LIMITS.listItemText.min, LIMITS.listItemText.max, edges);
  const parts: { weight: number; arbitrary: fc.Arbitrary<string[]> }[] = [
    { weight: 1, arbitrary: fc.constant([]) },
    { weight: 6, arbitrary: fc.array(item(light), { minLength: 1, maxLength: 8 }) },
  ];
  if (light) {
    const short = arbCodePointString(0, 3);
    parts.push(
      // A full List.
      {
        weight: 1,
        arbitrary: fc.array(short, {
          minLength: LIMITS.listItems.max,
          maxLength: LIMITS.listItems.max,
        }),
      },
      // A full List whose lines joined by newlines exceed 10,000 characters.
      {
        weight: 1,
        arbitrary: fc
          .constantFrom('a', 'b', '0')
          .map((unit) => Array.from({ length: LIMITS.listItems.max }, () => unit.repeat(20))),
      },
    );
  }
  return fc.oneof(...parts);
}

function arbObject(
  kind: Kind,
  id: string,
  cardWidth: number,
  cardHeight: number,
  light: boolean,
): fc.Arbitrary<StackObject> {
  const name = arbText(LIMITS.objectName.min, LIMITS.objectName.max, true);
  const box = arbBox(cardWidth, cardHeight);
  switch (kind) {
    case 'button':
      return fc
        .tuple(name, box, arbText(LIMITS.buttonLabel.min, LIMITS.buttonLabel.max, true))
        .map(([n, b, label]): ButtonObject => ({
          id,
          type: 'button',
          name: n,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          label,
          onClick: [],
        }));
    case 'field':
      return fc
        .tuple(
          name,
          box,
          arbFieldValue(light),
          arbText(LIMITS.fieldPlaceholder.min, LIMITS.fieldPlaceholder.max, true),
          fc.boolean(),
          fc.boolean(),
        )
        .map(([n, b, value, placeholder, multiline, readOnly]): FieldObject => ({
          id,
          type: 'field',
          name: n,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          value,
          placeholder,
          multiline,
          readOnly,
        }));
    case 'list':
      return fc
        .tuple(name, box, arbListItems(light), fc.boolean())
        .map(([n, b, items, ordered]): ListObject => ({
          id,
          type: 'list',
          name: n,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          items,
          ordered,
        }));
    case 'image':
      return fc
        .tuple(
          name,
          box,
          arbImageSrcFor(light),
          arbText(LIMITS.imageAlt.min, LIMITS.imageAlt.max, true),
        )
        .map(([n, b, src, alt]): ImageObject => ({
          id,
          type: 'image',
          name: n,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          src,
          alt,
        }));
    case 'ai-field':
      return fc
        .tuple(
          name,
          box,
          arbText(LIMITS.aiPrompt.min, LIMITS.aiPrompt.max, true),
          arbAiFieldValue(light),
        )
        .map(([n, b, prompt, value]): AiFieldObject => ({
          id,
          type: 'ai-field',
          name: n,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          prompt,
          // Filled in a second pass, once the ids of the sibling Objects are known.
          inputObjectIds: [],
          value,
        }));
  }
}

/** Distinct sibling ids an AI Field may read, 0 to 10 of them, never its own id. */
function arbInputIds(ownId: string, sources: readonly string[]): fc.Arbitrary<string[]> {
  const candidates = sources.filter((id) => id !== ownId);
  const cap = Math.min(LIMITS.aiInputObjects.max, candidates.length);
  // A fresh array per value, so no two generated Objects share one.
  const none = fc.constant(0).map((): string[] => []);
  if (cap === 0) {
    return none;
  }
  return fc.oneof(
    { weight: 1, arbitrary: none },
    { weight: 4, arbitrary: fc.shuffledSubarray(candidates, { minLength: 1, maxLength: cap }) },
    { weight: 1, arbitrary: fc.shuffledSubarray(candidates, { minLength: cap, maxLength: cap }) },
  );
}

/**
 * Second pass over the Objects of one Card: every AI Field gets `inputObjectIds` drawn from
 * the Field, List, and AI Field Objects on the same Card.
 */
function arbWithInputIds(objects: readonly StackObject[]): fc.Arbitrary<StackObject[]> {
  const sources = objects
    .filter((o) => o.type === 'field' || o.type === 'list' || o.type === 'ai-field')
    .map((o) => o.id);
  return fc.tuple(
    ...objects.map((object): fc.Arbitrary<StackObject> =>
      object.type === 'ai-field'
        ? arbInputIds(object.id, sources).map((inputObjectIds): StackObject => ({
            ...object,
            inputObjectIds,
          }))
        : fc.constant(object),
    ),
  );
}

/* ---------- handlers ---------- */

/**
 * Which Action types `arbHandlerFor` may produce.
 * - `'executable'`: the four types the executor runs (`go_to_card`, `show_message`,
 *   `set_value`, `append_item`). The engine property tests use this mode.
 * - `'all'`: all nine types. The five that are only validated (`remove_item`, `run_ai_field`,
 *   `fetch_news`, `transcribe_audio`, `schedule_notification`) are skipped by the executor,
 *   and `set_value` and `append_item` may also name an AI Field.
 */
export type HandlerMode = 'executable' | 'all';

/** The earliest and latest instants whose ISO string is a four-digit-year UTC timestamp. */
const TIMESTAMP_MIN = new Date('0000-01-01T00:00:00.000Z');
const TIMESTAMP_MAX = new Date('9999-12-31T23:59:59.999Z');

/** `at` values: any four-digit-year `Date` ISO string, plus whole-second and extreme instants. */
const arbTimestamp: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .date({ min: TIMESTAMP_MIN, max: TIMESTAMP_MAX, noInvalidDate: true })
      .map((date) => date.toISOString()),
  },
  { weight: 1, arbitrary: fc.constantFrom('2026-12-01T09:00:00Z', '2028-02-29T23:59:59Z') },
  {
    weight: 1,
    arbitrary: fc.constantFrom(TIMESTAMP_MIN, TIMESTAMP_MAX).map((date) => date.toISOString()),
  },
);

/** `remove_item.index`: the minimum 0, small and list-sized values, and the largest safe integer. */
const arbRemoveIndex: fc.Arbitrary<number> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(LIMITS.removeItemIndex.min) },
  { weight: 4, arbitrary: fc.nat({ max: LIMITS.listItems.max }) },
  { weight: 1, arbitrary: fc.constant(Number.MAX_SAFE_INTEGER) },
);

/** `fetch_news.topics`: 1 topic, 10 topics (both limits), or 2 to 9, each of 1 to 100 code points. */
const arbTopics: fc.Arbitrary<string[]> = fc.oneof(
  { weight: 1, arbitrary: topicList(LIMITS.newsTopics.min) },
  { weight: 1, arbitrary: topicList(LIMITS.newsTopics.max) },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: LIMITS.newsTopics.min + 1, max: LIMITS.newsTopics.max - 1 })
      .chain(topicList),
  },
);

function topicList(count: number): fc.Arbitrary<string[]> {
  return fc.array(arbText(LIMITS.newsTopicText.min, LIMITS.newsTopicText.max, true), {
    minLength: count,
    maxLength: count,
  });
}

/**
 * Valid Handlers of 0 to 20 Actions over the ids in `stack`, in every Action type the stack
 * has targets for. Actions the executor skips appear too (a Field longer than 500 characters
 * copied into a List, a List joined into a Field past 10,000 characters, a full List).
 *
 * `mode` defaults to `'executable'`, which keeps the four Action types the executor runs, so
 * the engine property tests behave as before. `'all'` adds the five validated-only Actions
 * with valid references and the values at the minimum and maximum of each limit, and lets
 * `set_value` and `append_item` name AI Fields.
 */
export function arbHandlerFor(
  stack: Stack,
  mode: HandlerMode = 'executable',
): fc.Arbitrary<Handler> {
  const all = mode === 'all';
  const cardIds: string[] = [];
  const fieldIds: string[] = [];
  const listIds: string[] = [];
  const aiFieldIds: string[] = [];
  for (const card of stack.cards) {
    cardIds.push(card.id);
    for (const object of card.objects) {
      if (object.type === 'field') {
        fieldIds.push(object.id);
      } else if (object.type === 'list') {
        listIds.push(object.id);
      } else if (object.type === 'ai-field' && all) {
        aiFieldIds.push(object.id);
      }
    }
  }
  // `set_value` writes to a Field or AI Field; it reads a Field, AI Field, or List.
  // `append_item` reads a Field or AI Field.
  const valueTargetIds = [...fieldIds, ...aiFieldIds];
  const textSourceIds = [...fieldIds, ...aiFieldIds];
  const anySourceIds = [...fieldIds, ...aiFieldIds, ...listIds];

  const parts: { weight: number; arbitrary: fc.Arbitrary<Action> }[] = [
    {
      weight: 2,
      arbitrary: fc
        .constantFrom(...cardIds)
        .map((cardId): Action => ({ type: 'go_to_card', cardId })),
    },
    {
      weight: 2,
      arbitrary: arbText(LIMITS.messageText.min, LIMITS.messageText.max, true).map(
        (text): Action => ({ type: 'show_message', text }),
      ),
    },
  ];
  if (valueTargetIds.length > 0) {
    parts.push(
      {
        weight: 3,
        arbitrary: fc
          .tuple(
            fc.constantFrom(...valueTargetIds),
            arbText(LIMITS.setValueText.min, LIMITS.setValueText.max, true),
          )
          .map(([targetObjectId, value]): Action => ({ type: 'set_value', targetObjectId, value })),
      },
      {
        weight: 2,
        arbitrary: fc
          .tuple(fc.constantFrom(...valueTargetIds), fc.constantFrom(...anySourceIds))
          .map(([targetObjectId, fromObjectId]): Action => ({
            type: 'set_value',
            targetObjectId,
            fromObjectId,
          })),
      },
    );
  }
  if (listIds.length > 0) {
    parts.push({
      weight: 3,
      arbitrary: fc
        .tuple(
          fc.constantFrom(...listIds),
          arbText(LIMITS.appendItemText.min, LIMITS.appendItemText.max, true),
        )
        .map(([targetObjectId, item]): Action => ({ type: 'append_item', targetObjectId, item })),
    });
    if (textSourceIds.length > 0) {
      parts.push({
        weight: 3,
        arbitrary: fc
          .tuple(fc.constantFrom(...listIds), fc.constantFrom(...textSourceIds))
          .map(([targetObjectId, fromObjectId]): Action => ({
            type: 'append_item',
            targetObjectId,
            fromObjectId,
          })),
      });
    }
  }
  if (all) {
    if (listIds.length > 0) {
      parts.push(
        {
          weight: 2,
          arbitrary: fc
            .tuple(fc.constantFrom(...listIds), arbRemoveIndex)
            .map(([targetObjectId, index]): Action => ({
              type: 'remove_item',
              targetObjectId,
              index,
            })),
        },
        {
          weight: 2,
          arbitrary: fc
            .tuple(fc.constantFrom(...listIds), arbTopics)
            .map(([targetObjectId, topics]): Action => ({
              type: 'fetch_news',
              targetObjectId,
              topics,
            })),
        },
      );
    }
    if (aiFieldIds.length > 0) {
      parts.push({
        weight: 2,
        arbitrary: fc
          .constantFrom(...aiFieldIds)
          .map((targetObjectId): Action => ({ type: 'run_ai_field', targetObjectId })),
      });
    }
    if (fieldIds.length > 0) {
      parts.push(
        {
          weight: 2,
          arbitrary: fc
            .constantFrom(...fieldIds)
            .map((targetObjectId): Action => ({ type: 'transcribe_audio', targetObjectId })),
        },
        {
          weight: 2,
          arbitrary: fc
            .tuple(
              arbText(LIMITS.notificationMessage.min, LIMITS.notificationMessage.max, true),
              fc.constantFrom(...fieldIds),
            )
            .map(([message, atFromObjectId]): Action => ({
              type: 'schedule_notification',
              message,
              atFromObjectId,
            })),
        },
      );
    }
    parts.push({
      weight: 2,
      arbitrary: fc
        .tuple(
          arbText(LIMITS.notificationMessage.min, LIMITS.notificationMessage.max, true),
          arbTimestamp,
        )
        .map(([message, at]): Action => ({ type: 'schedule_notification', message, at })),
    });
  }

  const action = fc.oneof(...parts);
  const length = fc.oneof(
    { weight: 2, arbitrary: fc.constant(LIMITS.handlerActions.min) },
    { weight: 8, arbitrary: fc.integer({ min: 1, max: 3 }) },
    { weight: 2, arbitrary: fc.integer({ min: 4, max: LIMITS.handlerActions.max - 1 }) },
    { weight: 1, arbitrary: fc.constant(LIMITS.handlerActions.max) },
  );
  return length.chain((n) => fc.array(action, { minLength: n, maxLength: n }));
}

/* ---------- stacks ---------- */

type CardShape = { readonly kinds: readonly Kind[]; readonly linkCount: number };

const arbKind: fc.Arbitrary<Kind> = fc.constantFrom(...KINDS);

/**
 * The Card and Link maximums: 200 Cards, light ones (at most one Object, at most one Link),
 * except the first, which has the 50 Links a Card may hold (to 50 distinct other Cards).
 */
const arbMaxCardsShape: fc.Arbitrary<CardShape[]> = fc
  .array(
    fc.record({
      kinds: fc.array(arbKind, { minLength: 0, maxLength: 1 }),
      linkCount: fc.integer({ min: 0, max: 1 }),
    }),
    { minLength: LIMITS.cards.max, maxLength: LIMITS.cards.max },
  )
  .map((cards) =>
    cards.map((card, index) =>
      index === 0 ? { ...card, linkCount: LIMITS.linksPerCard.max } : card,
    ),
  );

const arbSmallShape: fc.Arbitrary<CardShape[]> = fc.array(
  fc.record({
    kinds: fc.oneof(
      {
        weight: 20,
        arbitrary: fc.array(arbKind, { minLength: 0, maxLength: LIGHT_CARD_MAX_OBJECTS }),
      },
      // A Card at the 100-Object maximum.
      {
        weight: 1,
        arbitrary: fc.array(arbKind, {
          minLength: LIMITS.objectsPerCard.max,
          maxLength: LIMITS.objectsPerCard.max,
        }),
      },
    ),
    linkCount: fc.integer({ min: 0, max: 5 }),
  }),
  { minLength: 1, maxLength: 5 },
);

/** Mostly 1 to 5 Cards. Rarely the 200-Card maximum with a 50-Link Card. */
const arbShape: fc.Arbitrary<CardShape[]> = fc.oneof(
  { weight: 40, arbitrary: arbSmallShape },
  { weight: 1, arbitrary: arbMaxCardsShape },
);

/** The stack's text, indented as the validator measures it, must stay well under 2 MiB. */
const SIZE_BUDGET_BYTES = 1_900_000;

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    // A programmer error in this file, never a property of the generated data.
    throw new Error(`arbitraries: ${what} is missing`);
  }
  return value;
}

/** A valid stack whose Handlers are all empty. */
function arbSkeleton(shape: readonly CardShape[]): fc.Arbitrary<Stack> {
  const cardCount = shape.length;
  const linkCounts = shape.map((card) => Math.min(card.linkCount, cardCount));
  const objectCount = shape.reduce((sum, card) => sum + card.kinds.length, 0);
  const linkTotal = linkCounts.reduce((sum, count) => sum + count, 0);
  // Stack id, Card ids, Object ids, Link ids. All unique, across kinds.
  const idCount = 1 + cardCount + objectCount + linkTotal;

  return fc
    .record({
      ids: arbUniqueIds(idCount),
      cardWidth: arbCardDimension,
      cardHeight: arbCardDimension,
      name: arbText(LIMITS.stackName.min, LIMITS.stackName.max, true),
      startIndex: fc.nat({ max: cardCount - 1 }),
    })
    .chain((base) => {
      let cursor = 0;
      const take = (): string => {
        const id = must(base.ids[cursor], 'an entity id');
        cursor += 1;
        return id;
      };
      const stackId = take();
      const cardIds = shape.map(() => take());

      const cards = shape.map((cardShape, cardIndex) => {
        const light = cardShape.kinds.length <= LIGHT_CARD_MAX_OBJECTS;
        const objects = cardShape.kinds.map((kind) =>
          arbObject(kind, take(), base.cardWidth, base.cardHeight, light),
        );
        const linkIds = Array.from({ length: linkCounts[cardIndex] ?? 0 }, take);
        const links = fc
          .tuple(
            fc.shuffledSubarray(cardIds, { minLength: linkIds.length, maxLength: linkIds.length }),
            fc.array(arbText(LIMITS.linkLabel.min, LIMITS.linkLabel.max, true), {
              minLength: linkIds.length,
              maxLength: linkIds.length,
            }),
          )
          .map(([targets, labels]) =>
            linkIds.map((id, i) => ({
              id,
              label: must(labels[i], 'a link label'),
              targetCardId: must(targets[i], 'a link target'),
            })),
          );
        return fc
          .tuple(
            arbText(LIMITS.cardName.min, LIMITS.cardName.max, true),
            fc.tuple(...objects).chain(arbWithInputIds),
            links,
          )
          .map(([name, cardObjects, cardLinks]) => ({
            id: must(cardIds[cardIndex], 'a card id'),
            name,
            objects: cardObjects,
            links: cardLinks,
            onOpen: [] as Handler,
          }));
      });

      // `remixedFrom` names another stack, so it is an id of its own. It may also happen to
      // equal an id inside this stack (the stack's own id or a Card id), which is valid.
      const remixedFrom: fc.Arbitrary<string | undefined> = fc.oneof(
        { weight: 3, arbitrary: fc.constant(undefined) },
        { weight: 3, arbitrary: arbEntityId },
        { weight: 1, arbitrary: fc.constant(stackId) },
        { weight: 1, arbitrary: fc.constantFrom(...cardIds) },
      );

      return fc.tuple(fc.tuple(...cards), remixedFrom).map(([builtCards, remixed]): Stack => ({
        formatVersion: 1,
        id: stackId,
        name: base.name,
        cardWidth: base.cardWidth,
        cardHeight: base.cardHeight,
        startCardId: must(cardIds[base.startIndex], 'the start card id'),
        ...(remixed === undefined ? {} : { remixedFrom: remixed }),
        cards: builtCards,
      }));
    });
}

/** Fills every Card `onOpen` and every Button `onClick` of `skeleton` with generated Handlers. */
function arbWithHandlers(skeleton: Stack): fc.Arbitrary<Stack> {
  // Format tests need every Action type; the engine tests ask `arbHandlerFor` for its own Handler.
  const handler = arbHandlerFor(skeleton, 'all');
  const slots: fc.Arbitrary<Handler>[] = [];
  for (const card of skeleton.cards) {
    slots.push(handler);
    for (const object of card.objects) {
      if (object.type === 'button') {
        slots.push(handler);
      }
    }
  }
  return fc.tuple(...slots).map((handlers) => {
    let next = 0;
    const take = (): Handler => handlers[next++] ?? [];
    return {
      ...skeleton,
      cards: skeleton.cards.map((card) => ({
        ...card,
        // Slot order: the Card's onOpen first, then its Buttons in document order.
        onOpen: take(),
        objects: card.objects.map((object) =>
          object.type === 'button' ? { ...object, onClick: take() } : object,
        ),
      })),
    };
  });
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Valid stacks: 1 to 5 Cards (rarely 200); all ids unique across kinds; in-bounds Objects of each type,
 * some flush with the card edge; Lists up to 500 items; Handlers up to 20 Actions over
 * existing ids; Links to distinct Cards; astral characters in text.
 */
export const arbStack: fc.Arbitrary<Stack> = arbShape
  .chain(arbSkeleton)
  .chain(arbWithHandlers)
  .filter((stack) => jsonByteLength(stack) <= SIZE_BUDGET_BYTES);

/* ---------- mutations ---------- */

export type Path = readonly (string | number)[];

export type MutationKind =
  'delete-property' | 'swap-type' | 'exceed-limit' | 'add-unknown-property' | 'retarget-reference';

export type Mutation = {
  readonly kind: MutationKind;
  /** Where the change was made (for an added property, the path of the new property). */
  readonly path: Path;
  /** The valid stack the mutation started from. It is never modified. */
  readonly original: Stack;
  /** A deep copy of `original` with exactly one change. Always fails `validateStack`. */
  readonly mutated: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAt(root: unknown, path: Path): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === 'number') {
      current = current[key];
    } else if (isRecord(current) && typeof key === 'string') {
      current = current[key];
    } else {
      throw new Error(`arbitraries: no value at ${JSON.stringify(path)}`);
    }
  }
  return current;
}

function setAt(root: unknown, path: Path, value: unknown): void {
  const parent = getAt(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (Array.isArray(parent) && typeof key === 'number') {
    parent[key] = value;
  } else if (isRecord(parent) && typeof key === 'string') {
    parent[key] = value;
  } else {
    throw new Error(`arbitraries: cannot set ${JSON.stringify(path)}`);
  }
}

function cloneJson(stack: Stack): unknown {
  return JSON.parse(JSON.stringify(stack));
}

type PathIndex = {
  /** Every property of every record, as a path. */
  readonly propertyPaths: Path[];
  /** Every property of every record and every array element. */
  readonly valuePaths: Path[];
  /** Every record node, including the root. */
  readonly recordPaths: Path[];
};

function indexPaths(root: unknown): PathIndex {
  const propertyPaths: Path[] = [];
  const valuePaths: Path[] = [];
  const recordPaths: Path[] = [];
  const visit = (value: unknown, path: Path): void => {
    if (Array.isArray(value)) {
      value.forEach((child, i) => {
        valuePaths.push([...path, i]);
        visit(child, [...path, i]);
      });
    } else if (isRecord(value)) {
      recordPaths.push(path);
      for (const key of Object.keys(value)) {
        propertyPaths.push([...path, key]);
        valuePaths.push([...path, key]);
        visit(value[key], [...path, key]);
      }
    }
  };
  visit(root, []);
  return { propertyPaths, valuePaths, recordPaths };
}

type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

const JSON_KINDS: readonly JsonKind[] = ['string', 'number', 'boolean', 'null', 'array', 'object'];

function jsonKindOf(value: unknown): JsonKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
}

function sampleOfKind(kind: JsonKind): unknown {
  switch (kind) {
    case 'string':
      return 'zz';
    case 'number':
      return 1.5;
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array':
      return [];
    case 'object':
      return {};
  }
}

/**
 * A place where a number, string, or array can leave its limit or its allowed set of values.
 * - `string`: more than `max` code points.
 * - `array`: more than `max` elements.
 * - `value`: one of `bad`, each a number or string the format rejects (a number below its
 *   minimum or above its maximum, a non-integer index, a malformed id, image source, or timestamp).
 */
type LimitSite =
  | { readonly kind: 'string'; readonly path: Path; readonly max: number }
  | { readonly kind: 'array'; readonly path: Path; readonly max: number }
  | { readonly kind: 'value'; readonly path: Path; readonly bad: readonly (string | number)[] };

/** An `https:` URL one character over the 2,000-character maximum. */
const OVERLONG_HTTPS_SRC = httpsOfLength(HTTPS_SRC_MAX + 1);

/** Strings that are not valid Entity_IDs. */
const BAD_IDS: readonly string[] = ['', 'A', '-a', '_a', 'a b', 'a.b', 'é', 'a'.repeat(65)];

/** Strings that are not valid Image sources (the length-limit case is `OVERLONG_HTTPS_SRC`). */
const BAD_IMAGE_SRCS: readonly string[] = [
  '',
  'https://',
  'http://example.com/a.png',
  'HTTPS://example.com/a.png',
  'https://exa mple.com',
  'https://user@example.com',
  'javascript:alert(1)',
  'data:image/svg+xml;base64,AAAA',
  'data:image/png;base64,',
  'data:image/png;base64,AAA',
  'data:image/png,AAAA',
  OVERLONG_HTTPS_SRC,
];

/** Strings that are not valid UTC timestamps. */
const BAD_TIMESTAMPS: readonly string[] = [
  '',
  'tomorrow',
  '2027-02-29T00:00:00Z',
  '2026-12-01T24:00:00Z',
  '2026-12-01T09:00:00',
  '2026-12-01T09:00Z',
  '2026-12-01T09:00:00z',
  '2026-12-01T09:00:00+01:00',
  '2026-13-01T09:00:00Z',
  '2026-12-01 09:00:00Z',
];

/** Every place a string or array has a maximum, and every place a value has a rejected form. */
function limitSites(stack: Stack): LimitSite[] {
  const sites: LimitSite[] = [
    { kind: 'string', path: ['name'], max: LIMITS.stackName.max },
    { kind: 'value', path: ['id'], bad: BAD_IDS },
    {
      kind: 'value',
      path: ['cardWidth'],
      bad: [LIMITS.cardSize.min - 1, LIMITS.cardSize.max + 1, 0, -1],
    },
    {
      kind: 'value',
      path: ['cardHeight'],
      bad: [LIMITS.cardSize.min - 1, LIMITS.cardSize.max + 1, 0, -1],
    },
  ];
  if (stack.remixedFrom !== undefined) {
    sites.push({ kind: 'value', path: ['remixedFrom'], bad: BAD_IDS });
  }
  const handlerSites = (handler: Handler, base: Path): void => {
    sites.push({ kind: 'array', path: base, max: LIMITS.handlerActions.max });
    handler.forEach((action, i) => {
      const at = [...base, i];
      switch (action.type) {
        case 'show_message':
          sites.push({ kind: 'string', path: [...at, 'text'], max: LIMITS.messageText.max });
          break;
        case 'set_value':
          if (action.value !== undefined) {
            sites.push({ kind: 'string', path: [...at, 'value'], max: LIMITS.setValueText.max });
          }
          break;
        case 'append_item':
          if (action.item !== undefined) {
            sites.push({ kind: 'string', path: [...at, 'item'], max: LIMITS.appendItemText.max });
          }
          break;
        case 'remove_item':
          // The index is an integer from 0 up: -1 is below the minimum, 1.5 is not an integer.
          sites.push({
            kind: 'value',
            path: [...at, 'index'],
            bad: [LIMITS.removeItemIndex.min - 1, 1.5, -1_000_000],
          });
          break;
        case 'fetch_news':
          sites.push({ kind: 'array', path: [...at, 'topics'], max: LIMITS.newsTopics.max });
          sites.push({
            kind: 'string',
            path: [...at, 'topics', 0],
            max: LIMITS.newsTopicText.max,
          });
          break;
        case 'schedule_notification':
          sites.push({
            kind: 'string',
            path: [...at, 'message'],
            max: LIMITS.notificationMessage.max,
          });
          if (action.at !== undefined) {
            sites.push({ kind: 'value', path: [...at, 'at'], bad: BAD_TIMESTAMPS });
          }
          break;
        case 'go_to_card':
        case 'run_ai_field':
        case 'transcribe_audio':
          break;
      }
    });
  };
  stack.cards.forEach((card, ci) => {
    const cardPath: Path = ['cards', ci];
    sites.push({ kind: 'string', path: [...cardPath, 'name'], max: LIMITS.cardName.max });
    sites.push({ kind: 'array', path: [...cardPath, 'objects'], max: LIMITS.objectsPerCard.max });
    handlerSites(card.onOpen, [...cardPath, 'onOpen']);
    card.links.forEach((_, li) => {
      sites.push({
        kind: 'string',
        path: [...cardPath, 'links', li, 'label'],
        max: LIMITS.linkLabel.max,
      });
    });
    card.objects.forEach((object, oi) => {
      const at: Path = [...cardPath, 'objects', oi];
      sites.push({ kind: 'string', path: [...at, 'name'], max: LIMITS.objectName.max });
      sites.push({ kind: 'value', path: [...at, 'id'], bad: BAD_IDS });
      sites.push({
        kind: 'value',
        path: [...at, 'x'],
        bad: [LIMITS.objectPosition.min - 1, LIMITS.objectPosition.max + 1],
      });
      sites.push({
        kind: 'value',
        path: [...at, 'y'],
        bad: [LIMITS.objectPosition.min - 1, LIMITS.objectPosition.max + 1],
      });
      sites.push({
        kind: 'value',
        path: [...at, 'width'],
        bad: [LIMITS.objectSize.min - 1, LIMITS.objectSize.max + 1, 0],
      });
      sites.push({
        kind: 'value',
        path: [...at, 'height'],
        bad: [LIMITS.objectSize.min - 1, LIMITS.objectSize.max + 1, 0],
      });
      switch (object.type) {
        case 'button':
          sites.push({ kind: 'string', path: [...at, 'label'], max: LIMITS.buttonLabel.max });
          handlerSites(object.onClick, [...at, 'onClick']);
          break;
        case 'field':
          sites.push({ kind: 'string', path: [...at, 'value'], max: LIMITS.fieldValue.max });
          sites.push({
            kind: 'string',
            path: [...at, 'placeholder'],
            max: LIMITS.fieldPlaceholder.max,
          });
          break;
        case 'list':
          sites.push({ kind: 'array', path: [...at, 'items'], max: LIMITS.listItems.max });
          if (object.items.length > 0) {
            sites.push({
              kind: 'string',
              path: [...at, 'items', 0],
              max: LIMITS.listItemText.max,
            });
          }
          break;
        case 'image':
          sites.push({ kind: 'string', path: [...at, 'alt'], max: LIMITS.imageAlt.max });
          sites.push({ kind: 'value', path: [...at, 'src'], bad: BAD_IMAGE_SRCS });
          break;
        case 'ai-field':
          sites.push({ kind: 'string', path: [...at, 'prompt'], max: LIMITS.aiPrompt.max });
          sites.push({ kind: 'string', path: [...at, 'value'], max: LIMITS.aiFieldValue.max });
          sites.push({
            kind: 'array',
            path: [...at, 'inputObjectIds'],
            max: LIMITS.aiInputObjects.max,
          });
          break;
      }
    });
  });
  return sites;
}

type Category = 'card' | 'link' | StackObject['type'];
type ReferenceSite = {
  readonly path: Path;
  readonly allowed: readonly Category[];
  /** Ids that have an allowed kind but are still wrong at this site. */
  readonly alsoWrong?: readonly string[];
};

/** Every id property that must name an entity of a given kind. */
function referenceSites(stack: Stack): ReferenceSite[] {
  const sites: ReferenceSite[] = [{ path: ['startCardId'], allowed: ['card'] }];
  const handlerSites = (handler: Handler, base: Path): void => {
    handler.forEach((action, i) => {
      const at = [...base, i];
      switch (action.type) {
        case 'go_to_card':
          sites.push({ path: [...at, 'cardId'], allowed: ['card'] });
          break;
        case 'set_value':
          sites.push({ path: [...at, 'targetObjectId'], allowed: ['field', 'ai-field'] });
          if (action.fromObjectId !== undefined) {
            sites.push({
              path: [...at, 'fromObjectId'],
              allowed: ['field', 'ai-field', 'list'],
            });
          }
          break;
        case 'append_item':
          sites.push({ path: [...at, 'targetObjectId'], allowed: ['list'] });
          if (action.fromObjectId !== undefined) {
            sites.push({ path: [...at, 'fromObjectId'], allowed: ['field', 'ai-field'] });
          }
          break;
        case 'remove_item':
          sites.push({ path: [...at, 'targetObjectId'], allowed: ['list'] });
          break;
        case 'run_ai_field':
          sites.push({ path: [...at, 'targetObjectId'], allowed: ['ai-field'] });
          break;
        case 'fetch_news':
          sites.push({ path: [...at, 'targetObjectId'], allowed: ['list'] });
          break;
        case 'transcribe_audio':
          sites.push({ path: [...at, 'targetObjectId'], allowed: ['field'] });
          break;
        case 'schedule_notification':
          if (action.atFromObjectId !== undefined) {
            sites.push({ path: [...at, 'atFromObjectId'], allowed: ['field'] });
          }
          break;
        case 'show_message':
          break;
      }
    });
  };
  stack.cards.forEach((card, ci) => {
    const cardPath: Path = ['cards', ci];
    card.links.forEach((_, li) => {
      sites.push({ path: [...cardPath, 'links', li, 'targetCardId'], allowed: ['card'] });
    });
    handlerSites(card.onOpen, [...cardPath, 'onOpen']);
    // Ids of the Objects on the other Cards: an ai-field may not read them.
    const otherCardObjectIds = stack.cards
      .filter((_, other) => other !== ci)
      .flatMap((c) => c.objects.map((o) => o.id));
    card.objects.forEach((object, oi) => {
      const at: Path = [...cardPath, 'objects', oi];
      if (object.type === 'button') {
        handlerSites(object.onClick, [...at, 'onClick']);
      } else if (object.type === 'ai-field') {
        object.inputObjectIds.forEach((_, ii) => {
          sites.push({
            path: [...at, 'inputObjectIds', ii],
            allowed: ['field', 'list', 'ai-field'],
            // Also wrong: the ai-field itself, an Object on another Card, and an input that
            // an earlier entry already names (the later entry is the one reported).
            alsoWrong: [object.id, ...otherCardObjectIds, ...object.inputObjectIds.slice(0, ii)],
          });
        });
      }
    });
  });
  return sites;
}

function categoriesById(stack: Stack): Map<string, Category> {
  const categories = new Map<string, Category>();
  for (const card of stack.cards) {
    categories.set(card.id, 'card');
    for (const object of card.objects) {
      categories.set(object.id, object.type);
    }
    for (const link of card.links) {
      categories.set(link.id, 'link');
    }
  }
  return categories;
}

function mutateDelete(stack: Stack): fc.Arbitrary<Mutation> {
  const { propertyPaths } = indexPaths(stack);
  // Deleting `remixedFrom` leaves a valid stack, so it is not a mutation.
  const candidates = propertyPaths.filter(
    (path) => !(path.length === 1 && path[0] === 'remixedFrom'),
  );
  return fc.constantFrom(...candidates).map((path): Mutation => {
    const mutated = cloneJson(stack);
    const parent = getAt(mutated, path.slice(0, -1));
    const key = path[path.length - 1];
    if (isRecord(parent) && typeof key === 'string') {
      delete parent[key];
    }
    return { kind: 'delete-property', path, original: stack, mutated };
  });
}

function mutateSwap(stack: Stack): fc.Arbitrary<Mutation> {
  const { valuePaths } = indexPaths(stack);
  return fc.constantFrom(...valuePaths).chain((path) => {
    const current = jsonKindOf(getAt(stack, path));
    return fc
      .constantFrom(...JSON_KINDS.filter((kind) => kind !== current))
      .map((kind): Mutation => {
        const mutated = cloneJson(stack);
        setAt(mutated, path, sampleOfKind(kind));
        return { kind: 'swap-type', path, original: stack, mutated };
      });
  });
}

const OVERFLOW_BUTTON = {
  id: 'overflow-button',
  type: 'button',
  name: '',
  x: 0,
  y: 0,
  width: 8,
  height: 8,
  label: 'x',
  onClick: [],
} as const;

/** Units repeated to build an over-long string: ASCII, astral, and the hostile ones. */
const OVERFLOW_UNITS = ['a', '😀', '"', '\\', '\n', '\ud800'] as const;

function mutateExceed(stack: Stack): fc.Arbitrary<Mutation> {
  return fc
    .tuple(fc.constantFrom(...limitSites(stack)), fc.constantFrom(...OVERFLOW_UNITS))
    .chain(([site, unit]) => {
      const bad = site.kind === 'value' ? fc.constantFrom(...site.bad) : fc.constant(undefined);
      return bad.map((badValue): Mutation => {
        const mutated = cloneJson(stack);
        if (site.kind === 'value') {
          setAt(mutated, site.path, badValue);
        } else if (site.kind === 'string') {
          setAt(mutated, site.path, unit.repeat(site.max + 1));
        } else {
          const array = getAt(mutated, site.path);
          if (Array.isArray(array)) {
            const last = site.path[site.path.length - 1];
            while (array.length <= site.max) {
              if (last === 'objects') {
                array.push({ ...OVERFLOW_BUTTON });
              } else if (last === 'items') {
                array.push('x');
              } else if (last === 'topics') {
                array.push('x');
              } else if (last === 'inputObjectIds') {
                // Never an existing id, so the only difference is the length.
                array.push(`overflow-input-${array.length}`);
              } else {
                array.push({ type: 'show_message', text: 'x' });
              }
            }
          }
        }
        return { kind: 'exceed-limit', path: site.path, original: stack, mutated };
      });
    });
}

function mutateUnknown(stack: Stack): fc.Arbitrary<Mutation> {
  const { recordPaths } = indexPaths(stack);
  return (
    fc
      .tuple(
        fc.constantFrom(...recordPaths),
        // Keys that need escaping in a JSON Pointer or in JSON text, and keys that look like
        // real properties of another type (`src` on a button, `inputObjectIds` on a field).
        fc.constantFrom(
          'extra',
          'unknownProp',
          '_zz',
          'a/b',
          'a~b',
          '~0',
          '~1',
          '',
          ' ',
          'a"b',
          'a\\b',
          'a\nb',
          '\ud800',
          '😀',
          'constructor',
          'toString',
          'src',
          'alt',
          'prompt',
          'inputObjectIds',
          'topics',
          'index',
          'at',
          'atFromObjectId',
        ),
      )
      // Adding a key the record already has would replace a value, not add a property.
      .filter(([recordPath, key]) => {
        const record = getAt(stack, recordPath);
        return isRecord(record) && !Object.hasOwn(record, key);
      })
      .map(([recordPath, key]): Mutation => {
        const mutated = cloneJson(stack);
        const target = getAt(mutated, recordPath);
        if (isRecord(target)) {
          target[key] = 1;
        }
        return {
          kind: 'add-unknown-property',
          path: [...recordPath, key],
          original: stack,
          mutated,
        };
      })
  );
}

function mutateRetarget(stack: Stack): fc.Arbitrary<Mutation> {
  const categories = categoriesById(stack);
  let dangling = 'no-such-entity';
  while (categories.has(dangling)) {
    dangling += '-x';
  }
  return fc.constantFrom(...referenceSites(stack)).chain((site) => {
    const wrongKind = [
      ...[...categories]
        .filter(([, category]) => !site.allowed.includes(category))
        .map(([id]) => id),
      ...(site.alsoWrong ?? []),
    ];
    const replacement =
      wrongKind.length === 0
        ? fc.constant(dangling)
        : fc.oneof(fc.constant(dangling), fc.constantFrom(...wrongKind));
    return replacement.map((id): Mutation => {
      const mutated = cloneJson(stack);
      setAt(mutated, site.path, id);
      return { kind: 'retarget-reference', path: site.path, original: stack, mutated };
    });
  });
}

/** One mutation of the given valid stack. Each result is invalid. */
export function arbMutationFor(stack: Stack): fc.Arbitrary<Mutation> {
  const kinds: readonly MutationKind[] = [
    'delete-property',
    'swap-type',
    'exceed-limit',
    'add-unknown-property',
    'retarget-reference',
  ];
  return fc.constantFrom(...kinds).chain((kind) => {
    switch (kind) {
      case 'delete-property':
        return mutateDelete(stack);
      case 'swap-type':
        return mutateSwap(stack);
      case 'exceed-limit':
        return mutateExceed(stack);
      case 'add-unknown-property':
        return mutateUnknown(stack);
      case 'retarget-reference':
        return mutateRetarget(stack);
    }
  });
}

/** A valid stack with one mutation: delete a property, swap a value for another JSON type, exceed a limit, add an unknown property, or retarget a reference. */
export const arbMutation: fc.Arbitrary<Mutation> = arbStack.chain(arbMutationFor);

/* ---------- candidates ---------- */

/**
 * Anything `validateStack` may receive: arbitrary JSON values, JSON text, plain text,
 * valid stacks, mutated stacks, and the JSON text of both.
 */
export const arbCandidate: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 3, arbitrary: fc.jsonValue() },
  { weight: 2, arbitrary: fc.json() },
  { weight: 1, arbitrary: fc.string() },
  { weight: 1, arbitrary: arbStack },
  { weight: 1, arbitrary: arbStack.map((stack) => JSON.stringify(stack)) },
  { weight: 3, arbitrary: arbMutation.map((mutation) => mutation.mutated) },
  { weight: 1, arbitrary: arbMutation.map((mutation) => JSON.stringify(mutation.mutated)) },
);
