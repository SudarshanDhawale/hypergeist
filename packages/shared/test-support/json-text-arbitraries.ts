import * as fc from 'fast-check';

/*
 * fast-check generators for near-valid JSON text. They feed the property that compares the
 * JSON text scanner with `JSON.parse` (Property 17).
 *
 * - `arbArbitraryText`: arbitrary strings, mostly not JSON.
 * - `arbValidJsonText`: valid JSON text in several layouts (minified, indented, tabs, CRLF).
 * - `arbDeletedCharText`, `arbInsertedCharText`, `arbTruncatedText`: valid JSON text with
 *   one character deleted, one character inserted, or the end cut off.
 * - `arbCrlfJsonText`: text with CRLF line breaks, valid or with one broken character.
 * - `arbBomJsonText`: text that starts with a byte order mark.
 * - `arbJsonText`: a weighted mix of all of the above.
 *
 * Positions are UTF-16 code unit offsets, so a deletion may split a surrogate pair on purpose.
 * Nothing here knows how the scanner works. Everything is pure: the same seed gives the same text.
 */

const BYTE_ORDER_MARK = '\uFEFF';

/** Characters that are structural, whitespace, or otherwise likely to break JSON text. */
const HOSTILE_CHARACTERS: readonly string[] = [
  '{',
  '}',
  '[',
  ']',
  ',',
  ':',
  '"',
  '\\',
  "'",
  ' ',
  '\t',
  '\n',
  '\r',
  '\u000b',
  '\u000c',
  '\u0000',
  '\u001f',
  '\u007f',
  '\u00a0',
  '\u2028',
  '\u2029',
  BYTE_ORDER_MARK,
  '\ud800',
  '\udc00',
  '😀',
  '0',
  '1',
  '9',
  '-',
  '+',
  '.',
  'e',
  'E',
  'a',
  't',
  'n',
  'u',
  '/',
  '#',
];

const arbHostileCharacter: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...HOSTILE_CHARACTERS),
  fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
);

/** How the generated JSON value is written out. */
type Layout = 'minified' | 'indent-2' | 'indent-tab' | 'crlf';

const arbLayout: fc.Arbitrary<Layout> = fc.constantFrom<Layout>(
  'minified',
  'indent-2',
  'indent-tab',
  'crlf',
);

function writeJson(value: unknown, layout: Layout): string {
  switch (layout) {
    case 'minified':
      return JSON.stringify(value);
    case 'indent-2':
      return JSON.stringify(value, null, 2);
    case 'indent-tab':
      return JSON.stringify(value, null, '\t');
    case 'crlf':
      // JSON.stringify escapes line breaks inside strings, so every "\n" here is layout.
      return JSON.stringify(value, null, 2).replace(/\n/g, '\r\n');
  }
}

const arbJsonValue: fc.Arbitrary<unknown> = fc.jsonValue({ noUnicodeString: false });

const arbValidTextWithLayout = (layout: fc.Arbitrary<Layout>): fc.Arbitrary<string> =>
  fc.tuple(arbJsonValue, layout).map(([value, chosen]) => writeJson(value, chosen));

/** Arbitrary strings. Most are not JSON; some are accidentally valid (`1`, `"a"`, `[]`). */
export const arbArbitraryText: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string({ unit: 'binary', maxLength: 40 }) },
  { weight: 2, arbitrary: fc.string({ maxLength: 40 }) },
  {
    weight: 3,
    arbitrary: fc
      .array(arbHostileCharacter, { maxLength: 24 })
      .map((characters) => characters.join('')),
  },
);

/** Valid JSON text in one of four layouts. Always parses with `JSON.parse`. */
export const arbValidJsonText: fc.Arbitrary<string> = arbValidTextWithLayout(arbLayout);

/** An offset into `text`, in UTF-16 code units, from 0 up to and including `text.length`. */
function pickOffset(text: string, raw: number, includeEnd: boolean): number {
  const slots = includeEnd ? text.length + 1 : text.length;
  return slots === 0 ? 0 : raw % slots;
}

function deleteOneCharacter(text: string, raw: number): string {
  if (text.length === 0) {
    return text;
  }
  const offset = pickOffset(text, raw, false);
  return text.slice(0, offset) + text.slice(offset + 1);
}

function insertOneCharacter(text: string, raw: number, character: string): string {
  const offset = pickOffset(text, raw, true);
  return text.slice(0, offset) + character + text.slice(offset);
}

function truncate(text: string, raw: number): string {
  // The cut point is anywhere from 0 to text.length - 1, so the text always gets shorter.
  return text.slice(0, pickOffset(text, raw, false));
}

const arbRawOffset: fc.Arbitrary<number> = fc.nat({ max: 1_000_000 });

function withDeletedCharacter(base: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc.tuple(base, arbRawOffset).map(([text, raw]) => deleteOneCharacter(text, raw));
}

function withInsertedCharacter(base: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc
    .tuple(base, arbRawOffset, arbHostileCharacter)
    .map(([text, raw, character]) => insertOneCharacter(text, raw, character));
}

function withTruncation(base: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc.tuple(base, arbRawOffset).map(([text, raw]) => truncate(text, raw));
}

/** Valid JSON text with one UTF-16 code unit deleted. */
export const arbDeletedCharText: fc.Arbitrary<string> = withDeletedCharacter(arbValidJsonText);

/** Valid JSON text with one hostile character inserted at any offset, including the end. */
export const arbInsertedCharText: fc.Arbitrary<string> = withInsertedCharacter(arbValidJsonText);

/** Valid JSON text cut short at a random offset. */
export const arbTruncatedText: fc.Arbitrary<string> = withTruncation(arbValidJsonText);

const arbCrlfLayout: fc.Arbitrary<Layout> = fc.constant<Layout>('crlf');

const arbValidCrlfText: fc.Arbitrary<string> = arbValidTextWithLayout(arbCrlfLayout);

/** Text with CRLF line breaks: valid, with one character deleted or inserted, or truncated. */
export const arbCrlfJsonText: fc.Arbitrary<string> = fc.oneof(
  arbValidCrlfText,
  withDeletedCharacter(arbValidCrlfText),
  withInsertedCharacter(arbValidCrlfText),
  withTruncation(arbValidCrlfText),
);

/**
 * Text that starts with a byte order mark. `JSON.parse` rejects every such text, because the
 * mark is not JSON whitespace. The rest may be valid, near-valid, or arbitrary.
 */
export const arbBomJsonText: fc.Arbitrary<string> = fc
  .oneof(arbValidJsonText, arbDeletedCharText, arbInsertedCharText, arbTruncatedText)
  .map((text) => BYTE_ORDER_MARK + text);

/** A weighted mix of every generator in this file. */
export const arbJsonText: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: arbArbitraryText },
  { weight: 1, arbitrary: arbValidJsonText },
  { weight: 3, arbitrary: arbDeletedCharText },
  { weight: 3, arbitrary: arbInsertedCharText },
  { weight: 3, arbitrary: arbTruncatedText },
  { weight: 2, arbitrary: arbCrlfJsonText },
  { weight: 1, arbitrary: arbBomJsonText },
);
