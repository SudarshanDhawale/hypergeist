import { validateHandler, validateStack } from '../format/index.ts';
import type { Action, Handler, Stack, StackObject } from '../format/index.ts';
import { findObject, textOf, withObject } from './stack-edit.ts';
import type { ExecutionResult } from './types.ts';

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

/** Applies one `set_value` or `append_item` Action. Never writes to `stack`. */
function applyEdit(stack: Stack, action: Action, index: number): Step {
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
  if (action.type === 'append_item') {
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
  return {
    stack,
    message: skippedMessage(index, action.type, 'this action type is not supported'),
  };
}

/**
 * Runs the Actions of a Handler in order against a Stack and returns the new Stack,
 * the messages produced, and an optional card to navigate to. Pure: it never writes to
 * its inputs, and `effects` is always empty in the slice.
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

  for (const [index, action] of handler.entries()) {
    if (action.type === 'show_message') {
      messages.push(action.text);
    } else if (action.type === 'go_to_card') {
      navigateTo = action.cardId;
      break;
    } else {
      const step = applyEdit(current, action, index);
      current = step.stack;
      if (step.message !== undefined) {
        messages.push(step.message);
      }
    }
  }

  return {
    stack: current,
    effects: [],
    messages,
    ...(navigateTo === undefined ? {} : { navigateTo }),
  };
}
