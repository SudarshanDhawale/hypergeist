import * as fc from 'fast-check';
import { LIMITS, OBJECT_TYPES } from '../src/format/index.ts';
import type {
  Action,
  Card,
  Handler,
  Stack,
  StackObject,
  ValidationErrorCode,
} from '../src/format/index.ts';
import { OPERATION_NAMES } from '../src/engine/operations/index.ts';
import type { OperationName } from '../src/engine/operations/index.ts';

/*
 * fast-check generators for sequences of Operation calls.
 *
 * A call cannot be generated up front, because the ids it names depend on the Stack as it is
 * after the earlier calls of the sequence. So a generated value is a template: the Operation
 * name, a fault tag, and a fixed-length list of fractions in [0, 1) plus a few texts. The
 * function `resolveOperation(stack, template)` turns a template into real parameters against
 * the Stack it is given. The same template and Stack always give the same call.
 *
 * - `fault: 'none'` builds parameters from the real ids of the Stack. Most such calls are
 *   accepted. Some are rejected on their own merits (the last Card cannot be deleted, a Card
 *   is full, a Link already exists, an Object would leave its Card).
 * - Any other fault breaks the valid call in one way. If the fault applies to this Operation
 *   and this Stack, `expectedCode` is set: the code that must be among the errors of the
 *   rejection. If it does not apply (for example `over-limit` for `remove_object`), the call
 *   is built as for `none`.
 * - `unknownName` replaces the Operation name with a string that names no Operation.
 *
 * The generators know the format limits and the Operation contract (requirements 1 to 4 and
 * 9), not the implementation of the Operations.
 */

/** The fault tags of the design. */
export const OPERATION_FAULTS = [
  'none',
  'unknown-entity',
  'duplicate-id',
  'bad-id-pattern',
  'index-out-of-range',
  'missing-required',
  'wrong-type',
  'unknown-property',
  'over-limit',
  'wrong-reference-kind',
  'bad-handler',
] as const;

export type OperationFault = (typeof OPERATION_FAULTS)[number];

/** The longest sequence `arbOperationSequence` produces. */
export const MAX_SEQUENCE_LENGTH = 50;

/** How many fractions and texts a template holds. Builders read them in a fixed order, cyclically. */
const PICK_COUNT = 48;
const TEXT_COUNT = 4;

/** Strings that are not the name of any Operation. */
export const UNKNOWN_OPERATION_NAMES = [
  'nope',
  '',
  'constructor',
  '__proto__',
  'toString',
  'Create_Card',
  'create_cards',
  'delete card',
] as const;

export type OperationTemplate = {
  /** The Operation the call is built for. */
  readonly name: OperationName;
  readonly fault: OperationFault;
  /** When defined, the resolved call carries this name instead, which is not an Operation. */
  readonly unknownName: string | undefined;
  /** Choices, each in [0, 1). */
  readonly picks: readonly number[];
  /** Texts of 1 to 30 code points for names, labels, values and messages. */
  readonly texts: readonly string[];
};

export type ResolvedOperation = {
  /** The Operation name to pass to `applyOperation`. */
  readonly name: string;
  readonly params: unknown;
  /** A code that must be among the errors of the rejection. Absent when the call may be accepted. */
  readonly expectedCode?: ValidationErrorCode;
};

/* ---------- small deterministic helpers ---------- */

type Rand = () => number;
type Text = () => string;

/** A reader that returns the fractions of `picks` in order and wraps around at the end. */
function readerOf(picks: readonly number[]): Rand {
  let cursor = 0;
  return () => {
    const value = picks.length === 0 ? 0 : (picks[cursor % picks.length] ?? 0);
    cursor += 1;
    return value;
  };
}

/** An integer from 0 through `count - 1` (0 when `count` is 0). */
function indexOf(fraction: number, count: number): number {
  return count <= 0 ? 0 : Math.min(count - 1, Math.floor(fraction * count));
}

/** An integer from `low` through `high`, both inclusive. */
function between(fraction: number, low: number, high: number): number {
  return low + indexOf(fraction, high - low + 1);
}

function chance(fraction: number, probability: number): boolean {
  return fraction < probability;
}

function pick<T>(list: readonly T[], fraction: number): T | undefined {
  return list[indexOf(fraction, list.length)];
}

/** Up to `max` distinct entries of `list`, in a fraction-driven order. */
function pickDistinct<T>(list: readonly T[], r: Rand, max: number): T[] {
  const pool = [...list];
  const count = between(r(), 0, Math.min(max, pool.length));
  const out: T[] = [];
  for (let step = 0; step < count; step += 1) {
    const [taken] = pool.splice(indexOf(r(), pool.length), 1);
    if (taken !== undefined) out.push(taken);
  }
  return out;
}

/* ---------- what the Stack holds ---------- */

type Located = { readonly card: Card; readonly object: StackObject };

type Context = {
  readonly stack: Stack;
  readonly cardIds: readonly string[];
  readonly objects: readonly Located[];
  /** Every Card, Object and Link id. */
  readonly usedIds: readonly string[];
  readonly linkIds: readonly string[];
  /** Ids of Objects and Links: entities that are not Cards. */
  readonly nonCardIds: readonly string[];
};

function contextOf(stack: Stack): Context {
  const cardIds = stack.cards.map((card) => card.id);
  const objects = stack.cards.flatMap((card) => card.objects.map((object) => ({ card, object })));
  const linkIds = stack.cards.flatMap((card) => card.links.map((link) => link.id));
  const objectIds = objects.map((entry) => entry.object.id);
  return {
    stack,
    cardIds,
    objects,
    linkIds,
    usedIds: [...cardIds, ...objectIds, ...linkIds],
    nonCardIds: [...objectIds, ...linkIds],
  };
}

/** A well-formed id that no Card, Object or Link uses. */
function freshId(ctx: Context, kind: 'card' | 'obj' | 'link', fraction: number): string {
  const used = new Set(ctx.usedIds);
  let n = 100 + Math.floor(fraction * 900);
  while (used.has(`${kind}-${n}`)) n += 1;
  return `${kind}-${n}`;
}

/* ---------- parameter values ---------- */

/** Strings that fail the Entity_ID pattern. */
const BAD_IDS = ['Bad Id', 'UPPER', '-leading', '_leading', 'a b', 'x.y', 'é', 'A1', 'a/b', ''];

/** Names of parameters that no Operation has. */
const EXTRA_KEYS = ['extra', 'bogus', 'constructor', 'extraParam', 'Name'];

function wrongTypeValue(original: unknown, fraction: number): unknown {
  if (typeof original !== 'string') return 'abc';
  switch (indexOf(fraction, 5)) {
    case 0:
      return 42;
    case 1:
      return true;
    case 2:
      return null;
    case 3:
      return [];
    default:
      return {};
  }
}

function extraValue(fraction: number): unknown {
  switch (indexOf(fraction, 5)) {
    case 0:
      return 1;
    case 1:
      return 'x';
    case 2:
      return true;
    case 3:
      return null;
    default:
      return [];
  }
}

/** A text of 101 code points: one more than any name or label allows. */
function overlongText(fraction: number): string {
  return (fraction < 0.5 ? 'a' : '😀').repeat(101);
}

/** An `index` that is rejected as `OUT_OF_RANGE`: above `count`, negative, or not an integer. */
function badIndex(count: number, fraction: number): number {
  const choices = [count + 1, count + 7, -1, 1.5, -100];
  return choices[indexOf(fraction, choices.length)] ?? -1;
}

/** An https image source. */
function imageSource(fraction: number): string {
  return `https://example.com/image-${Math.floor(fraction * 1000)}.png`;
}

/* ---------- Object properties by type ---------- */

type ObjectType = StackObject['type'];

/** The properties only this type defines. `value` belongs to both field and ai-field. */
const OWN_PROPERTIES: Readonly<Record<ObjectType, readonly string[]>> = {
  button: ['label', 'onClick'],
  field: ['value', 'placeholder', 'multiline', 'readOnly'],
  image: ['src', 'alt'],
  list: ['items', 'ordered'],
  'ai-field': ['prompt', 'inputObjectIds', 'value'],
};

const TYPE_PROPERTIES = [
  'label',
  'onClick',
  'value',
  'placeholder',
  'multiline',
  'readOnly',
  'items',
  'ordered',
  'src',
  'alt',
  'prompt',
  'inputObjectIds',
] as const;

/** A valid value for one type-specific property. */
function sampleValue(property: string): unknown {
  switch (property) {
    case 'label':
    case 'value':
    case 'placeholder':
    case 'alt':
    case 'prompt':
      return 'x';
    case 'multiline':
    case 'readOnly':
    case 'ordered':
      return false;
    case 'src':
      return 'https://example.com/a.png';
    default:
      return [];
  }
}

/** A type-specific property that the given type does not define, with a valid value. */
function foreignProperty(type: ObjectType, fraction: number): [string, unknown] | undefined {
  const own = OWN_PROPERTIES[type];
  const key = pick(
    TYPE_PROPERTIES.filter((property) => !own.includes(property)),
    fraction,
  );
  return key === undefined ? undefined : [key, sampleValue(key)];
}

/** Objects whose text an ai-field may take as an input. */
function inputCandidates(card: Card, exceptId: string | undefined): string[] {
  return card.objects
    .filter(
      (object) =>
        object.id !== exceptId &&
        (object.type === 'field' || object.type === 'list' || object.type === 'ai-field'),
    )
    .map((object) => object.id);
}

/* ---------- Handlers ---------- */

/** A valid Handler of 0 to `maxActions` Actions over the real ids of the Stack. */
function buildHandler(ctx: Context, r: Rand, text: Text, maxActions: number): Action[] {
  const fieldIds = ctx.objects.filter((o) => o.object.type === 'field').map((o) => o.object.id);
  const listIds = ctx.objects.filter((o) => o.object.type === 'list').map((o) => o.object.id);
  const count = between(r(), 0, maxActions);
  const actions: Action[] = [];
  for (let step = 0; step < count; step += 1) {
    const kind = indexOf(r(), 5);
    const target = r();
    const message: Action = { type: 'show_message', text: text() };
    const cardId = pick(ctx.cardIds, target);
    const fieldId = pick(fieldIds, target);
    const listId = pick(listIds, target);
    if (kind === 0 && cardId !== undefined) {
      actions.push({ type: 'go_to_card', cardId });
    } else if (kind === 2 && fieldId !== undefined) {
      actions.push({ type: 'set_value', targetObjectId: fieldId, value: text() });
    } else if (kind === 3 && listId !== undefined) {
      actions.push({ type: 'append_item', targetObjectId: listId, item: text() });
    } else if (kind === 4 && listId !== undefined) {
      actions.push({ type: 'remove_item', targetObjectId: listId, index: between(r(), 0, 5) });
    } else {
      actions.push(message);
    }
  }
  return actions;
}

type HandlerFault = { readonly handler: Handler; readonly code: ValidationErrorCode };

/** A Handler with one Action the validator rejects, after a few valid ones. */
function buildBadHandler(ctx: Context, r: Rand, text: Text): HandlerFault {
  const leading = buildHandler(ctx, r, text, 2);
  const variant = indexOf(r(), 3);
  const button = pick(
    ctx.objects.filter((entry) => entry.object.type === 'button'),
    r(),
  );
  if (variant === 2 && button !== undefined) {
    // A button cannot receive a value.
    const bad: Action = { type: 'set_value', targetObjectId: button.object.id, value: 'x' };
    return { handler: [...leading, bad], code: 'WRONG_REFERENCE_TYPE' };
  }
  const bad: Action =
    variant === 0
      ? { type: 'go_to_card', cardId: freshId(ctx, 'card', r()) }
      : { type: 'set_value', targetObjectId: freshId(ctx, 'obj', r()), value: 'x' };
  return { handler: [...leading, bad], code: 'DANGLING_REFERENCE' };
}

/** 21 Actions: one more than a Handler may hold. */
function overlongHandler(): Action[] {
  return Array.from({ length: LIMITS.handlerActions.max + 1 }, (): Action => ({
    type: 'show_message',
    text: 'x',
  }));
}

/* ---------- the shape of one built call ---------- */

type Fix = {
  readonly params: Record<string, unknown>;
  readonly expectedCode: ValidationErrorCode;
};

type Base = {
  /** Valid parameters (or, with `forced`, parameters the Operation rejects on its own). */
  readonly params: Record<string, unknown>;
  /** The code the call gets even with no fault, when it is known to be rejected. */
  readonly forced?: ValidationErrorCode;
  /** Parameters that must be present. */
  readonly required: readonly string[];
  /** Parameters that hold an Entity_ID, present or optional. */
  readonly idKeys: readonly string[];
  /** Parameters that can be given the wrong JSON type. Absent ones are skipped. */
  readonly typed: readonly string[];
  /** Faults that only this Operation can apply. Each returns `undefined` when it cannot. */
  readonly specific: Partial<Record<OperationFault, () => Fix | undefined>>;
};

function without(params: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([name]) => name !== key));
}

/** The faults that work the same way for every Operation. */
function genericFix(fault: OperationFault, base: Base, r: Rand): Fix | undefined {
  const { params } = base;
  switch (fault) {
    case 'missing-required': {
      const key = pick(base.required, r());
      if (key === undefined) return undefined;
      return { params: without(params, key), expectedCode: 'MISSING_PROPERTY' };
    }
    case 'bad-id-pattern': {
      const key = pick(base.idKeys, r());
      const value = pick(BAD_IDS, r());
      if (key === undefined || value === undefined) return undefined;
      return { params: { ...params, [key]: value }, expectedCode: 'INVALID_VALUE' };
    }
    case 'wrong-type': {
      const key = pick(
        base.typed.filter((name) => Object.hasOwn(params, name)),
        r(),
      );
      if (key === undefined) return undefined;
      return {
        params: { ...params, [key]: wrongTypeValue(params[key], r()) },
        expectedCode: 'WRONG_TYPE',
      };
    }
    case 'unknown-property': {
      const key = pick(EXTRA_KEYS, r());
      if (key === undefined) return undefined;
      return { params: { ...params, [key]: extraValue(r()) }, expectedCode: 'UNKNOWN_PROPERTY' };
    }
    default:
      return undefined;
  }
}

/** Applies the fault to the base call, or returns the base call when the fault does not apply. */
function finish(
  fault: OperationFault,
  base: Base,
  r: Rand,
): { params: Record<string, unknown>; expectedCode?: ValidationErrorCode } {
  if (fault !== 'none') {
    const fix = base.specific[fault]?.() ?? genericFix(fault, base, r);
    if (fix !== undefined) return fix;
  }
  return base.forced === undefined
    ? { params: base.params }
    : { params: base.params, expectedCode: base.forced };
}

/* ---------- one builder per Operation ---------- */

type Builder = (ctx: Context, r: Rand, text: Text) => Base;

/** The call every Operation falls back to when the Stack has no Card at all (never for a valid Stack). */
function unusable(params: Record<string, unknown>): Base {
  return { params, required: [], idKeys: [], typed: [], specific: {}, forced: 'UNKNOWN_ENTITY' };
}

const buildCreateCard: Builder = (ctx, r, text) => {
  const count = ctx.cardIds.length;
  const params: Record<string, unknown> = { name: text() };
  if (chance(r(), 0.4)) params['id'] = freshId(ctx, 'card', r());
  if (chance(r(), 0.5)) params['index'] = between(r(), 0, count);
  const room = count < LIMITS.cards.max;
  const roomFaults: Base['specific'] = room
    ? {
        'duplicate-id': () => {
          const id = pick(ctx.usedIds, r());
          return id === undefined
            ? undefined
            : { params: { ...params, id }, expectedCode: 'DUPLICATE_ID' };
        },
        'index-out-of-range': () => ({
          params: { ...params, index: badIndex(count, r()) },
          expectedCode: 'OUT_OF_RANGE',
        }),
      }
    : {};
  return {
    params,
    ...(room ? {} : { forced: 'LIMIT_EXCEEDED' as const }),
    required: ['name'],
    idKeys: ['id'],
    typed: ['name', 'id', 'index'],
    specific: {
      ...roomFaults,
      'over-limit': () => ({
        params: { ...params, name: overlongText(r()) },
        expectedCode: 'LIMIT_EXCEEDED',
      }),
    },
  };
};

const buildDeleteCard: Builder = (ctx, r) => {
  const cardId = pick(ctx.cardIds, r());
  if (cardId === undefined) return unusable({ cardId: freshId(ctx, 'card', r()) });
  const params: Record<string, unknown> = { cardId };
  const single = ctx.cardIds.length < 2;
  return {
    params,
    ...(single ? { forced: 'LIMIT_EXCEEDED' as const } : {}),
    required: ['cardId'],
    idKeys: ['cardId'],
    typed: ['cardId'],
    specific: {
      'unknown-entity': () => ({
        params: { cardId: freshId(ctx, 'card', r()) },
        expectedCode: 'UNKNOWN_ENTITY',
      }),
      'wrong-reference-kind': () => {
        const id = pick(ctx.nonCardIds, r());
        return id === undefined
          ? undefined
          : { params: { cardId: id }, expectedCode: 'UNKNOWN_ENTITY' };
      },
      'over-limit': () =>
        single ? { params: { cardId }, expectedCode: 'LIMIT_EXCEEDED' } : undefined,
    },
  };
};

const buildRemoveObject: Builder = (ctx, r) => {
  const entry = pick(ctx.objects, r());
  const missing = freshId(ctx, 'obj', r());
  return {
    params: { objectId: entry === undefined ? missing : entry.object.id },
    ...(entry === undefined ? { forced: 'UNKNOWN_ENTITY' as const } : {}),
    required: ['objectId'],
    idKeys: ['objectId'],
    typed: ['objectId'],
    specific: {
      'unknown-entity': () => ({ params: { objectId: missing }, expectedCode: 'UNKNOWN_ENTITY' }),
      'wrong-reference-kind': () => {
        const id = pick([...ctx.cardIds, ...ctx.linkIds], r());
        return id === undefined
          ? undefined
          : { params: { objectId: id }, expectedCode: 'UNKNOWN_ENTITY' };
      },
    },
  };
};

/** Valid type-specific properties for a new Object of `type` on `card`, added to `params`. */
function addTypeProperties(
  params: Record<string, unknown>,
  type: ObjectType,
  card: Card,
  ctx: Context,
  r: Rand,
  text: Text,
): void {
  switch (type) {
    case 'button':
      params['label'] = text();
      if (chance(r(), 0.4)) params['onClick'] = buildHandler(ctx, r, text, 3);
      break;
    case 'field':
      if (chance(r(), 0.4)) params['value'] = text();
      if (chance(r(), 0.3)) params['placeholder'] = text();
      if (chance(r(), 0.3)) params['multiline'] = chance(r(), 0.5);
      if (chance(r(), 0.3)) params['readOnly'] = chance(r(), 0.5);
      break;
    case 'image':
      params['src'] = imageSource(r());
      if (chance(r(), 0.4)) params['alt'] = text();
      break;
    case 'list':
      if (chance(r(), 0.5)) {
        params['items'] = Array.from({ length: between(r(), 0, 3) }, () => text());
      }
      if (chance(r(), 0.3)) params['ordered'] = chance(r(), 0.5);
      break;
    case 'ai-field':
      params['prompt'] = text();
      if (chance(r(), 0.4)) params['value'] = text();
      if (chance(r(), 0.5)) {
        params['inputObjectIds'] = pickDistinct(inputCandidates(card, undefined), r, 2);
      }
      break;
  }
}

const REQUIRED_BY_TYPE: Readonly<Record<ObjectType, readonly string[]>> = {
  button: ['label'],
  field: [],
  image: ['src'],
  list: [],
  'ai-field': ['prompt'],
};

const buildAddObject: Builder = (ctx, r, text) => {
  const { stack } = ctx;
  const card = pick(stack.cards, r());
  const type = OBJECT_TYPES[indexOf(r(), OBJECT_TYPES.length)] ?? 'field';
  const width = between(
    r(),
    LIMITS.objectSize.min,
    Math.min(stack.cardWidth, LIMITS.objectSize.max),
  );
  const height = between(
    r(),
    LIMITS.objectSize.min,
    Math.min(stack.cardHeight, LIMITS.objectSize.max),
  );
  const x = between(r(), 0, stack.cardWidth - width);
  const y = between(r(), 0, stack.cardHeight - height);
  if (card === undefined) {
    return unusable({ cardId: freshId(ctx, 'card', r()), type, x, y, width, height });
  }
  const params: Record<string, unknown> = { cardId: card.id, type, x, y, width, height };
  if (chance(r(), 0.4)) params['id'] = freshId(ctx, 'obj', r());
  if (chance(r(), 0.4)) params['index'] = between(r(), 0, card.objects.length);
  if (chance(r(), 0.4)) params['name'] = text();
  addTypeProperties(params, type, card, ctx, r, text);
  const full = card.objects.length >= LIMITS.objectsPerCard.max;

  return {
    params,
    ...(full ? { forced: 'LIMIT_EXCEEDED' as const } : {}),
    required: ['cardId', 'type', 'x', 'y', 'width', 'height', ...REQUIRED_BY_TYPE[type]],
    idKeys: ['cardId', 'id'],
    typed: Object.keys(params).filter((key) => key !== 'type'),
    specific: {
      'unknown-entity': () => ({
        params: { ...params, cardId: freshId(ctx, 'card', r()) },
        expectedCode: 'UNKNOWN_ENTITY',
      }),
      'wrong-reference-kind': () => {
        const id = pick(ctx.nonCardIds, r());
        return id === undefined
          ? undefined
          : { params: { ...params, cardId: id }, expectedCode: 'UNKNOWN_ENTITY' };
      },
      'duplicate-id': () => {
        const id = pick(ctx.usedIds, r());
        return id === undefined
          ? undefined
          : { params: { ...params, id }, expectedCode: 'DUPLICATE_ID' };
      },
      'index-out-of-range': () => ({
        params: { ...params, index: badIndex(card.objects.length, r()) },
        expectedCode: 'OUT_OF_RANGE',
      }),
      'over-limit': () => ({
        params: { ...params, name: overlongText(r()) },
        expectedCode: 'LIMIT_EXCEEDED',
      }),
      // A property of another type: accepted by the flat schema, rejected for this type.
      'unknown-property': () => {
        if (!chance(r(), 0.6)) return undefined;
        const foreign = foreignProperty(type, r());
        return foreign === undefined
          ? undefined
          : { params: { ...params, [foreign[0]]: foreign[1] }, expectedCode: 'UNKNOWN_PROPERTY' };
      },
      // A Button whose onClick names an Object that does not exist: stage C of the Operation.
      'bad-handler': () => {
        if (full) return undefined;
        const bad = buildBadHandler(ctx, r, text);
        const candidate = {
          ...params,
          type: 'button',
          label: text(),
          onClick: bad.handler,
        };
        // Properties of other types would hide the handler error behind UNKNOWN_PROPERTY.
        const button = Object.fromEntries(
          Object.entries(candidate).filter(
            ([key]) =>
              !(TYPE_PROPERTIES as readonly string[]).includes(key) ||
              OWN_PROPERTIES.button.includes(key),
          ),
        );
        return { params: button, expectedCode: bad.code };
      },
    },
  };
};

const buildUpdateObject: Builder = (ctx, r, text) => {
  const { stack } = ctx;
  const entry = pick(ctx.objects, r());
  if (entry === undefined) {
    return {
      params: { objectId: freshId(ctx, 'obj', r()), changes: {} },
      forced: 'UNKNOWN_ENTITY',
      required: ['objectId', 'changes'],
      idKeys: ['objectId'],
      typed: ['objectId', 'changes'],
      specific: {
        'unknown-entity': () => ({
          params: { objectId: freshId(ctx, 'obj', r()), changes: {} },
          expectedCode: 'UNKNOWN_ENTITY',
        }),
        'wrong-reference-kind': () => {
          const id = pick(ctx.cardIds, r());
          return id === undefined
            ? undefined
            : { params: { objectId: id, changes: {} }, expectedCode: 'UNKNOWN_ENTITY' };
        },
      },
    };
  }
  const { object, card } = entry;
  const changes: Record<string, unknown> = {};
  if (chance(r(), 0.3)) changes['name'] = text();
  // Position and size are changed one after the other, so the Object always fits the Card.
  const newX = chance(r(), 0.3) ? between(r(), 0, stack.cardWidth - object.width) : object.x;
  const newY = chance(r(), 0.3) ? between(r(), 0, stack.cardHeight - object.height) : object.y;
  if (newX !== object.x) changes['x'] = newX;
  if (newY !== object.y) changes['y'] = newY;
  if (chance(r(), 0.3)) {
    changes['width'] = between(r(), LIMITS.objectSize.min, stack.cardWidth - newX);
  }
  if (chance(r(), 0.3)) {
    changes['height'] = between(r(), LIMITS.objectSize.min, stack.cardHeight - newY);
  }
  switch (object.type) {
    case 'button':
      if (chance(r(), 0.5)) changes['label'] = text();
      if (chance(r(), 0.3)) changes['onClick'] = buildHandler(ctx, r, text, 3);
      break;
    case 'field':
      if (chance(r(), 0.4)) changes['value'] = text();
      if (chance(r(), 0.3)) changes['placeholder'] = text();
      if (chance(r(), 0.3)) changes['multiline'] = chance(r(), 0.5);
      if (chance(r(), 0.3)) changes['readOnly'] = chance(r(), 0.5);
      break;
    case 'image':
      if (chance(r(), 0.4)) changes['src'] = imageSource(r());
      if (chance(r(), 0.4)) changes['alt'] = text();
      break;
    case 'list':
      if (chance(r(), 0.5)) {
        changes['items'] = Array.from({ length: between(r(), 0, 3) }, () => text());
      }
      if (chance(r(), 0.3)) changes['ordered'] = chance(r(), 0.5);
      break;
    case 'ai-field':
      if (chance(r(), 0.4)) changes['prompt'] = text();
      if (chance(r(), 0.3)) changes['value'] = text();
      if (chance(r(), 0.4)) {
        changes['inputObjectIds'] = pickDistinct(inputCandidates(card, object.id), r, 2);
      }
      break;
  }
  const params: Record<string, unknown> = { objectId: object.id, changes };

  return {
    params,
    required: ['objectId', 'changes'],
    idKeys: ['objectId'],
    typed: ['objectId', 'changes'],
    specific: {
      'unknown-entity': () => ({
        params: { ...params, objectId: freshId(ctx, 'obj', r()) },
        expectedCode: 'UNKNOWN_ENTITY',
      }),
      'wrong-reference-kind': () => {
        const id = pick([...ctx.cardIds, ...ctx.linkIds], r());
        return id === undefined
          ? undefined
          : { params: { ...params, objectId: id }, expectedCode: 'UNKNOWN_ENTITY' };
      },
      'over-limit': () => ({
        params: { ...params, changes: { ...changes, name: overlongText(r()) } },
        expectedCode: 'LIMIT_EXCEEDED',
      }),
      // A property of another type inside `changes`: rejected for this Object, not by the schema.
      'unknown-property': () => {
        if (!chance(r(), 0.6)) return undefined;
        const foreign = foreignProperty(object.type, r());
        return foreign === undefined
          ? undefined
          : {
              params: { ...params, changes: { ...changes, [foreign[0]]: foreign[1] } },
              expectedCode: 'UNKNOWN_PROPERTY',
            };
      },
      // A Button whose new onClick names a missing Object: stage C of the Operation.
      'bad-handler': () => {
        const button = pick(
          ctx.objects.filter((candidate) => candidate.object.type === 'button'),
          r(),
        );
        if (button === undefined) return undefined;
        const bad = buildBadHandler(ctx, r, text);
        return {
          params: { objectId: button.object.id, changes: { onClick: bad.handler } },
          expectedCode: bad.code,
        };
      },
    },
  };
};

const buildLinkCards: Builder = (ctx, r, text) => {
  const from = pick(ctx.cardIds, r());
  const to = pick(ctx.cardIds, r());
  if (from === undefined || to === undefined) {
    return unusable({
      fromCardId: freshId(ctx, 'card', r()),
      toCardId: freshId(ctx, 'card', r()),
      label: text(),
    });
  }
  const params: Record<string, unknown> = { fromCardId: from, toCardId: to, label: text() };
  if (chance(r(), 0.4)) params['id'] = freshId(ctx, 'link', r());
  return {
    params,
    required: ['fromCardId', 'toCardId', 'label'],
    idKeys: ['fromCardId', 'toCardId', 'id'],
    typed: ['fromCardId', 'toCardId', 'label', 'id'],
    specific: {
      'unknown-entity': () => ({
        params: chance(r(), 0.5)
          ? { ...params, fromCardId: freshId(ctx, 'card', r()) }
          : { ...params, toCardId: freshId(ctx, 'card', r()) },
        expectedCode: 'UNKNOWN_ENTITY',
      }),
      'wrong-reference-kind': () => {
        const id = pick(ctx.nonCardIds, r());
        if (id === undefined) return undefined;
        return {
          params: chance(r(), 0.5) ? { ...params, fromCardId: id } : { ...params, toCardId: id },
          expectedCode: 'UNKNOWN_ENTITY',
        };
      },
      'duplicate-id': () => {
        const id = pick(ctx.usedIds, r());
        return id === undefined
          ? undefined
          : { params: { ...params, id }, expectedCode: 'DUPLICATE_ID' };
      },
      'over-limit': () => ({
        params: { ...params, label: overlongText(r()) },
        expectedCode: 'LIMIT_EXCEEDED',
      }),
    },
  };
};

const buildSetAction: Builder = (ctx, r, text) => {
  const buttons = ctx.objects.filter((entry) => entry.object.type === 'button');
  const owner = pick([...ctx.cardIds, ...buttons.map((entry) => entry.object.id)], r());
  if (owner === undefined) {
    return unusable({ ownerId: freshId(ctx, 'card', r()), handler: [] });
  }
  const params: Record<string, unknown> = {
    ownerId: owner,
    handler: buildHandler(ctx, r, text, 4),
  };
  return {
    params,
    required: ['ownerId', 'handler'],
    idKeys: ['ownerId'],
    typed: ['ownerId', 'handler'],
    specific: {
      'unknown-entity': () => ({
        params: { ...params, ownerId: freshId(ctx, 'obj', r()) },
        expectedCode: 'UNKNOWN_ENTITY',
      }),
      // An Object that is not a Button, or a Link: it exists but has no Handler.
      'wrong-reference-kind': () => {
        const ids = [
          ...ctx.objects.filter((entry) => entry.object.type !== 'button').map((e) => e.object.id),
          ...ctx.linkIds,
        ];
        const id = pick(ids, r());
        return id === undefined
          ? undefined
          : { params: { ...params, ownerId: id }, expectedCode: 'WRONG_REFERENCE_TYPE' };
      },
      'over-limit': () => ({
        params: { ...params, handler: overlongHandler() },
        expectedCode: 'LIMIT_EXCEEDED',
      }),
      'bad-handler': () => {
        const bad = buildBadHandler(ctx, r, text);
        return { params: { ...params, handler: bad.handler }, expectedCode: bad.code };
      },
    },
  };
};

const BUILDERS: Readonly<Record<OperationName, Builder>> = {
  create_card: buildCreateCard,
  delete_card: buildDeleteCard,
  add_object: buildAddObject,
  update_object: buildUpdateObject,
  remove_object: buildRemoveObject,
  link_cards: buildLinkCards,
  set_action: buildSetAction,
};

/* ---------- resolve ---------- */

/**
 * Builds the call a template stands for, against the Stack as it is now. Pure: the same
 * template and Stack give equal results, and the Stack is not modified.
 */
export function resolveOperation(stack: Stack, template: OperationTemplate): ResolvedOperation {
  const ctx = contextOf(stack);
  const r = readerOf(template.picks);
  const text: Text = () => pick(template.texts, r()) ?? 'x';
  const unknownName = template.unknownName;
  const fault = unknownName === undefined ? template.fault : 'none';
  const built = finish(fault, BUILDERS[template.name](ctx, r, text), r);
  if (unknownName !== undefined) {
    return { name: unknownName, params: built.params, expectedCode: 'INVALID_VALUE' };
  }
  return built.expectedCode === undefined
    ? { name: template.name, params: built.params }
    : { name: template.name, params: built.params, expectedCode: built.expectedCode };
}

/* ---------- arbitraries ---------- */

/** A fraction in [0, 1): a multiple of one millionth. */
const arbFraction: fc.Arbitrary<number> = fc
  .integer({ min: 0, max: 999_999 })
  .map((n) => n / 1_000_000);

const TEXT_UNITS = [...'abcxyzABC019 -_.:,é"/\\~😀'];

const arbText: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(...TEXT_UNITS),
  minLength: 1,
  maxLength: 30,
});

/** `none` is half of all faults, so accepted calls are common, and each other fault is equally likely. */
const arbFault: fc.Arbitrary<OperationFault> = fc.oneof(
  { weight: 10, arbitrary: fc.constant<OperationFault>('none') },
  ...OPERATION_FAULTS.filter((fault) => fault !== 'none').map((fault) => ({
    weight: 1,
    arbitrary: fc.constant<OperationFault>(fault),
  })),
);

/** One call in about 30 carries a name that is not an Operation. */
const arbUnknownName: fc.Arbitrary<string | undefined> = fc.oneof(
  { weight: 29, arbitrary: fc.constant<string | undefined>(undefined) },
  { weight: 1, arbitrary: fc.constantFrom<string | undefined>(...UNKNOWN_OPERATION_NAMES) },
);

/** One Operation call as a template. Turn it into a call with `resolveOperation`. */
export const arbOperationTemplate: fc.Arbitrary<OperationTemplate> = fc.record({
  name: fc.constantFrom(...OPERATION_NAMES),
  fault: arbFault,
  unknownName: arbUnknownName,
  picks: fc.array(arbFraction, { minLength: PICK_COUNT, maxLength: PICK_COUNT }),
  texts: fc.array(arbText, { minLength: TEXT_COUNT, maxLength: TEXT_COUNT }),
});

/** 0 to 50 templates. Resolve them one at a time, each against the Stack the previous step left. */
export const arbOperationSequence: fc.Arbitrary<OperationTemplate[]> = fc.array(
  arbOperationTemplate,
  { minLength: 0, maxLength: MAX_SEQUENCE_LENGTH, size: 'max' },
);
