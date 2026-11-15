import { describe, expect, it } from 'vitest';
import {
  ACTION_KEY_ORDER,
  ENTITY_KEY_ORDER,
  canonicalKeyViolations,
  documentOrderPaths,
  escapePointerToken,
  isValidImageSrc,
  isValidUtcTimestamp,
  lineAndColumn,
  resolvePointer,
} from './oracles.ts';

describe('resolvePointer', () => {
  const root = {
    cards: [{ id: 'a', objects: [] }],
    'a/b': { '~': 1 },
    nothing: null,
  };

  it('resolves the root, nested properties, and array elements', () => {
    expect(resolvePointer(root, '')).toEqual({ kind: 'found', value: root });
    expect(resolvePointer(root, '/cards/0/id')).toEqual({ kind: 'found', value: 'a' });
    expect(resolvePointer(root, '/cards/0/objects')).toEqual({ kind: 'found', value: [] });
  });

  it('unescapes ~1 and ~0', () => {
    expect(resolvePointer(root, '/a~1b/~0')).toEqual({ kind: 'found', value: 1 });
  });

  it('finds a property whose value is null', () => {
    expect(resolvePointer(root, '/nothing')).toEqual({ kind: 'found', value: null });
  });

  it('returns the nearest existing ancestor for a missing property', () => {
    expect(resolvePointer(root, '/cards/0/name')).toEqual({
      kind: 'ancestor',
      pointer: '/cards/0',
      value: { id: 'a', objects: [] },
    });
    expect(resolvePointer(root, '/missing/deeper')).toEqual({
      kind: 'ancestor',
      pointer: '',
      value: root,
    });
  });

  it('treats an out-of-range, leading-zero, or non-numeric array token as missing', () => {
    for (const pointer of ['/cards/1', '/cards/00', '/cards/-', '/cards/x']) {
      expect(resolvePointer(root, pointer)).toEqual({
        kind: 'ancestor',
        pointer: '/cards',
        value: root.cards,
      });
    }
  });

  it('stops at a primitive and does not follow inherited properties', () => {
    expect(resolvePointer(root, '/cards/0/id/length')).toEqual({
      kind: 'ancestor',
      pointer: '/cards/0/id',
      value: 'a',
    });
    expect(resolvePointer({}, '/constructor')).toEqual({
      kind: 'ancestor',
      pointer: '',
      value: {},
    });
  });

  it('reports a malformed pointer', () => {
    expect(resolvePointer(root, 'cards')).toEqual({ kind: 'malformed' });
    expect(resolvePointer(root, '/a~2')).toEqual({ kind: 'malformed' });
    expect(resolvePointer(root, '/a~')).toEqual({ kind: 'malformed' });
  });
});

describe('documentOrderPaths', () => {
  it('visits the root first, then each subtree depth-first in key order', () => {
    expect(documentOrderPaths({ b: [1, { c: 2 }], a: 3 })).toEqual([
      '',
      '/b',
      '/b/0',
      '/b/1',
      '/b/1/c',
      '/a',
    ]);
  });

  it('escapes keys and lists a primitive root as the empty path', () => {
    expect(escapePointerToken('a/b~c')).toBe('a~1b~0c');
    expect(documentOrderPaths({ 'a/b': {} })).toEqual(['', '/a~1b']);
    expect(documentOrderPaths(5)).toEqual(['']);
  });

  it('handles deep nesting without recursion', () => {
    let value: unknown = 0;
    for (let index = 0; index < 20_000; index += 1) {
      value = [value];
    }
    expect(documentOrderPaths(value)).toHaveLength(20_001);
  });
});

describe('canonicalKeyViolations', () => {
  const canonical = {
    formatVersion: 1,
    id: 's',
    name: 'S',
    cardWidth: 640,
    cardHeight: 480,
    startCardId: 'c',
    cards: [
      {
        id: 'c',
        name: 'C',
        objects: [
          {
            id: 'b',
            type: 'button',
            name: '',
            x: 0,
            y: 0,
            width: 8,
            height: 8,
            label: 'L',
            onClick: [{ type: 'set_value', targetObjectId: 'f', value: 'v' }],
          },
        ],
        links: [{ id: 'l', label: 'go', targetCardId: 'c' }],
        onOpen: [{ type: 'schedule_notification', message: 'm', at: '2026-12-01T09:00:00Z' }],
      },
    ],
  };

  it('accepts canonical order with optional keys absent', () => {
    expect(canonicalKeyViolations(canonical)).toEqual([]);
  });

  it('reports a Card, an Object, and an Action whose keys are out of order', () => {
    const card = canonical.cards[0];
    const button = card?.objects[0];
    if (card === undefined || button === undefined) {
      throw new Error('fixture is incomplete');
    }
    const reversed = (value: object): Record<string, unknown> =>
      Object.fromEntries(Object.entries(value).reverse());
    const shuffled = {
      ...canonical,
      cards: [
        reversed({
          ...card,
          objects: [
            reversed({
              ...button,
              onClick: [{ value: 'v', type: 'set_value', targetObjectId: 'f' }],
            }),
          ],
        }),
      ],
    };
    expect(canonicalKeyViolations(shuffled).map((violation) => violation.path)).toEqual([
      '/cards/0',
      '/cards/0/objects/0',
      '/cards/0/objects/0/onClick/0',
    ]);
  });

  it('reports a key that is not in the table', () => {
    expect(canonicalKeyViolations({ ...canonical, extra: 1 })).toHaveLength(1);
  });

  it('lists the keys of the design table', () => {
    expect(ENTITY_KEY_ORDER['ai-field']).toEqual([
      'id',
      'type',
      'name',
      'x',
      'y',
      'width',
      'height',
      'prompt',
      'inputObjectIds',
      'value',
    ]);
    expect(ACTION_KEY_ORDER.fetch_news).toEqual(['type', 'targetObjectId', 'topics']);
  });
});

describe('lineAndColumn', () => {
  it('numbers lines and columns from 1', () => {
    expect(lineAndColumn('', 0)).toEqual({ line: 1, column: 1 });
    expect(lineAndColumn('ab\ncd', 0)).toEqual({ line: 1, column: 1 });
    expect(lineAndColumn('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });

  it('counts a CRLF break once and puts the line feed itself at the end of its line', () => {
    expect(lineAndColumn('a\r\nb', 2)).toEqual({ line: 1, column: 3 });
    expect(lineAndColumn('a\r\nb', 3)).toEqual({ line: 2, column: 1 });
  });

  it('does not break a line at a lone carriage return', () => {
    expect(lineAndColumn('a\rb', 2)).toEqual({ line: 1, column: 3 });
  });

  it('accepts the end-of-text offset', () => {
    expect(lineAndColumn('a\n', 2)).toEqual({ line: 2, column: 1 });
    expect(lineAndColumn('abc', 3)).toEqual({ line: 1, column: 4 });
  });

  it('counts an astral character as two UTF-16 code units', () => {
    expect(lineAndColumn('\u{1F600}x', 2)).toEqual({ line: 1, column: 3 });
    expect(lineAndColumn('\u{1F600}\nx', 3)).toEqual({ line: 2, column: 1 });
  });

  it('throws for an offset outside the text', () => {
    expect(() => lineAndColumn('ab', 3)).toThrow(RangeError);
    expect(() => lineAndColumn('ab', -1)).toThrow(RangeError);
    expect(() => lineAndColumn('ab', 1.5)).toThrow(RangeError);
  });
});

describe('isValidImageSrc', () => {
  it('accepts https URLs', () => {
    for (const src of [
      'https://example.com',
      'https://example.com/a/b.png?x=1&y=2#top',
      'https://[::1]:8080/x',
      'https://a',
    ]) {
      expect(isValidImageSrc(src), src).toBe(true);
    }
  });

  it('rejects other schemes, user info, empty authorities, spaces, backslashes, and non-ASCII', () => {
    for (const src of [
      '',
      'http://example.com',
      'HTTPS://example.com',
      'javascript:alert(1)',
      'https://',
      'https:///path',
      'https://user@example.com',
      'https://exa mple.com',
      'https://example.com/a b',
      'https://example.com/a\\b',
      'https://example.com\\a',
      'https://example.com/\u00e9',
      'https://ex\u00e9ample.com',
    ]) {
      expect(isValidImageSrc(src), src).toBe(false);
    }
  });

  it('limits an https URL to 2,000 characters', () => {
    expect(isValidImageSrc(`https://${'a'.repeat(1992)}`)).toBe(true);
    expect(isValidImageSrc(`https://${'a'.repeat(1993)}`)).toBe(false);
  });

  it('accepts base64 data URIs of the four image types', () => {
    for (const type of ['png', 'jpeg', 'gif', 'webp']) {
      expect(isValidImageSrc(`data:image/${type};base64,AAAA`), type).toBe(true);
    }
    expect(isValidImageSrc('data:image/png;base64,QUJD')).toBe(true);
    expect(isValidImageSrc('data:image/png;base64,QUI=')).toBe(true);
    expect(isValidImageSrc('data:image/png;base64,QQ==')).toBe(true);
    expect(isValidImageSrc('data:image/png;base64,a+/9AAAA')).toBe(true);
  });

  it('rejects svg, other media, empty or malformed payloads', () => {
    for (const src of [
      'data:image/svg+xml;base64,AAAA',
      'data:image/bmp;base64,AAAA',
      'data:text/html;base64,AAAA',
      'data:image/png;base64,',
      'data:image/png;base64,AAA',
      'data:image/png;base64,AA=A',
      'data:image/png;base64,A===',
      'data:image/png;base64,====',
      'data:image/png;base64,AA A',
      'data:image/png;base64,AAA-',
      'data:image/png,AAAA',
      'data:IMAGE/png;base64,AAAA',
    ]) {
      expect(isValidImageSrc(src), src).toBe(false);
    }
  });

  it('limits a data URI to 1,000,000 characters', () => {
    const prefix = 'data:image/png;base64,';
    expect(isValidImageSrc(prefix + 'A'.repeat(999_976))).toBe(true);
    expect(isValidImageSrc(prefix + 'A'.repeat(999_980))).toBe(false);
  });

  it('rejects values that are not strings', () => {
    expect(isValidImageSrc(undefined)).toBe(false);
    expect(isValidImageSrc(5)).toBe(false);
    expect(isValidImageSrc(null)).toBe(false);
  });
});

describe('isValidUtcTimestamp', () => {
  it('accepts UTC timestamps with seconds, with or without a fraction', () => {
    for (const value of [
      '2026-12-01T09:00:00Z',
      '2026-12-01T09:00:00.5Z',
      '2026-12-01T09:00:00.123456Z',
      '2026-12-01T23:59:59Z',
      '2026-12-01T00:00:00Z',
      '2024-02-29T12:00:00Z',
      '2000-02-29T00:00:00Z',
      '0000-02-29T00:00:00Z',
    ]) {
      expect(isValidUtcTimestamp(value), value).toBe(true);
    }
  });

  it('rejects impossible dates', () => {
    for (const value of [
      '2027-02-29T00:00:00Z',
      '1900-02-29T00:00:00Z',
      '0100-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-00-10T00:00:00Z',
      '2026-01-00T00:00:00Z',
    ]) {
      expect(isValidUtcTimestamp(value), value).toBe(false);
    }
  });

  it('rejects 24:00:00 and out-of-range minutes and seconds', () => {
    for (const value of [
      '2026-12-01T24:00:00Z',
      '2026-12-01T24:00:01Z',
      '2026-12-01T09:60:00Z',
      '2026-12-01T09:00:60Z',
    ]) {
      expect(isValidUtcTimestamp(value), value).toBe(false);
    }
  });

  it('rejects offsets, lowercase letters, missing parts, and other shapes', () => {
    for (const value of [
      '2026-12-01T09:00:00+00:00',
      '2026-12-01T09:00:00-05:00',
      '2026-12-01T09:00:00',
      '2026-12-01T09:00:00z',
      '2026-12-01t09:00:00Z',
      '2026-12-01T09:00Z',
      '2026-12-01',
      '2026-12-01 09:00:00Z',
      '2026-12-01T09:00:00.Z',
      ' 2026-12-01T09:00:00Z',
      '2026-12-01T09:00:00Z\n',
      '',
    ]) {
      expect(isValidUtcTimestamp(value), value).toBe(false);
    }
  });

  it('rejects values that are not strings', () => {
    expect(isValidUtcTimestamp(undefined)).toBe(false);
    expect(isValidUtcTimestamp(0)).toBe(false);
    expect(isValidUtcTimestamp(new Date(0))).toBe(false);
  });
});
