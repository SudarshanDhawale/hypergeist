/** Format version written by and accepted by this release. */
export const FORMAT_VERSION = 1 as const;

/** Entity_ID pattern shared with the full stack-format-and-validator spec. */
export const ENTITY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Image source pattern. ASCII only, so the UTF-16 length equals the code point count.
 * Two alternatives:
 * - `https:` URL: lowercase scheme, a non-empty authority without user info, then
 *   optionally `/`, `?` or `#` followed by printable ASCII except space and backslash.
 * - `data:` URI: `data:image/` with png, jpeg, gif or webp, `;base64,`, then a
 *   non-empty, well-formed base64 payload (groups of four, with `=` padding at the end).
 * The length limits (2,000 for `https:`, 1,000,000 overall) are separate checks.
 */
export const IMAGE_SRC_PATTERN =
  /^(?:https:\/\/[A-Za-z0-9._~%!$&'()*+,;=:[\]-]+(?:[/?#][\x21-\x5B\x5D-\x7E]*)?|data:image\/(?:png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==))$/;

/** Object types of the format, in the order used in hints. */
export const OBJECT_TYPES = ['button', 'field', 'image', 'list', 'ai-field'] as const;

/** Action types of the format, in glossary order (the order used in hints). */
export const ACTION_TYPES = [
  'go_to_card',
  'set_value',
  'append_item',
  'remove_item',
  'show_message',
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
  imageAlt: { min: 0, max: 200 },
  imageHttpsSrc: { min: 1, max: 2000 },
  imageDataSrc: { min: 1, max: 1_000_000 },
  aiPrompt: { min: 1, max: 2000 },
  aiInputObjects: { min: 0, max: 10 },
  aiFieldValue: { min: 0, max: 10_000 },
  removeItemIndex: { min: 0 },
  newsTopics: { min: 1, max: 10 },
  newsTopicText: { min: 1, max: 100 },
  notificationMessage: { min: 1, max: 500 },
  maxDocumentBytes: 2_097_152,
  maxErrors: 100,
  actualMaxChars: 200,
} as const;
