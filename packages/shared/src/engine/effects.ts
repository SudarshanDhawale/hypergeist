import type { Action, Stack } from '../format/index.ts';
import { findObject, textOf } from './stack-edit.ts';
import type { EffectInput, EffectRequest } from './types.ts';

/**
 * Describes the outside-world work an Action asks for, as plain data.
 *
 * Returns one `EffectRequest` for `run_ai_field`, `fetch_news`, `transcribe_audio` and
 * `schedule_notification`, and `undefined` for every other Action type. `index` is the
 * zero-based position of the Action in its Handler and becomes `actionIndex`.
 *
 * Pure: the Stack is only read, never changed. Source text is resolved here (the same
 * `textOf` rule as `set_value`), so a runtime needs no access to the Stack. An id that
 * does not resolve (not reachable for a valid Stack and Handler) gives empty strings
 * instead of throwing.
 */
export function effectFor(stack: Stack, action: Action, index: number): EffectRequest | undefined {
  switch (action.type) {
    case 'run_ai_field': {
      const target = findObject(stack, action.targetObjectId);
      const inputIds = target?.type === 'ai-field' ? target.inputObjectIds : [];
      const inputs: EffectInput[] = inputIds.map((objectId) => {
        const source = findObject(stack, objectId);
        return {
          objectId,
          name: source?.name ?? '',
          text: source === undefined ? '' : textOf(source),
        };
      });
      return {
        kind: 'run_ai_field',
        actionIndex: index,
        targetObjectId: action.targetObjectId,
        prompt: target?.type === 'ai-field' ? target.prompt : '',
        inputs,
      };
    }
    case 'fetch_news':
      return {
        kind: 'fetch_news',
        actionIndex: index,
        targetObjectId: action.targetObjectId,
        topics: [...action.topics],
      };
    case 'transcribe_audio':
      return {
        kind: 'transcribe_audio',
        actionIndex: index,
        targetObjectId: action.targetObjectId,
      };
    case 'schedule_notification': {
      if (action.atFromObjectId !== undefined) {
        const source = findObject(stack, action.atFromObjectId);
        return {
          kind: 'schedule_notification',
          actionIndex: index,
          message: action.message,
          at: source === undefined ? '' : textOf(source),
          atFromObjectId: action.atFromObjectId,
        };
      }
      return {
        kind: 'schedule_notification',
        actionIndex: index,
        message: action.message,
        at: action.at ?? '',
      };
    }
    default:
      return undefined;
  }
}
