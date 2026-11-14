import { describe, expect, it } from 'vitest';
import {
  codePointLength,
  escapePointerSegment,
  toJsonPointer,
  unescapePointerSegment,
  utf8ByteLength,
} from './text.ts';

describe('utf8ByteLength', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['\u007f', 1],
    ['\u0080', 2],
    ['é', 2],
    ['\u07ff', 2],
    ['\u0800', 3],
    ['€', 3],
    ['\uffff', 3],
    ['😀', 4],
    ['a😀é€', 1 + 4 + 2 + 3],
    ['\ud800', 3],
    ['\udc00', 3],
    ['\ud800a', 4],
  ])('counts %j as %i bytes', (text, bytes) => {
    expect(utf8ByteLength(text)).toBe(bytes);
  });

  it('agrees with Buffer for well-formed text', () => {
    const sample = 'Hello, мир! 你好 😀 \u0000 end';
    expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
  });
});

describe('codePointLength', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['é€', 2],
    ['😀', 1],
    ['a😀b😀', 4],
    ['\ud800', 1],
    ['\udc00\ud800', 2],
  ])('counts %j as %i code points', (text, length) => {
    expect(codePointLength(text)).toBe(length);
  });
});

describe('JSON Pointer helpers', () => {
  it('escapes ~ as ~0 and / as ~1', () => {
    expect(escapePointerSegment('a~b/c')).toBe('a~0b~1c');
    expect(escapePointerSegment('~1')).toBe('~01');
    expect(escapePointerSegment('plain')).toBe('plain');
  });

  it('unescapes ~1 before ~0', () => {
    expect(unescapePointerSegment('a~0b~1c')).toBe('a~b/c');
    expect(unescapePointerSegment('~01')).toBe('~1');
  });

  it('round-trips awkward segments', () => {
    for (const segment of ['', '~', '/', '~0', '~1', '~/~', 'a/b~c']) {
      expect(unescapePointerSegment(escapePointerSegment(segment))).toBe(segment);
    }
  });

  it('builds pointers, with "" for the root', () => {
    expect(toJsonPointer([])).toBe('');
    expect(toJsonPointer(['cards', 0, 'objects', 2, 'id'])).toBe('/cards/0/objects/2/id');
    expect(toJsonPointer(['a/b', '~'])).toBe('/a~1b/~0');
    expect(toJsonPointer([''])).toBe('/');
  });
});
