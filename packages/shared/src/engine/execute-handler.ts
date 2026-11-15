import { validateHandler, validateStack } from '../format/index.ts';
import type { Action, Handler, Stack, StackObject } from '../format/index.ts';
import { effectFor } from './effects.ts';
import { findObject, textOf, withObject } from './stack-edit.ts';
import type { EffectRequest, ExecutionResult } from './types.ts';

const INVALID_STACK_MESSAGE = 'The stack is not valid, so no actions ran.';
const INVALID_HANDLER_MESSAGE = 'The handler is not valid for this stack, so no actions ran.';
const MAX_LIST_ITEMS = 500;

function listFullMessage(list: StackObject): string {
  const label = list.name === '' ? list.id : list.name;
  return `The list "${label}" is full (${MAX_LIST_ITEMS} items).`;
}

function skippedMessage(index: number, type: string, reason: string): string {
  return `Skipped action ${index + 1} (${type}): ${reason}.`;
}

/** The text a `set_value` or `append_item` Action supplies, or `undefined` when it cannot be read. */
function sourceText(stack: Stack, literal: string | undefined, fromObjectId: string | undefined) {
  if (literal !== undefined) {
    return literal;
  }
  if (fromObjectId === undefined) {
    return undefined;
  }
  const source = findObject(stack, fromObjectId);
  return source === undefined ? undefined : textOf(source);
}

type Step = { readonly stack: Stack; readonly message?: string };

/** The Actions that change the Stack: `set_value`, `append_item` and `remove_item`. */
type EditAction = Extract<Action, { type: 'set_value' | 'append_item' | 'remove_item' }>;

/** Compile-time exhaustiveness check: a tenth Action type makes the call site fail to compile. */
function unreachable(action: never): never {
  throw new Error(`Unhandled action type: ${JSON.stringify(action)}`);
}

/** Applies one `set_value`, `append_item` or `remove_item` Action. Never writes to `stack`. */
function applyEdit(stack: Stack, action: EditAction, index: number): Step {
  if (action.type === 'set_value') {
    const target = findObject(stack, action.targetObjectId);
    const text = sourceText(stack, action.value, action.fromObjectId);
    if (
      target === undefined ||
      (target.type !== 'field' && target.type !== 'ai-field') ||
      text === undefined
    ) {
      return {
        stack,
        message: skippedMessage(index, action.type, 'its target or source was not found'),
      };
    }
    const next = withObject(stack, target, { ...target, value: text });
    return validateStack(next).valid
      ? { stack: next }
      : {
          stack,
          message: skippedMessage(index, action.type, 'the result would not be a valid stack'),
        };
  }
  if (action.type === 'remove_item') {
    const target = findObject(stack, action.targetObjectId);
    if (target === undefined || target.type !== 'list') {
      return {
        stack,
        message: skippedMessage(index, action.type, 'its target or source was not found'),
      };
    }
    if (action.index >= target.items.length) {
      return { stack };
    }
    // Removing an item cannot break a limit, so the result stays a valid stack.
    const items = target.items.filter((_, position) => position !== action.index);
    return { stack: withObject(stack, target, { ...target, items }) };
  }
  // append_item
  const target = findObject(stack, action.targetObjectId);
  const text = sourceText(stack, action.item, action.fromObjectId);
  if (target === undefined || target.type !== 'list' || text === undefined) {
    return {
      stack,
      message: skippedMessage(index, action.type, 'its target or source was not found'),
    };
  }
  if (target.items.length >= MAX_LIST_ITEMS) {
    return { stack, message: listFullMessage(target) };
  }
  const next = withObject(stack, target, { ...target, items: [...target.items, text] });
  return validateStack(next).valid
    ? { stack: next }
    : {
        stack,
        message: skippedMessage(index, action.type, 'the result would not be a valid stack'),
      };
}

/**
 * Runs the Actions of a Handler in order against a Stack and returns the new Stack,
 * the messages produced, the Effect_Requests to carry out, and an optional card to
 * navigate to. All nine Action types run:
 *
 * - `set_value`, `append_item` and `remove_item` change the Stack.
 * - `run_ai_field`, `fetch_news`, `transcribe_audio` and `schedule_notification` leave the
 *   Stack unchanged and append one Effect_Request (see `effectFor`). The executor only
 *   describes that work; the caller carries it out.
 * - `show_message` adds a message. `go_to_card` sets `navigateTo` and stops the Handler;
 *   effects and messages produced before it are kept.
 *
 * Pure: it never writes to its inputs.
 */
export function executeHandler(stack: Stack, handler: Handler): ExecutionResult {
  if (!validateStack(stack).valid) {
    return { stack, effects: [], messages: [INVALID_STACK_MESSAGE] };
  }
  if (!validateHandler(stack, handler).valid) {
    return { stack, effects: [], messages: [INVALID_HANDLER_MESSAGE] };
  }

  let current = stack;
  let navigateTo: string | undefined;
  const messages: string[] = [];
  const effects: EffectRequest[] = [];

  run: for (const [index, action] of handler.entries()) {
    switch (action.type) {
      case 'show_message':
        messages.push(action.text);
        break;
      case 'go_to_card':
        navigateTo = action.cardId;
        break run;
      case 'set_value':
      case 'append_item':
      case 'remove_item': {
        const step = applyEdit(current, action, index);
        current = step.stack;
        if (step.message !== undefined) {
          messages.push(step.message);
        }
        break;
      }
      case 'run_ai_field':
      case 'fetch_news':
      case 'transcribe_audio':
      case 'schedule_notification': {
        const effect = effectFor(current, action, index);
        if (effect !== undefined) {
          effects.push(effect);
        }
        break;
      }
      default:
        return unreachable(action);
    }
  }

  return {
    stack: current,
    effects,
    messages,
    ...(navigateTo === undefined ? {} : { navigateTo }),
  };
}
