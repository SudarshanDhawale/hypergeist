import * as fc from 'fast-check';
import { LIMITS } from '../src/format/index.ts';
import type {
  Action,
  ButtonObject,
  FieldObject,
  Handler,
  ListObject,
  Stack,
  StackObject,
} from '../src/format/index.ts';

/*
 * fast-check generators for the thin-slice format.
 *
 * - `arbStack`: valid stacks (they pass `validateStack`), covering every Object type, every
 *   Action type, Links, and the limits at their minimum and maximum.
 * - `arbHandlerFor(stack)`: valid Handlers over the ids of one given stack.
 * - `arbMutation`: a valid stack with exactly one mutation that makes it invalid.
 * - `arbCandidate`: anything a caller might hand to `validateStack`.
 *
 * Everything here is pure: the same seed gives the same values.
 */

/* ---------- text and ids ---------- */

/** One Unicode code point per value: ASCII, Latin and BMP letters, astral characters, JSON escapes. */
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
  { weight: 1, arbitrary: fc.constantFrom('\n', '\t', '"', '\\', '/', '~', '😀') },
);

/** Single-code-point strings used to build the exact-minimum and exact-maximum texts. */
const EDGE_UNITS = ['a', 'é', '😀'] as const;

function atMin(min: number): fc.Arbitrary<string> {
  return fc.constantFrom(...EDGE_UNITS).map((unit) => unit.repeat(min));
}

/** Exactly `max` code points. Long maxima use ASCII only, so the document stays small. */
function atMax(max: number): fc.Arbitrary<string> {
  const units = max > 1000 ? (['a'] as const) : EDGE_UNITS;
  return fc.constantFrom(...units).map((unit) => unit.repeat(max));
}

/**
 * Text of `min` to `max` code points. Usually short. With `edges`, exactly `min` and exactly
 * `max` code points also appear, so the limits themselves are exercised.
 */
function arbText(min: number, max: number, edges: boolean): fc.Arbitrary<string> {
  const short = fc.string({
    unit: arbCodePoint,
    minLength: min,
    maxLength: Math.min(max, min + 24),
  });
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

/** An Entity_ID: 1 character, 2 to 12 characters, or the 64-character maximum. */
export const arbEntityId: fc.Arbitrary<string> = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom(...ID_HEAD) },
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

const KINDS = ['button', 'field', 'list'] as const;
type Kind = (typeof KINDS)[number];

/** A Card with at most this many Objects may use the expensive variants (500-item Lists, 10,000-character Fields). */
const LIGHT_CARD_MAX_OBJECTS = 6;

function arbFieldValue(light: boolean): fc.Arbitrary<string> {
  const parts: { weight: number; arbitrary: fc.Arbitrary<string> }[] = [
    { weight: 10, arbitrary: arbText(LIMITS.fieldValue.min, LIMITS.fieldValue.max, false) },
    { weight: 1, arbitrary: fc.constant('') },
    // Longer than a list item may be (500), so copying it into a List is a skipped Action.
    {
      weight: 2,
      arbitrary: fc.string({ unit: arbCodePoint, minLength: 501, maxLength: 640 }),
    },
  ];
  if (light) {
    parts.push({ weight: 1, arbitrary: atMax(LIMITS.fieldValue.max) });
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
    const short = fc.string({ unit: arbCodePoint, maxLength: 3 });
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
  }
}

/* ---------- handlers ---------- */

/**
 * Valid Handlers of 0 to 20 Actions over the ids in `stack`, in every Action type the stack
 * has targets for. Actions the executor skips appear too (a Field longer than 500 characters
 * copied into a List, a List joined into a Field past 10,000 characters, a full List).
 */
export function arbHandlerFor(stack: Stack): fc.Arbitrary<Handler> {
  const cardIds: string[] = [];
  const fieldIds: string[] = [];
  const listIds: string[] = [];
  for (const card of stack.cards) {
    cardIds.push(card.id);
    for (const object of card.objects) {
      if (object.type === 'field') {
        fieldIds.push(object.id);
      } else if (object.type === 'list') {
        listIds.push(object.id);
      }
    }
  }

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
  if (fieldIds.length > 0) {
    const sources = [...fieldIds, ...listIds];
    parts.push(
      {
        weight: 3,
        arbitrary: fc
          .tuple(
            fc.constantFrom(...fieldIds),
            arbText(LIMITS.setValueText.min, LIMITS.setValueText.max, true),
          )
          .map(([targetObjectId, value]): Action => ({ type: 'set_value', targetObjectId, value })),
      },
      {
        weight: 2,
        arbitrary: fc
          .tuple(fc.constantFrom(...fieldIds), fc.constantFrom(...sources))
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
    if (fieldIds.length > 0) {
      parts.push({
        weight: 3,
        arbitrary: fc
          .tuple(fc.constantFrom(...listIds), fc.constantFrom(...fieldIds))
          .map(([targetObjectId, fromObjectId]): Action => ({
            type: 'append_item',
            targetObjectId,
            fromObjectId,
          })),
      });
    }
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

const arbShape: fc.Arbitrary<CardShape[]> = fc.array(
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
  // Stack id, remixedFrom id, Card ids, Object ids, Link ids. All unique, across kinds.
  const idCount = 2 + cardCount + objectCount + linkTotal;

  return fc
    .record({
      ids: arbUniqueIds(idCount),
      cardWidth: arbCardDimension,
      cardHeight: arbCardDimension,
      name: arbText(LIMITS.stackName.min, LIMITS.stackName.max, true),
      remixed: fc.boolean(),
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
      const remixedFrom = take();
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
            fc.tuple(...objects),
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

      return fc.tuple(...cards).map((builtCards): Stack => ({
        formatVersion: 1,
        id: stackId,
        name: base.name,
        cardWidth: base.cardWidth,
        cardHeight: base.cardHeight,
        startCardId: must(cardIds[base.startIndex], 'the start card id'),
        ...(base.remixed ? { remixedFrom } : {}),
        cards: builtCards,
      }));
    });
}

/** Fills every Card `onOpen` and every Button `onClick` of `skeleton` with generated Handlers. */
function arbWithHandlers(skeleton: Stack): fc.Arbitrary<Stack> {
  const handler = arbHandlerFor(skeleton);
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
 * Valid stacks: 1 to 5 Cards; all ids unique across kinds; in-bounds Objects of each type,
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

type LimitSite =
  | { readonly kind: 'string'; readonly path: Path; readonly max: number }
  | { readonly kind: 'array'; readonly path: Path; readonly max: number };

/** Every place a string or array has a maximum. */
function limitSites(stack: Stack): LimitSite[] {
  const sites: LimitSite[] = [{ kind: 'string', path: ['name'], max: LIMITS.stackName.max }];
  const handlerSites = (handler: Handler, base: Path): void => {
    sites.push({ kind: 'array', path: base, max: LIMITS.handlerActions.max });
    handler.forEach((action, i) => {
      const at = [...base, i];
      if (action.type === 'show_message') {
        sites.push({ kind: 'string', path: [...at, 'text'], max: LIMITS.messageText.max });
      } else if (action.type === 'set_value' && action.value !== undefined) {
        sites.push({ kind: 'string', path: [...at, 'value'], max: LIMITS.setValueText.max });
      } else if (action.type === 'append_item' && action.item !== undefined) {
        sites.push({ kind: 'string', path: [...at, 'item'], max: LIMITS.appendItemText.max });
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
      if (object.type === 'button') {
        sites.push({ kind: 'string', path: [...at, 'label'], max: LIMITS.buttonLabel.max });
        handlerSites(object.onClick, [...at, 'onClick']);
      } else if (object.type === 'field') {
        sites.push({ kind: 'string', path: [...at, 'value'], max: LIMITS.fieldValue.max });
        sites.push({
          kind: 'string',
          path: [...at, 'placeholder'],
          max: LIMITS.fieldPlaceholder.max,
        });
      } else {
        sites.push({ kind: 'array', path: [...at, 'items'], max: LIMITS.listItems.max });
        if (object.items.length > 0) {
          sites.push({ kind: 'string', path: [...at, 'items', 0], max: LIMITS.listItemText.max });
        }
      }
    });
  });
  return sites;
}

type Category = 'card' | 'button' | 'field' | 'list' | 'link';
type ReferenceSite = { readonly path: Path; readonly allowed: readonly Category[] };

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
          sites.push({ path: [...at, 'targetObjectId'], allowed: ['field'] });
          if (action.fromObjectId !== undefined) {
            sites.push({ path: [...at, 'fromObjectId'], allowed: ['field', 'list'] });
          }
          break;
        case 'append_item':
          sites.push({ path: [...at, 'targetObjectId'], allowed: ['list'] });
          if (action.fromObjectId !== undefined) {
            sites.push({ path: [...at, 'fromObjectId'], allowed: ['field'] });
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
    card.objects.forEach((object, oi) => {
      if (object.type === 'button') {
        handlerSites(object.onClick, [...cardPath, 'objects', oi, 'onClick']);
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

function mutateExceed(stack: Stack): fc.Arbitrary<Mutation> {
  return fc
    .tuple(fc.constantFrom(...limitSites(stack)), fc.constantFrom('a', '😀'))
    .map(([site, unit]): Mutation => {
      const mutated = cloneJson(stack);
      if (site.kind === 'string') {
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
            } else {
              array.push({ type: 'show_message', text: 'x' });
            }
          }
        }
      }
      return { kind: 'exceed-limit', path: site.path, original: stack, mutated };
    });
}

function mutateUnknown(stack: Stack): fc.Arbitrary<Mutation> {
  const { recordPaths } = indexPaths(stack);
  return fc
    .tuple(
      fc.constantFrom(...recordPaths),
      fc.constantFrom('extra', 'unknownProp', '_zz', 'a/b', 'a~b'),
    )
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
    });
}

function mutateRetarget(stack: Stack): fc.Arbitrary<Mutation> {
  const categories = categoriesById(stack);
  let dangling = 'no-such-entity';
  while (categories.has(dangling)) {
    dangling += '-x';
  }
  return fc.constantFrom(...referenceSites(stack)).chain((site) => {
    const wrongKind = [...categories]
      .filter(([, category]) => !site.allowed.includes(category))
      .map(([id]) => id);
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
