import type { Action, Handler } from '../format/index.ts';

/** The Entity_IDs an Action refers to: cardId, targetObjectId, fromObjectId, atFromObjectId. */
export function actionReferences(action: Action): readonly string[] {
  switch (action.type) {
    case 'go_to_card':
      return [action.cardId];
    case 'set_value':
    case 'append_item':
      return action.fromObjectId === undefined
        ? [action.targetObjectId]
        : [action.targetObjectId, action.fromObjectId];
    case 'remove_item':
    case 'run_ai_field':
    case 'fetch_news':
    case 'transcribe_audio':
      return [action.targetObjectId];
    case 'show_message':
      return [];
    case 'schedule_notification':
      return action.atFromObjectId === undefined ? [] : [action.atFromObjectId];
  }
}

/**
 * Drops every Action that references an id for which `isRemoved` is true. An Action with two
 * removed references is dropped and counted once. Returns the same array (same reference) and
 * `removed: 0` when nothing is dropped. Never mutates the input.
 */
export function pruneHandler(
  handler: Handler,
  isRemoved: (referencedId: string) => boolean,
): { readonly handler: Handler; readonly removed: number } {
  const kept = handler.filter((action) => !actionReferences(action).some(isRemoved));
  if (kept.length === handler.length) {
    return { handler, removed: 0 };
  }
  return { handler: kept, removed: handler.length - kept.length };
}
