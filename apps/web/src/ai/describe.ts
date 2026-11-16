import { OBJECT_TYPES } from '@hypergeist/shared/format';
import type { ValidationError } from '@hypergeist/shared/format';

/*
 * One-line plain English descriptions of tool calls, for the Turn_Result steps (Requirement 6.5).
 *
 * The parameters come from a model, so they are untrusted `unknown`. Every read checks the
 * type first, every text is cleaned to one line and cut to 40 code points, and nothing here
 * throws, whatever the input is (including objects whose getters throw).
 */

/** The longest name or id shown in a description, in code points (the cut mark included). */
export const MAX_NAME_CODE_POINTS = 40;

/** The longest error message shown in a rejected-call description, in code points. */
const MAX_MESSAGE_CODE_POINTS = 200;

/** The part of a step that `describeResult` reads. `StepRecord` has these properties too. */
export type DescribableStep = {
  readonly tool: string;
  readonly ok: boolean;
  readonly errors?: readonly ValidationError[] | undefined;
};

const CUT_MARK = '\u2026';

/** Invisible characters that carry no meaning in a one-line description (zero width, bidi controls, BOM). */
function isInvisible(cp: number): boolean {
  return (
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/** Spaces and control characters. Each run becomes one space. */
function isBlank(cp: number): boolean {
  return cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0) || cp === 0x2028 || cp === 0x2029;
}

/**
 * Returns `value` as one clean line of at most `max` code points, or `null` when `value` is not
 * a string or has nothing visible. A longer text is cut and ends with "…". The scan stops after
 * `max + 1` code points, so a very long string costs no more than a short one.
 */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const out: string[] = [];
  let pendingSpace = false;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisible(cp)) continue;
    if (isBlank(cp)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out.push(' ');
      pendingSpace = false;
      if (out.length > max) break;
    }
    out.push(ch);
    if (out.length > max) break;
  }
  if (out.length === 0) return null;
  if (out.length <= max) return out.join('');
  return `${out
    .slice(0, max - 1)
    .join('')
    .trimEnd()}${CUT_MARK}`;
}

/** Reads an own property of a plain object. Returns `undefined` for anything else, and never throws. */
function readProp(params: unknown, key: string): unknown {
  try {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
    if (!Object.hasOwn(params, key)) return undefined;
    return (params as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** A name or id from the parameters, cleaned and cut to 40 code points. */
function readText(params: unknown, key: string): string | null {
  return cleanText(readProp(params, key), MAX_NAME_CODE_POINTS);
}

/** `card card-2` when the id parameter is usable text, otherwise `a card` (or `an object`). */
function reference(params: unknown, key: string, noun: string): string {
  const id = readText(params, key);
  return id === null ? withArticle(noun) : `${noun} ${id}`;
}

function quoted(text: string): string {
  return `"${text}"`;
}

/** The Object type as shown to the reader. Only the five known types appear; anything else is "object". */
function readObjectType(params: unknown): string {
  const raw = readProp(params, 'type');
  return OBJECT_TYPES.find((type) => type === raw) ?? 'object';
}

function withArticle(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
}

function describeAddObject(params: unknown): string {
  const type = readObjectType(params);
  // A button shows its label, every other type shows its name.
  const title =
    type === 'button'
      ? (readText(params, 'label') ?? readText(params, 'name'))
      : readText(params, 'name');
  const cardId = readText(params, 'cardId');
  const parts = [`Added ${withArticle(type)}`];
  if (title !== null) parts.push(quoted(title));
  if (cardId !== null) parts.push(`to ${cardId}`);
  return parts.join(' ');
}

/** The tools in one table, so a model-chosen name can never reach an inherited property. */
const CALL_DESCRIBERS: ReadonlyMap<string, (params: unknown) => string> = new Map<
  string,
  (params: unknown) => string
>([
  [
    'create_card',
    (params) => {
      const name = readText(params, 'name');
      return name === null ? 'Created a card' : `Created card ${quoted(name)}`;
    },
  ],
  ['delete_card', (params) => `Deleted ${reference(params, 'cardId', 'card')}`],
  ['add_object', describeAddObject],
  ['update_object', (params) => `Changed ${reference(params, 'objectId', 'object')}`],
  ['remove_object', (params) => `Removed ${reference(params, 'objectId', 'object')}`],
  [
    'link_cards',
    (params) => {
      const from = readText(params, 'fromCardId');
      const to = readText(params, 'toCardId');
      if (from === null && to === null) return 'Linked two cards';
      return `Linked ${from ?? 'a card'} to ${to ?? 'a card'}`;
    },
  ],
  [
    'set_action',
    (params) => {
      const owner = readText(params, 'ownerId');
      return owner === null ? 'Set what the button does' : `Set what ${owner} does`;
    },
  ],
  ['say', () => 'Said something'],
  [
    'create_stack',
    (params) => {
      const name = readText(params, 'name');
      return name === null ? 'Named the stack' : `Named the stack ${quoted(name)}`;
    },
  ],
]);

/** The action of each tool as it reads after "Could not". */
const FAILED_ACTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  ['create_card', 'create the card'],
  ['delete_card', 'delete the card'],
  ['add_object', 'add the object'],
  ['update_object', 'change the object'],
  ['remove_object', 'remove the object'],
  ['link_cards', 'link the cards'],
  ['set_action', 'set the action'],
  ['say', 'say that'],
  ['create_stack', 'name the stack'],
]);

const UNKNOWN_CALL = 'Ran an unknown tool';
const UNKNOWN_ACTION = 'run an unknown tool';

/**
 * One plain English line for an accepted tool call, for example `Added a button "Add" to card-1`.
 * `tool` and `params` are untrusted. Names and ids are cut to 40 code points, and a missing or
 * wrongly typed parameter gives a generic line (`Created a card`). The tool name is never echoed.
 * Never throws.
 */
export function describeCall(tool: string, params: unknown): string {
  try {
    if (typeof tool !== 'string') return UNKNOWN_CALL;
    const describer = CALL_DESCRIBERS.get(tool);
    return describer === undefined ? UNKNOWN_CALL : describer(params);
  } catch {
    return UNKNOWN_CALL;
  }
}

/**
 * One plain English line for a step. A rejected step reads `Could not <action>: <first error
 * message>` (the message is cut to 200 code points), or `Could not <action>` when there is no
 * usable message. An accepted step reads like `describeCall(tool, undefined)`. Never throws.
 */
export function describeResult(step: DescribableStep): string {
  try {
    const tool: unknown = step.tool;
    const key = typeof tool === 'string' ? tool : '';
    if (step.ok === true) return describeCall(key, undefined);
    const action = FAILED_ACTIONS.get(key) ?? UNKNOWN_ACTION;
    const errors: unknown = step.errors;
    const first: unknown = Array.isArray(errors) ? (errors as unknown[])[0] : undefined;
    const message = cleanText(readProp(first, 'message'), MAX_MESSAGE_CODE_POINTS);
    return message === null ? `Could not ${action}` : `Could not ${action}: ${message}`;
  } catch {
    return `Could not ${UNKNOWN_ACTION}`;
  }
}
