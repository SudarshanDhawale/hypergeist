/** Format version written by and accepted by this release. */
export const FORMAT_VERSION = 1 as const;

/** Entity_ID pattern shared with the full stack-format-and-validator spec. */
export const ENTITY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Object types the thin slice accepts. */
export const SUPPORTED_OBJECT_TYPES = ['button', 'field', 'list'] as const;

/** Object types the full format defines but this release rejects. */
export const UNSUPPORTED_OBJECT_TYPES = ['image', 'ai-field'] as const;

/** Action types the thin slice accepts. */
export const SUPPORTED_ACTION_TYPES = [
  'go_to_card',
  'set_value',
  'append_item',
  'show_message',
] as const;

/** Action types the full format defines but this release rejects. */
export const UNSUPPORTED_ACTION_TYPES = [
  'remove_item',
  'run_ai_field',
  'fetch_news',
  'transcribe_audio',
  'schedule_notification',
] as const;

/**
 * Every numeric bound of the format. Text bounds count Unicode code points.
 * `min` and `max` are inclusive.
 */
export const LIMITS = {
  stackName: { min: 1, max: 100 },
  cardSize: { min: 64, max: 4096 },
  cards: { min: 1, max: 200 },
  cardName: { min: 1, max: 100 },
  objectsPerCard: { min: 0, max: 100 },
  linksPerCard: { min: 0, max: 50 },
  linkLabel: { min: 1, max: 100 },
  objectName: { min: 0, max: 100 },
  objectPosition: { min: 0, max: 4096 },
  objectSize: { min: 8, max: 4096 },
  buttonLabel: { min: 1, max: 100 },
  fieldValue: { min: 0, max: 10_000 },
  fieldPlaceholder: { min: 0, max: 200 },
  listItems: { min: 0, max: 500 },
  listItemText: { min: 0, max: 500 },
  handlerActions: { min: 0, max: 20 },
  setValueText: { min: 0, max: 10_000 },
  appendItemText: { min: 0, max: 500 },
  messageText: { min: 1, max: 500 },
  maxDocumentBytes: 2_097_152,
  maxErrors: 100,
  actualMaxChars: 200,
} as const;
