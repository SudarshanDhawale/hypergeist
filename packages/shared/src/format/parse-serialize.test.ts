import { describe, expect, it } from 'vitest';
import { LIMITS } from './limits.ts';
import { parseStack } from './parse.ts';
import { serializeStack } from './serialize.ts';
import { utf8ByteLength } from './text.ts';
import { validateStack } from './validate.ts';

// Example tests for the Stack_Parser and Stack_Serializer: canonical form, the 2 MiB limit,
// round trips of hostile text, and the string handling of `serializeStack`.

type Raw = Record<string, unknown>;

function field(id: string, overrides: Raw = {}): Raw {
  return {
    id,
    type: 'field',
    name: '',
    x: 0,
    y: 0,
    width: 100,
    height: 24,
    value: '',
    placeholder: '',
    multiline: false,
    readOnly: false,
    ...overrides,
  };
}

function card(id: string, overrides: Raw = {}): Raw {
  return { id, name: id, objects: [], links: [], onOpen: [], ...overrides };
}

function stack(cards: Raw[], overrides: Raw = {}): Raw {
  return {
    formatVersion: 1,
    id: 'demo',
    name: 'Demo',
    cardWidth: 400,
    cardHeight: 300,
    startCardId: 'c0',
    cards,
    ...overrides,
  };
}

function expectText(result: ReturnType<typeof serializeStack>): string {
  if (!result.ok) {
    throw new Error(`serializeStack failed: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function codePoints(text: string): number[] {
  return Array.from(text, (char) => char.codePointAt(0) ?? -1);
}

describe('serializeStack: canonical form', () => {
  it('writes two-space indentation, keys in table order, and one trailing newline', () => {
    // Keys are given in a scrambled order on purpose.
    const candidate = {
      cards: [{ onOpen: [], links: [], objects: [], name: 'One', id: 'c0' }],
      startCardId: 'c0',
      cardHeight: 300,
      cardWidth: 400,
      name: 'Tiny',
      id: 'tiny',
      formatVersion: 1,
    };
    const text = expectText(serializeStack(candidate));
    expect(text).toBe(
      [
        '{',
        '  "formatVersion": 1,',
        '  "id": "tiny",',
        '  "name": "Tiny",',
        '  "cardWidth": 400,',
        '  "cardHeight": 300,',
        '  "startCardId": "c0",',
        '  "cards": [',
        '    {',
        '      "id": "c0",',
        '      "name": "One",',
        '      "objects": [],',
        '      "links": [],',
        '      "onOpen": []',
        '    }',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('omits an absent optional key and writes remixedFrom right after startCardId when present', () => {
    const without = expectText(serializeStack(stack([card('c0')])));
    expect(without).not.toContain('remixedFrom');

    const withKey = expectText(serializeStack(stack([card('c0')], { remixedFrom: 'origin' })));
    const lines = withKey.split('\n');
    const startIndex = lines.indexOf('  "startCardId": "c0",');
    expect(startIndex).toBeGreaterThan(-1);
    expect(lines[startIndex + 1]).toBe('  "remixedFrom": "origin",');
  });

  it('keeps array order', () => {
    const text = expectText(serializeStack(stack([card('c2'), card('c0'), card('c1')])));
    // `"startCardId": "c0"` also contains "c0", so look for the Card id lines.
    const at = (id: string) => text.indexOf(`"id": "${id}"`);
    expect(at('c2')).toBeGreaterThan(-1);
    expect(at('c2')).toBeLessThan(at('c0'));
    expect(at('c0')).toBeLessThan(at('c1'));
  });

  it('writes -0 as 0, and validates it', () => {
    const candidate = stack([card('c0', { objects: [field('f0', { x: -0 })] })]);
    expect(validateStack(candidate)).toEqual({ valid: true, errors: [], truncated: false });
    const text = expectText(serializeStack(candidate));
    expect(text).toContain('"x": 0,');
    expect(text).not.toContain('-0');
  });
});

describe('parseStack and serializeStack: hostile text round trips', () => {
  const hostile =
    'astral \u{1F600}\u{10FFFF} quote " backslash \\ lf \n crlf \r\n tab \t lone \uD800 and \uDC00 end';

  it('keeps the exact code point sequence of every string', () => {
    const original = stack([
      card('c0', {
        objects: [field('f0', { name: hostile, value: hostile, placeholder: hostile })],
      }),
    ]);
    const text = expectText(serializeStack(original));

    const parsed = parseStack(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const object = parsed.value.cards[0]?.objects[0];
    expect(object?.type).toBe('field');
    if (object?.type !== 'field') return;
    expect(codePoints(object.value)).toEqual(codePoints(hostile));
    expect(codePoints(object.name)).toEqual(codePoints(hostile));
    expect(codePoints(object.placeholder)).toEqual(codePoints(hostile));
    expect(parsed.value).toEqual(original);

    // The written text is stable: serialize of parse of the canonical text is identical.
    expect(expectText(serializeStack(parsed.value))).toBe(text);
  });
});

describe('document size limit', () => {
  const LIMIT = LIMITS.maxDocumentBytes;
  const CARD_COUNT = 200;
  const FIELDS_PER_CARD = 2;

  /** A stack whose Field values hold `padding` ASCII characters in total, spread over many Cards. */
  function paddedStack(padding: number): Raw {
    let remaining = padding;
    const cards: Raw[] = [];
    for (let c = 0; c < CARD_COUNT; c++) {
      const objects: Raw[] = [];
      for (let f = 0; f < FIELDS_PER_CARD; f++) {
        const length = Math.min(LIMITS.fieldValue.max, remaining);
        remaining -= length;
        objects.push(field(`f${c}-${f}`, { value: 'a'.repeat(length) }));
      }
      cards.push(card(`c${c}`, { objects }));
    }
    if (remaining !== 0) throw new Error('padding does not fit in the test stack');
    return stack(cards);
  }

  function canonicalBytes(candidate: Raw): number {
    return utf8ByteLength(expectText(serializeStack(candidate)));
  }

  /** The stack whose canonical text is exactly `target` bytes (ASCII, so one character per byte). */
  function stackOfExactSize(target: number): Raw {
    const base = canonicalBytes(paddedStack(0));
    const candidate = paddedStack(target - base);
    expect(canonicalBytes(candidate)).toBe(target);
    return candidate;
  }

  it('accepts a stack whose canonical text is exactly 2,097,152 bytes', () => {
    const candidate = stackOfExactSize(LIMIT);
    expect(validateStack(candidate)).toEqual({ valid: true, errors: [], truncated: false });

    const parsed = parseStack(candidate);
    expect(parsed.ok).toBe(true);

    const serialized = serializeStack(candidate);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(utf8ByteLength(serialized.value)).toBe(LIMIT);

    // The same stack as text parses too.
    expect(parseStack(serialized.value).ok).toBe(true);
    expect(validateStack(serialized.value).valid).toBe(true);
  });

  it('gives one LIMIT_EXCEEDED at the root when the canonical text is one byte longer', () => {
    // One more padding character than the exact-fit stack; every Field value stays within its own limit.
    const base = canonicalBytes(paddedStack(0));
    const candidate = paddedStack(LIMIT - base + 1);

    const validated = validateStack(candidate);
    expect(validated.valid).toBe(false);
    expect(validated.errors.map((error) => [error.code, error.path])).toEqual([
      ['LIMIT_EXCEEDED', ''],
    ]);

    const parsed = parseStack(candidate);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.map((error) => [error.code, error.path])).toEqual([
        ['LIMIT_EXCEEDED', ''],
      ]);
    }

    const serialized = serializeStack(candidate);
    expect(serialized.ok).toBe(false);
    if (!serialized.ok) {
      expect(serialized.errors.map((error) => [error.code, error.path])).toEqual([
        ['LIMIT_EXCEEDED', ''],
      ]);
    }
  });

  it('gives one LIMIT_EXCEEDED from parseStack for text of 2,097,153 bytes, without parsing it', () => {
    // Whitespace only: if the text were parsed, the error would be INVALID_JSON.
    const text = ' '.repeat(LIMIT + 1);
    expect(utf8ByteLength(text)).toBe(LIMIT + 1);
    const parsed = parseStack(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.map((error) => [error.code, error.path])).toEqual([
        ['LIMIT_EXCEEDED', ''],
      ]);
    }
  });
});

describe('serializeStack: a string is not a Stack', () => {
  it('gives one WRONG_TYPE at the root for "{}" and never parses it', () => {
    const result = serializeStack('{}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => [error.code, error.path])).toEqual([['WRONG_TYPE', '']]);
    }
  });

  it('gives one WRONG_TYPE at the root even for the canonical text of a valid stack', () => {
    const text = expectText(serializeStack(stack([card('c0')])));
    const result = serializeStack(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => [error.code, error.path])).toEqual([['WRONG_TYPE', '']]);
    }
  });
});
