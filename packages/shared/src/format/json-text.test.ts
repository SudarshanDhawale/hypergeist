import { describe, expect, it } from 'vitest';
import { lineAndColumn } from '../../test-support/oracles.ts';
import { findJsonSyntaxError } from './json-text.ts';

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

describe('findJsonSyntaxError: well-formed text', () => {
  it.each([
    ['{}'],
    ['[]'],
    ['0'],
    ['-0'],
    ['1.5e+10'],
    ['-12.5E-3'],
    ['true'],
    ['false'],
    ['null'],
    ['""'],
    [' \t\r\n{"a":[1,2,{"b":null}],"c":"d"}\r\n '],
    ['"\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u00e9 \\uD83D\\uDE00"'],
    ['"\u2028\u2029 raw line separators are fine"'],
    ['"lone surrogate \ud800 is accepted by JSON.parse"'],
    ['{"":{"":[[[]]]}}'],
  ])('accepts %j', (text) => {
    expect(parses(text)).toBe(true);
    expect(findJsonSyntaxError(text)).toBeUndefined();
  });
});

describe('findJsonSyntaxError: location of the first error', () => {
  it('reports the first bad character', () => {
    expect(findJsonSyntaxError('{"a":}')).toEqual({ offset: 5, line: 1, column: 6, found: '}' });
  });

  it('reports a bad character in the middle of a line', () => {
    expect(findJsonSyntaxError('[1, 2, x]')).toEqual({ offset: 7, line: 1, column: 8, found: 'x' });
  });

  it('reports the end of the text for an unclosed container', () => {
    expect(findJsonSyntaxError('{"a":1')).toEqual({ offset: 6, line: 1, column: 7, found: null });
  });

  it('reports the end of the text for an empty text and for whitespace only', () => {
    expect(findJsonSyntaxError('')).toEqual({ offset: 0, line: 1, column: 1, found: null });
    expect(findJsonSyntaxError('  \n ')).toEqual({ offset: 4, line: 2, column: 2, found: null });
  });

  it('reports the end of the text for an unterminated string, a cut escape, and a cut literal', () => {
    expect(findJsonSyntaxError('"abc')?.found).toBeNull();
    expect(findJsonSyntaxError('"abc\\')).toMatchObject({ offset: 5, found: null });
    expect(findJsonSyntaxError('"\\u00')).toMatchObject({ offset: 5, found: null });
    expect(findJsonSyntaxError('tru')).toMatchObject({ offset: 3, found: null });
    expect(findJsonSyntaxError('-')).toMatchObject({ offset: 1, found: null });
  });

  it('reports the first character after a complete value', () => {
    expect(findJsonSyntaxError('{} x')).toMatchObject({ offset: 3, found: 'x' });
    expect(findJsonSyntaxError('1 2')).toMatchObject({ offset: 2, found: '2' });
  });

  it('counts lines at LF only, so a CRLF text reports the right line and column', () => {
    const text = '{\r\n  "a": 1,\r\n  "b": ?\r\n}';
    expect(findJsonSyntaxError(text)).toEqual({
      offset: text.indexOf('?'),
      line: 3,
      column: 8,
      found: '?',
    });
  });

  it('treats a CR-only file as one line', () => {
    const text = '{\r  "a": ?\r}';
    expect(findJsonSyntaxError(text)).toEqual({
      offset: text.indexOf('?'),
      line: 1,
      column: text.indexOf('?') + 1,
      found: '?',
    });
  });

  it('rejects a byte order mark at offset 0', () => {
    expect(findJsonSyntaxError('\uFEFF{}')).toEqual({
      offset: 0,
      line: 1,
      column: 1,
      found: '\uFEFF',
    });
  });

  it('counts columns in UTF-16 code units and reports a whole astral character', () => {
    const text = '["😀", 😀]';
    const offset = text.lastIndexOf('😀');
    expect(findJsonSyntaxError(text)).toEqual({
      offset,
      line: 1,
      column: offset + 1,
      found: '😀',
    });
  });

  it('agrees with the line and column oracle', () => {
    const bad = '[\n1,\n  2,\n   ]';
    const located = findJsonSyntaxError(bad);
    expect(located).toBeDefined();
    if (located !== undefined) {
      expect({ line: located.line, column: located.column }).toEqual(
        lineAndColumn(bad, located.offset),
      );
    }
  });
});

describe('findJsonSyntaxError: rejects what JSON.parse rejects', () => {
  it.each([
    ['trailing comma in array', '[1,]', 3],
    ['trailing comma in object', '{"a":1,}', 7],
    ['leading comma', '[,1]', 1],
    ['leading zero', '01', 1],
    ['leading zero after minus', '-01', 2],
    ['plus sign', '+1', 0],
    ['bare dot', '.5', 0],
    ['dot without digits', '1.', 2],
    ['exponent without digits', '1e', 2],
    ['exponent sign without digits', '1e+', 3],
    ['hex number', '0x10', 1],
    ['single quoted string', "'a'", 0],
    ['unquoted key', '{a:1}', 1],
    ['missing colon', '{"a" 1}', 5],
    ['missing comma', '[1 2]', 3],
    ['mismatched close', '[1}', 2],
    ['mismatched close in object', '{"a":1]', 6],
    ['raw tab in string', '"a\tb"', 2],
    ['raw line feed in string', '"a\nb"', 2],
    ['raw control character U+0000 in string', '"a\u0000b"', 2],
    ['bad escape', '"\\x"', 2],
    ['bad hex digit in \\u escape', '"\\u12G4"', 5],
    ['\\u escape cut short by the closing quote', '"\\u"', 3],
    ['NaN', 'NaN', 0],
    ['Infinity', 'Infinity', 0],
    ['undefined', 'undefined', 0],
    ['capitalised literal', 'True', 0],
    ['literal followed by letters', 'truex', 4],
    ['vertical tab as whitespace', '\u000b1', 0],
    ['no-break space as whitespace', '\u00a01', 0],
    ['comment', '/* c */ 1', 0],
    ['two top-level values', '{}{}', 2],
  ])('rejects %s', (_label, text, offset) => {
    expect(parses(text)).toBe(false);
    expect(findJsonSyntaxError(text)?.offset).toBe(offset);
  });
});

describe('findJsonSyntaxError: deep nesting', () => {
  it('handles a 2 MiB text of [ characters without overflowing the stack', () => {
    const text = '['.repeat(2_097_152);
    expect(findJsonSyntaxError(text)).toEqual({
      offset: text.length,
      line: 1,
      column: text.length + 1,
      found: null,
    });
  });

  it('accepts 100,000 levels of nesting that close properly', () => {
    const depth = 100_000;
    const text = '['.repeat(depth) + ']'.repeat(depth);
    expect(findJsonSyntaxError(text)).toBeUndefined();
  });

  it('finds an error after 100,000 levels of nesting', () => {
    const depth = 100_000;
    const text = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth - 1) + ']';
    expect(findJsonSyntaxError(text)).toMatchObject({ offset: text.length - 1, found: ']' });
  });
});
