import { ACTION_TYPES, LIMITS, OBJECT_TYPES } from './limits.ts';
import type { ValidationErrorCode } from './errors.ts';
import { limitMessages } from './limit-messages.ts';

/**
 * Semantic pass: cross-entity rules (ids, references, bounds, links, exactly-one-of).
 *
 * It walks the raw, unvalidated candidate with type guards and never imports the
 * Zod schemas. Any subtree that does not have the expected shape is skipped,
 * because the structural pass reports it. Objects and Actions of an unknown
 * type are skipped too, except that an Object's `id` is still registered.
 */

/** Path from the root of the walked value, as property names and array indexes. */
export type Segments = readonly (string | number)[];

/** The offending value, or a marker that the property is absent. */
export type SemanticActual =
  { readonly present: true; readonly value: unknown } | { readonly present: false };

/** An error before pointers are built and before sorting (see `finalize.ts`). */
export type SemanticError = {
  readonly code: ValidationErrorCode;
  readonly segments: Segments;
  readonly message: string;
  readonly expected: string;
  readonly hint: string;
  readonly actual: SemanticActual;
};

export type EntityKind = 'card' | 'object' | 'link';

export type EntityInfo = {
  readonly kind: EntityKind;
  /** Index of the Card that owns the entity (a Card owns itself). */
  readonly cardIndex: number;
  /** The Object `type` when it is a string. Only set for `kind: 'object'`. */
  readonly objectType?: string;
};

/** Maps each registered Entity_ID to the first entity that used it. */
export type EntityIndex = ReadonlyMap<string, EntityInfo>;

/** What a reference property may point at. */
type Target = 'card' | readonly string[];

const LIST_ONLY: Target = ['list'];
/** `run_ai_field.targetObjectId`. */
const AI_FIELD_ONLY: Target = ['ai-field'];
/** `transcribe_audio.targetObjectId`, `schedule_notification.atFromObjectId`. */
const FIELD_ONLY: Target = ['field'];
/** `set_value.targetObjectId`, `append_item.fromObjectId`. */
const FIELD_OR_AI_FIELD: Target = ['field', 'ai-field'];
/** `set_value.fromObjectId`. */
const FIELD_AI_FIELD_OR_LIST: Target = ['field', 'ai-field', 'list'];
/** Objects an ai-field may read as input (also needs the same Card). */
const AI_INPUT_TYPES: readonly string[] = ['field', 'list', 'ai-field'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Reads an own property only, so prototype members are never mistaken for data. */
function getOwn(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function present(value: unknown): SemanticActual {
  return { present: true, value };
}

/** Cuts long ids so a message stays short. */
function shown(text: string): string {
  const points = [...text];
  return points.length > 80 ? `${points.slice(0, 80).join('')}...` : text;
}

function describeTarget(target: Target): string {
  if (target === 'card') return 'a card';
  if (target.length === 1) return `a ${target[0]} object`;
  const last = target[target.length - 1];
  const head = target.slice(0, -1);
  const joined =
    target.length === 2 ? `${head.join('')} or ${last}` : `${head.join(', ')}, or ${last}`;
  return `a ${joined} object`;
}

function describeEntity(info: EntityInfo): string {
  if (info.kind === 'object') {
    return info.objectType === undefined ? 'an object' : `an object of type "${info.objectType}"`;
  }
  return `a ${info.kind}`;
}

function matchesTarget(info: EntityInfo, target: Target): boolean {
  if (target === 'card') return info.kind === 'card';
  return (
    info.kind === 'object' && info.objectType !== undefined && target.includes(info.objectType)
  );
}

/**
 * Builds the entity index in document order and reports `DUPLICATE_ID`.
 * Document order is Cards in array order and, in each Card, the Card id, then
 * Object ids in `objects` order, then Link ids in `links` order. The first
 * occurrence of an id stays in the index.
 */
export function buildEntityIndex(candidate: unknown): {
  readonly index: EntityIndex;
  readonly errors: readonly SemanticError[];
} {
  const index = new Map<string, EntityInfo>();
  const errors: SemanticError[] = [];

  const register = (segments: Segments, id: unknown, info: EntityInfo): void => {
    if (!isString(id)) return;
    if (index.has(id)) {
      errors.push({
        code: 'DUPLICATE_ID',
        segments,
        message: `The id "${shown(id)}" is already used by an earlier entity.`,
        expected: 'an id that is unique across all cards, objects, and links',
        hint: 'Rename this entity to an id that no other card, object, or link uses.',
        actual: present(id),
      });
      return;
    }
    index.set(id, info);
  };

  const cards = isRecord(candidate) ? getOwn(candidate, 'cards') : undefined;
  if (Array.isArray(cards)) {
    cards.forEach((card: unknown, cardIndex) => {
      if (!isRecord(card)) return;
      register(['cards', cardIndex, 'id'], getOwn(card, 'id'), { kind: 'card', cardIndex });

      const objects = getOwn(card, 'objects');
      if (Array.isArray(objects)) {
        objects.forEach((object: unknown, objectIndex) => {
          if (!isRecord(object)) return;
          const type = getOwn(object, 'type');
          register(['cards', cardIndex, 'objects', objectIndex, 'id'], getOwn(object, 'id'), {
            kind: 'object',
            cardIndex,
            ...(isString(type) ? { objectType: type } : {}),
          });
        });
      }

      const links = getOwn(card, 'links');
      if (Array.isArray(links)) {
        links.forEach((link: unknown, linkIndex) => {
          if (!isRecord(link)) return;
          register(['cards', cardIndex, 'links', linkIndex, 'id'], getOwn(link, 'id'), {
            kind: 'link',
            cardIndex,
          });
        });
      }
    });
  }

  return { index, errors };
}

/** Checks one reference property. A missing or non-string value is skipped (structural pass). */
function checkReference(
  record: Record<string, unknown>,
  key: string,
  basePath: Segments,
  index: EntityIndex,
  target: Target,
  errors: SemanticError[],
): void {
  const value = getOwn(record, key);
  if (!isString(value)) return;
  const segments = [...basePath, key];
  const info = index.get(value);
  if (info === undefined) {
    errors.push({
      code: 'DANGLING_REFERENCE',
      segments,
      message: `The id "${shown(value)}" does not match any entity in this stack.`,
      expected: `the id of ${describeTarget(target)} in this stack`,
      hint: `Use the id of ${describeTarget(target)} that exists in this stack, or add the missing entity.`,
      actual: present(value),
    });
  } else if (!matchesTarget(info, target)) {
    errors.push({
      code: 'WRONG_REFERENCE_TYPE',
      segments,
      message: `The id "${shown(value)}" belongs to ${describeEntity(info)}, which this property cannot reference.`,
      expected: `the id of ${describeTarget(target)}`,
      hint: `Point this property at ${describeTarget(target)} instead.`,
      actual: present(value),
    });
  }
}

/**
 * Reports `LIMIT_EXCEEDED` at `path` when the raw value is an array with more than `max`
 * items. Anything that is not an array is skipped (the structural pass reports it). Zod
 * does not enforce array maximums, so an oversize array still has its elements checked.
 */
export function checkArrayLimit(
  value: unknown,
  path: Segments,
  max: number,
): SemanticError | undefined {
  if (!Array.isArray(value) || value.length <= max) return undefined;
  const texts = limitMessages('array', max, value.length);
  return {
    code: 'LIMIT_EXCEEDED',
    segments: path,
    message: texts.message,
    expected: texts.expected,
    hint: texts.hint,
    actual: present(value),
  };
}

/** Pushes the error of `checkArrayLimit`, if there is one. */
function pushArrayLimit(
  value: unknown,
  path: Segments,
  max: number,
  errors: SemanticError[],
): void {
  const found = checkArrayLimit(value, path, max);
  if (found !== undefined) errors.push(found);
}

/** Reports `INVALID_VALUE` when both or neither property of an exactly-one-of pair is present. */
function checkExactlyOne(
  action: Record<string, unknown>,
  first: string,
  second: string,
  actionPath: Segments,
  errors: SemanticError[],
): void {
  const hasFirst = Object.hasOwn(action, first);
  const hasSecond = Object.hasOwn(action, second);
  if (hasFirst === hasSecond) {
    errors.push({
      code: 'INVALID_VALUE',
      segments: actionPath,
      message: hasFirst
        ? `The action has both "${first}" and "${second}".`
        : `The action has neither "${first}" nor "${second}".`,
      expected: `exactly one of "${first}" or "${second}"`,
      hint: hasFirst
        ? `Remove either "${first}" or "${second}".`
        : `Add either "${first}" or "${second}".`,
      actual: present(action),
    });
  }
}

function walkAction(
  action: unknown,
  actionPath: Segments,
  index: EntityIndex,
  errors: SemanticError[],
): void {
  if (!isRecord(action)) return;
  const type = getOwn(action, 'type');
  if (!isString(type) || !(ACTION_TYPES as readonly string[]).includes(type)) return;

  switch (type) {
    case 'go_to_card':
      checkReference(action, 'cardId', actionPath, index, 'card', errors);
      break;
    case 'set_value':
      checkReference(action, 'targetObjectId', actionPath, index, FIELD_OR_AI_FIELD, errors);
      checkReference(action, 'fromObjectId', actionPath, index, FIELD_AI_FIELD_OR_LIST, errors);
      checkExactlyOne(action, 'value', 'fromObjectId', actionPath, errors);
      break;
    case 'append_item':
      checkReference(action, 'targetObjectId', actionPath, index, LIST_ONLY, errors);
      checkReference(action, 'fromObjectId', actionPath, index, FIELD_OR_AI_FIELD, errors);
      checkExactlyOne(action, 'item', 'fromObjectId', actionPath, errors);
      break;
    case 'remove_item':
      checkReference(action, 'targetObjectId', actionPath, index, LIST_ONLY, errors);
      break;
    case 'run_ai_field':
      checkReference(action, 'targetObjectId', actionPath, index, AI_FIELD_ONLY, errors);
      break;
    case 'fetch_news':
      checkReference(action, 'targetObjectId', actionPath, index, LIST_ONLY, errors);
      pushArrayLimit(
        getOwn(action, 'topics'),
        [...actionPath, 'topics'],
        LIMITS.newsTopics.max,
        errors,
      );
      break;
    case 'transcribe_audio':
      checkReference(action, 'targetObjectId', actionPath, index, FIELD_ONLY, errors);
      break;
    case 'schedule_notification':
      checkReference(action, 'atFromObjectId', actionPath, index, FIELD_ONLY, errors);
      checkExactlyOne(action, 'at', 'atFromObjectId', actionPath, errors);
      break;
    default:
      // show_message has no reference and no exactly-one-of pair.
      break;
  }
}

/**
 * The one Handler walker. Buttons (`onClick`), Cards (`onOpen`), and
 * `validateHandler` (with `handlerPath` of `[]`) all call it. A candidate that
 * is not an array, and any element that is not an Action of a known type, is skipped.
 */
export function walkHandler(
  handler: unknown,
  handlerPath: Segments,
  index: EntityIndex,
): readonly SemanticError[] {
  const errors: SemanticError[] = [];
  pushArrayLimit(handler, handlerPath, LIMITS.handlerActions.max, errors);
  if (Array.isArray(handler)) {
    handler.forEach((action: unknown, actionIndex) => {
      walkAction(action, [...handlerPath, actionIndex], index, errors);
    });
  }
  return errors;
}

/** Reports `OUT_OF_BOUNDS` once per Object. The edge is inclusive. */
function checkBounds(
  object: Record<string, unknown>,
  objectPath: Segments,
  cardWidth: unknown,
  cardHeight: unknown,
  errors: SemanticError[],
): void {
  const x = getOwn(object, 'x');
  const y = getOwn(object, 'y');
  const width = getOwn(object, 'width');
  const height = getOwn(object, 'height');
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    !isFiniteNumber(cardWidth) ||
    !isFiniteNumber(cardHeight)
  ) {
    return;
  }
  const past: string[] = [];
  if (x + width > cardWidth)
    past.push(`right edge ${x + width} is past the card width ${cardWidth}`);
  if (y + height > cardHeight) {
    past.push(`bottom edge ${y + height} is past the card height ${cardHeight}`);
  }
  if (past.length === 0) return;
  errors.push({
    code: 'OUT_OF_BOUNDS',
    segments: objectPath,
    message: `The object does not fit on the card: its ${past.join(' and its ')}.`,
    expected: `x + width at most ${cardWidth} and y + height at most ${cardHeight}`,
    hint: 'Move the object up or left, or make it smaller, so it ends inside the card.',
    actual: present(object),
  });
}

/** Reports `DUPLICATE_LINK` for a Link whose target an earlier Link in the same Card already has. */
function checkLinks(
  links: readonly unknown[],
  linksPath: Segments,
  index: EntityIndex,
  errors: SemanticError[],
): void {
  const seen = new Set<string>();
  links.forEach((link: unknown, linkIndex) => {
    if (!isRecord(link)) return;
    const target = getOwn(link, 'targetCardId');
    const linkPath = [...linksPath, linkIndex];
    checkReference(link, 'targetCardId', linkPath, index, 'card', errors);
    if (!isString(target)) return;
    if (seen.has(target)) {
      errors.push({
        code: 'DUPLICATE_LINK',
        segments: [...linkPath, 'targetCardId'],
        message: `An earlier link on this card already points to "${shown(target)}".`,
        expected: 'at most one link per target card on each card',
        hint: 'Remove this link or point it at a different card.',
        actual: present(target),
      });
    } else {
      seen.add(target);
    }
  });
}

/** Pushes a `WRONG_REFERENCE_TYPE` error for one `inputObjectIds` entry. */
function wrongInput(
  segments: Segments,
  value: string,
  aiFieldId: string,
  reason: string,
  errors: SemanticError[],
): void {
  errors.push({
    code: 'WRONG_REFERENCE_TYPE',
    segments,
    message: `The ai-field "${shown(aiFieldId)}" cannot use "${shown(value)}" as an input, because ${reason}.`,
    expected:
      'the id of a field, list, or ai-field object on the same card, other than the ai-field itself',
    hint: 'Use the id of a field, list, or another ai-field on the same card, or remove this entry.',
    actual: present(value),
  });
}

/** Checks every entry of an ai-field's `inputObjectIds` (4.7, 4.8) and reports repeated ids. */
function checkAiInputs(
  aiField: Record<string, unknown>,
  objectPath: Segments,
  cardIndex: number,
  index: EntityIndex,
  errors: SemanticError[],
): void {
  const inputs = getOwn(aiField, 'inputObjectIds');
  const inputsPath: Segments = [...objectPath, 'inputObjectIds'];
  const ownId = getOwn(aiField, 'id');
  const aiFieldId = isString(ownId) ? ownId : '(no id)';
  const tooMany = checkArrayLimit(inputs, inputsPath, LIMITS.aiInputObjects.max);
  if (tooMany !== undefined) {
    errors.push({
      ...tooMany,
      message: `${tooMany.message} This is in the ai-field object "${shown(aiFieldId)}".`,
    });
  }
  if (!Array.isArray(inputs)) return;
  const seen = new Set<string>();

  inputs.forEach((entry: unknown, entryIndex) => {
    if (!isString(entry)) return;
    const segments = [...inputsPath, entryIndex];

    if (seen.has(entry)) {
      errors.push({
        code: 'INVALID_VALUE',
        segments,
        message: `The ai-field "${shown(aiFieldId)}" lists the input "${shown(entry)}" more than once.`,
        expected: 'each input id at most once',
        hint: 'Remove the repeated entry.',
        actual: present(entry),
      });
    }
    seen.add(entry);

    const info = index.get(entry);
    if (info === undefined) {
      errors.push({
        code: 'DANGLING_REFERENCE',
        segments,
        message: `The id "${shown(entry)}" in the inputs of ai-field "${shown(aiFieldId)}" does not match any entity in this stack.`,
        expected: 'the id of a field, list, or ai-field object on the same card',
        hint: 'Use the id of a field, list, or ai-field on the same card, or remove this entry.',
        actual: present(entry),
      });
    } else if (entry === ownId) {
      wrongInput(segments, entry, aiFieldId, 'an ai-field cannot use itself as an input', errors);
    } else if (info.kind !== 'object') {
      wrongInput(
        segments,
        entry,
        aiFieldId,
        `it is ${describeEntity(info)}, not an object`,
        errors,
      );
    } else if (info.objectType === undefined || !AI_INPUT_TYPES.includes(info.objectType)) {
      wrongInput(
        segments,
        entry,
        aiFieldId,
        `it is ${describeEntity(info)}, and only field, list, and ai-field objects can be inputs`,
        errors,
      );
    } else if (info.cardIndex !== cardIndex) {
      wrongInput(segments, entry, aiFieldId, 'it is on a different card', errors);
    }
  });
}

function walkObject(
  object: unknown,
  objectPath: Segments,
  cardIndex: number,
  index: EntityIndex,
  cardWidth: unknown,
  cardHeight: unknown,
  errors: SemanticError[],
): void {
  if (!isRecord(object)) return;
  const type = getOwn(object, 'type');
  if (!isString(type) || !(OBJECT_TYPES as readonly string[]).includes(type)) return;

  checkBounds(object, objectPath, cardWidth, cardHeight, errors);
  if (type === 'button') {
    errors.push(...walkHandler(getOwn(object, 'onClick'), [...objectPath, 'onClick'], index));
  } else if (type === 'list') {
    pushArrayLimit(getOwn(object, 'items'), [...objectPath, 'items'], LIMITS.listItems.max, errors);
  } else if (type === 'ai-field') {
    checkAiInputs(object, objectPath, cardIndex, index, errors);
  }
}

/**
 * Runs every semantic rule over a raw candidate and returns the errors in
 * emission order (ids first, then the walk). `finalize.ts` sorts them into
 * document order, so the emission order does not matter to callers.
 */
export function runSemanticPass(candidate: unknown): readonly SemanticError[] {
  if (!isRecord(candidate)) return [];
  const { index, errors: idErrors } = buildEntityIndex(candidate);
  const errors: SemanticError[] = [...idErrors];

  checkReference(candidate, 'startCardId', [], index, 'card', errors);

  const cardWidth = getOwn(candidate, 'cardWidth');
  const cardHeight = getOwn(candidate, 'cardHeight');
  const cards = getOwn(candidate, 'cards');
  if (!Array.isArray(cards)) return errors;
  pushArrayLimit(cards, ['cards'], LIMITS.cards.max, errors);

  cards.forEach((card: unknown, cardIndex) => {
    if (!isRecord(card)) return;
    const cardPath: Segments = ['cards', cardIndex];

    const objects = getOwn(card, 'objects');
    pushArrayLimit(objects, [...cardPath, 'objects'], LIMITS.objectsPerCard.max, errors);
    if (Array.isArray(objects)) {
      objects.forEach((object: unknown, objectIndex) => {
        walkObject(
          object,
          [...cardPath, 'objects', objectIndex],
          cardIndex,
          index,
          cardWidth,
          cardHeight,
          errors,
        );
      });
    }

    const links = getOwn(card, 'links');
    pushArrayLimit(links, [...cardPath, 'links'], LIMITS.linksPerCard.max, errors);
    if (Array.isArray(links)) {
      checkLinks(links, [...cardPath, 'links'], index, errors);
    }

    errors.push(...walkHandler(getOwn(card, 'onOpen'), [...cardPath, 'onOpen'], index));
  });

  return errors;
}
