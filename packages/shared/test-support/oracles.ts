/**
 * Independent test oracles for the stack-format-and-validator spec.
 *
 * Nothing here imports production code. Each oracle is written from the
 * requirements and the design, so a bug that production code shares with its
 * own helpers cannot cancel itself out in a property test.
 */

/* ---------- JSON Pointer (RFC 6901) ---------- */

/** Escapes one object key for use as a JSON Pointer token: `~` becomes `~0`, `/` becomes `~1`. */
export function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

export type PointerResolution =
  /** The pointer resolves to a location in the value. */
  | { readonly kind: 'found'; readonly value: unknown }
  /** The pointer does not resolve. `pointer` is the deepest prefix that does, with its value. */
  | { readonly kind: 'ancestor'; readonly pointer: string; readonly value: unknown }
  /** The pointer is not a syntactically valid RFC 6901 pointer. */
  | { readonly kind: 'malformed' };

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;
const BAD_ESCAPE = /~(?![01])/;

function unescapePointerToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function child(
  parent: unknown,
  token: string,
): { readonly exists: boolean; readonly value: unknown } {
  if (Array.isArray(parent)) {
    if (ARRAY_INDEX.test(token) && Number(token) < parent.length) {
      return { exists: true, value: parent[Number(token)] };
    }
    return { exists: false, value: undefined };
  }
  if (typeof parent === 'object' && parent !== null) {
    if (Object.hasOwn(parent, token)) {
      return { exists: true, value: (parent as Record<string, unknown>)[token] };
    }
  }
  return { exists: false, value: undefined };
}

/**
 * Resolves an RFC 6901 pointer against a value. When the location does not exist,
 * returns the nearest existing ancestor (the longest resolvable prefix).
 * The empty pointer is the root. Array tokens must be canonical decimal indexes
 * (no leading zeros, no `-`) that are less than the array length.
 */
export function resolvePointer(root: unknown, pointer: string): PointerResolution {
  if (pointer === '') {
    return { kind: 'found', value: root };
  }
  if (!pointer.startsWith('/')) {
    return { kind: 'malformed' };
  }
  const rawTokens = pointer.slice(1).split('/');
  if (rawTokens.some((token) => BAD_ESCAPE.test(token))) {
    return { kind: 'malformed' };
  }
  let current: unknown = root;
  let resolvedPointer = '';
  for (const raw of rawTokens) {
    const next = child(current, unescapePointerToken(raw));
    if (!next.exists) {
      return { kind: 'ancestor', pointer: resolvedPointer, value: current };
    }
    current = next.value;
    resolvedPointer = `${resolvedPointer}/${raw}`;
  }
  return { kind: 'found', value: current };
}

/* ---------- document-order traversal ---------- */

/**
 * Every pointer in the value in depth-first, pre-order document order: the root
 * (`""`) first, then each child subtree in turn. Object properties are visited in
 * the order `Object.keys` gives, array elements in index order.
 */
export function documentOrderPaths(root: unknown): string[] {
  const paths: string[] = [];
  const pending: Array<{ readonly path: string; readonly value: unknown }> = [
    { path: '', value: root },
  ];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) {
      break;
    }
    paths.push(item.path);
    const children: Array<{ readonly path: string; readonly value: unknown }> = [];
    if (Array.isArray(item.value)) {
      item.value.forEach((element: unknown, index: number) => {
        children.push({ path: `${item.path}/${index}`, value: element });
      });
    } else if (typeof item.value === 'object' && item.value !== null) {
      for (const key of Object.keys(item.value)) {
        children.push({
          path: `${item.path}/${escapePointerToken(key)}`,
          value: (item.value as Record<string, unknown>)[key],
        });
      }
    }
    // Push in reverse so the first child is popped (visited) first.
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const next = children[index];
      if (next !== undefined) {
        pending.push(next);
      }
    }
  }
  return paths;
}

/* ---------- canonical key order ---------- */

const COMMON_KEYS = ['id', 'type', 'name', 'x', 'y', 'width', 'height'] as const;

/** The design's "Canonical key order" table, one row per entity. */
export const ENTITY_KEY_ORDER = {
  stack: [
    'formatVersion',
    'id',
    'name',
    'cardWidth',
    'cardHeight',
    'startCardId',
    'remixedFrom',
    'cards',
  ],
  card: ['id', 'name', 'objects', 'links', 'onOpen'],
  link: ['id', 'label', 'targetCardId'],
  button: [...COMMON_KEYS, 'label', 'onClick'],
  field: [...COMMON_KEYS, 'value', 'placeholder', 'multiline', 'readOnly'],
  image: [...COMMON_KEYS, 'src', 'alt'],
  list: [...COMMON_KEYS, 'items', 'ordered'],
  'ai-field': [...COMMON_KEYS, 'prompt', 'inputObjectIds', 'value'],
} as const satisfies Record<string, readonly string[]>;

/** The design's Action table: `type` first, then the target or card id, then the rest. */
export const ACTION_KEY_ORDER = {
  go_to_card: ['type', 'cardId'],
  set_value: ['type', 'targetObjectId', 'value', 'fromObjectId'],
  append_item: ['type', 'targetObjectId', 'item', 'fromObjectId'],
  remove_item: ['type', 'targetObjectId', 'index'],
  show_message: ['type', 'text'],
  run_ai_field: ['type', 'targetObjectId'],
  fetch_news: ['type', 'targetObjectId', 'topics'],
  transcribe_audio: ['type', 'targetObjectId'],
  schedule_notification: ['type', 'message', 'at', 'atFromObjectId'],
} as const satisfies Record<string, readonly string[]>;

const OBJECT_TYPE_NAMES = ['button', 'field', 'image', 'list', 'ai-field'] as const;

export type KeyOrderViolation = { readonly path: string; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnKey<T extends object>(table: T, key: string): key is Extract<keyof T, string> {
  return Object.hasOwn(table, key);
}

function checkKeys(
  value: Record<string, unknown>,
  order: readonly string[],
  path: string,
  label: string,
  out: KeyOrderViolation[],
): void {
  const actual = Object.keys(value);
  const expected = order.filter((key) => Object.hasOwn(value, key));
  const unknown = actual.filter((key) => !order.includes(key));
  if (unknown.length > 0) {
    out.push({
      path,
      message: `${label} has keys that are not in the table: ${unknown.join(', ')}`,
    });
    return;
  }
  if (actual.join('\u0000') !== expected.join('\u0000')) {
    out.push({
      path,
      message: `${label} keys are ${actual.join(', ')}; the table order is ${expected.join(', ')}`,
    });
  }
}

function checkHandler(handler: unknown, path: string, out: KeyOrderViolation[]): void {
  if (!Array.isArray(handler)) {
    return;
  }
  handler.forEach((action: unknown, index: number) => {
    if (!isRecord(action)) {
      return;
    }
    const type = action['type'];
    if (typeof type === 'string' && hasOwnKey(ACTION_KEY_ORDER, type)) {
      checkKeys(action, ACTION_KEY_ORDER[type], `${path}/${index}`, `Action ${type}`, out);
    }
  });
}

/**
 * Compares the keys of every object in a stack-shaped value (Stack, Cards, Links,
 * Objects, Actions) with the canonical table. Optional keys may be absent, but the
 * keys that are present must follow the table order and no other key may appear.
 * Returns an empty array when the order is canonical. Tolerant of malformed input.
 */
export function canonicalKeyViolations(stack: unknown): KeyOrderViolation[] {
  const out: KeyOrderViolation[] = [];
  if (!isRecord(stack)) {
    return out;
  }
  checkKeys(stack, ENTITY_KEY_ORDER.stack, '', 'Stack', out);
  const cards = stack['cards'];
  if (!Array.isArray(cards)) {
    return out;
  }
  cards.forEach((card: unknown, cardIndex: number) => {
    if (!isRecord(card)) {
      return;
    }
    const cardPath = `/cards/${cardIndex}`;
    checkKeys(card, ENTITY_KEY_ORDER.card, cardPath, 'Card', out);
    checkHandler(card['onOpen'], `${cardPath}/onOpen`, out);
    const links = card['links'];
    if (Array.isArray(links)) {
      links.forEach((link: unknown, index: number) => {
        if (isRecord(link)) {
          checkKeys(link, ENTITY_KEY_ORDER.link, `${cardPath}/links/${index}`, 'Link', out);
        }
      });
    }
    const objects = card['objects'];
    if (Array.isArray(objects)) {
      objects.forEach((object: unknown, index: number) => {
        if (!isRecord(object)) {
          return;
        }
        const objectPath = `${cardPath}/objects/${index}`;
        const type = object['type'];
        if (typeof type === 'string' && (OBJECT_TYPE_NAMES as readonly string[]).includes(type)) {
          const objectType = type as (typeof OBJECT_TYPE_NAMES)[number];
          checkKeys(object, ENTITY_KEY_ORDER[objectType], objectPath, `Object ${type}`, out);
        }
        if (type === 'button') {
          checkHandler(object['onClick'], `${objectPath}/onClick`, out);
        }
      });
    }
  });
  return out;
}

/* ---------- line and column ---------- */

/**
 * Line and column of a UTF-16 offset in a text. Lines break at `\n` only (so `\r\n`
 * counts once and a lone `\r` does not break a line). Columns count UTF-16 code
 * units from the start of the line. Both are 1-based. The offset may equal
 * `text.length` (the end of the text). Throws RangeError for any other offset.
 */
export function lineAndColumn(
  text: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    throw new RangeError(`offset ${offset} is outside 0..${text.length}`);
  }
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/* ---------- image source predicate ---------- */

const HTTPS_PREFIX = 'https://';
const HTTPS_MAX_LENGTH = 2000;
const DATA_MAX_LENGTH = 1_000_000;
const AUTHORITY_EXTRA = "._~%!$&'()*+,;=:[]-";
const DATA_TYPES = ['png', 'jpeg', 'gif', 'webp'] as const;

function isAsciiAlnum(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function isHttpsSource(src: string): boolean {
  if (!src.startsWith(HTTPS_PREFIX) || src.length > HTTPS_MAX_LENGTH) {
    return false;
  }
  let index = HTTPS_PREFIX.length;
  const authorityStart = index;
  while (index < src.length) {
    const code = src.charCodeAt(index);
    if (isAsciiAlnum(code) || AUTHORITY_EXTRA.includes(src.charAt(index))) {
      index += 1;
    } else {
      break;
    }
  }
  if (index === authorityStart) {
    return false;
  }
  if (index === src.length) {
    return true;
  }
  if (!'/?#'.includes(src.charAt(index))) {
    return false;
  }
  for (; index < src.length; index += 1) {
    const code = src.charCodeAt(index);
    // Printable ASCII except space and backslash.
    if (code < 0x21 || code > 0x7e || code === 0x5c) {
      return false;
    }
  }
  return true;
}

function isBase64Payload(payload: string): boolean {
  if (payload.length === 0 || payload.length % 4 !== 0) {
    return false;
  }
  let padding = 0;
  if (payload.endsWith('==')) {
    padding = 2;
  } else if (payload.endsWith('=')) {
    padding = 1;
  }
  const body = payload.slice(0, payload.length - padding);
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (!isAsciiAlnum(code) && code !== 0x2b && code !== 0x2f) {
      return false;
    }
  }
  return true;
}

function isDataSource(src: string): boolean {
  if (src.length > DATA_MAX_LENGTH) {
    return false;
  }
  for (const type of DATA_TYPES) {
    const prefix = `data:image/${type};base64,`;
    if (src.startsWith(prefix)) {
      return isBase64Payload(src.slice(prefix.length));
    }
  }
  return false;
}

/**
 * Whether a value is a valid Image `src` (Requirement 4.4): an `https:` URL of at most
 * 2,000 characters with a non-empty authority and no user info, or a base64
 * `data:image/(png|jpeg|gif|webp)` URI of at most 1,000,000 characters. Written as
 * character checks, not as a regular expression, so it is independent of
 * `IMAGE_SRC_PATTERN`.
 */
export function isValidImageSrc(src: unknown): boolean {
  if (typeof src !== 'string') {
    return false;
  }
  return isHttpsSource(src) || isDataSource(src);
}

/* ---------- UTC timestamp predicate ---------- */

const TIMESTAMP =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?Z$/;

/**
 * Whether a value is a UTC timestamp as Requirement 6.11 means it:
 * `YYYY-MM-DDTHH:mm:ss`, an optional fraction, then `Z`. Hours 00 to 23, minutes and
 * seconds 00 to 59, and a real calendar date, decided by a `Date` round trip in UTC.
 * Offsets, lowercase `t` or `z`, a missing seconds part, `24:00:00`, and second 60
 * are all invalid.
 */
export function isValidUtcTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const match = TIMESTAMP.exec(value);
  if (match === null) {
    return false;
  }
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return false;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  // setUTCFullYear avoids Date.UTC's mapping of years 0 to 99 onto 1900 to 1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
