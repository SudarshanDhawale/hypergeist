import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbCandidate, arbStack } from '../../test-support/arbitraries.ts';
import { arbJsonText } from '../../test-support/json-text-arbitraries.ts';
import { canonicalKeyViolations } from '../../test-support/oracles.ts';
import { assertProperty } from '../../test-support/seed.ts';
import { parseStack } from './parse.ts';
import { serializeStack } from './serialize.ts';
import { validateStack } from './validate.ts';

const MAX_CANONICAL_BYTES = 2_097_152;

/** Small deterministic PRNG (mulberry32), so a shuffle is reproducible from its integer seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deep copy in which every object's keys are inserted in a random order. Arrays keep order. */
function shuffleKeys(value: unknown, random: () => number): unknown {
  if (Array.isArray(value)) {
    return value.map((element: unknown) => shuffleKeys(element, random));
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    for (let index = entries.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      const swap = entries[index];
      const picked = entries[other];
      if (swap !== undefined && picked !== undefined) {
        entries[index] = picked;
        entries[other] = swap;
      }
    }
    const copy: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      copy[key] = shuffleKeys(child, random);
    }
    return copy;
  }
  return value;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe('canonical serialization property', () => {
  // Feature: stack-format-and-validator, Property 18: Canonical serialization
  // **Validates: Requirements 9.1, 9.5, 9.6**
  it('writes the same canonical text for key-shuffled copies, in table key order, two-space indented, with one trailing newline', () => {
    assertProperty(
      fc.property(arbStack, fc.integer(), (stack, shuffleSeed) => {
        const original = serializeStack(stack);
        expect(original.ok).toBe(true);
        if (!original.ok) {
          return;
        }
        const text = original.value;

        // Key-shuffled deep copies give the same text.
        const shuffled = serializeStack(shuffleKeys(stack, makeRandom(shuffleSeed)));
        expect(shuffled).toEqual({ ok: true, value: text });

        // Exactly one trailing newline, no carriage returns.
        expect(text.endsWith('\n')).toBe(true);
        expect(text.endsWith('\n\n')).toBe(false);
        expect(text.includes('\r')).toBe(false);

        // Two-space indentation: the text is exactly JSON.stringify(..., null, 2) plus the newline,
        // and every line is indented with spaces only, in multiples of two.
        const parsed: unknown = JSON.parse(text);
        expect(text).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
        for (const line of text.slice(0, -1).split('\n')) {
          const indent = /^ */.exec(line)?.[0].length ?? 0;
          expect(indent % 2).toBe(0);
          expect(line.charAt(indent)).not.toBe('\t');
        }

        // Keys follow the oracle's table order.
        expect(canonicalKeyViolations(parsed)).toEqual([]);

        // Array order and content are kept.
        expect(parsed).toEqual(JSON.parse(JSON.stringify(stack)));

        // At most 2,097,152 bytes.
        expect(utf8ByteLength(text)).toBeLessThanOrEqual(MAX_CANONICAL_BYTES);
      }),
    );
  });
});

/** The code points of a string, one number per code point (a lone surrogate counts as one). */
function codePointsOf(text: string): number[] {
  return Array.from(text, (character) => character.codePointAt(0) ?? -1);
}

/** Every string in a JSON value, in document order, keys before values. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const element of value) {
      collectStrings(element, out);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectStrings(child, out);
    }
  }
  return out;
}

/** Writes every non-ASCII UTF-16 code unit as a `\uXXXX` escape. Non-ASCII only occurs inside strings. */
function escapeNonAscii(text: string): string {
  return text.replace(
    /[\u0080-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

const INDENTS: ReadonlyArray<number | string> = [0, 1, 2, 3, 4, 8, '\t', '  ', ' \n ', '\r\n\t'];
const OUTER_WHITESPACE = ['', ' ', '\n', '\r\n\t '] as const;

/** One of the many valid JSON formattings of a value: indentation, outer whitespace, optional escapes. */
const arbFormatting = fc.record({
  indent: fc.constantFrom(...INDENTS),
  before: fc.constantFrom(...OUTER_WHITESPACE),
  after: fc.constantFrom(...OUTER_WHITESPACE),
  escape: fc.boolean(),
});

/** Text units that are hard on a serializer: quotes, backslashes, line breaks, astral characters, lone surrogates. */
const arbHostileText = fc
  .array(
    fc.constantFrom(
      'a',
      'é',
      '😀',
      '"',
      '\\',
      '\n',
      '\r',
      '\t',
      '/',
      '\u2028',
      '\ud800',
      '\udbff',
      '\udc00',
      '\udfff',
    ),
    { minLength: 1, maxLength: 30 },
  )
  .map((units) => units.join(''));

/** A deep copy of a stack whose Stack name and first Card name are replaced by the given text. */
function withHostileNames(stack: unknown, text: string): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(stack));
  if (typeof copy === 'object' && copy !== null) {
    const record = copy as Record<string, unknown>;
    record['name'] = text;
    const cards = record['cards'];
    if (Array.isArray(cards)) {
      const first: unknown = cards[0];
      if (typeof first === 'object' && first !== null) {
        (first as Record<string, unknown>)['name'] = text;
      }
    }
  }
  return copy;
}

describe('serialization round trip property', () => {
  // Feature: stack-format-and-validator, Property 19: Serialization round trips
  // **Validates: Requirements 8.7, 9.7, 9.8, 9.9, 10.1, 12.4**
  it('parse of serialize gives the input back, serialize of parse gives the same text, and any valid formatting gives the canonical text', () => {
    assertProperty(
      fc.property(arbStack, fc.integer(), arbFormatting, (stack, shuffleSeed, formatting) => {
        const serialized = serializeStack(stack);
        expect(serialized.ok).toBe(true);
        if (!serialized.ok) {
          return;
        }
        const canonical = serialized.value;

        // parse of serialize deep-equals the input, with identical code points in every string.
        const parsed = parseStack(canonical);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
          return;
        }
        expect(parsed.value).toStrictEqual(stack);
        const before = collectStrings(stack).map(codePointsOf);
        const after = collectStrings(parsed.value).map(codePointsOf);
        expect(after).toEqual(before);

        // serialize of parse of canonical text is the identical text.
        expect(serializeStack(parsed.value)).toEqual({ ok: true, value: canonical });

        // Any valid JSON formatting of the stack (key order, indentation, whitespace, \u escapes)
        // parses and then serializes to the canonical text.
        const body = JSON.stringify(
          shuffleKeys(stack, makeRandom(shuffleSeed)),
          null,
          formatting.indent,
        );
        const formatted = `${formatting.before}${formatting.escape ? escapeNonAscii(body) : body}${formatting.after}`;
        const reparsed = parseStack(formatted);
        expect(reparsed.ok).toBe(true);
        if (!reparsed.ok) {
          return;
        }
        expect(serializeStack(reparsed.value)).toEqual({ ok: true, value: canonical });
      }),
    );
  });

  // Feature: stack-format-and-validator, Property 19: Serialization round trips
  // **Validates: Requirements 8.7, 9.7, 9.8, 9.9, 10.1, 12.4**
  it('keeps the code point sequence of hostile text (quotes, backslashes, line breaks, astral characters, lone surrogates)', () => {
    assertProperty(
      fc.property(arbStack, arbHostileText, (stack, text) => {
        const candidate = withHostileNames(stack, text);
        const serialized = serializeStack(candidate);
        expect(serialized.ok).toBe(true);
        if (!serialized.ok) {
          return;
        }
        const parsed = parseStack(serialized.value);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
          return;
        }
        expect(parsed.value.name).toBe(text);
        expect(codePointsOf(parsed.value.name)).toEqual(codePointsOf(text));
        expect(parsed.value.cards[0]?.name).toBe(text);
        expect(parsed.value).toStrictEqual(candidate);
        expect(serializeStack(parsed.value)).toEqual({ ok: true, value: serialized.value });
      }),
    );
  });
});

/** Anything the validator may receive, plus near-valid and arbitrary JSON text. */
const arbAgreementCandidate: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 4, arbitrary: arbCandidate },
  { weight: 1, arbitrary: arbJsonText },
);

describe('parser and serializer agreement property', () => {
  // Feature: stack-format-and-validator, Property 20: The parser and serializer agree with the validator
  // **Validates: Requirements 9.2, 9.10, 9.11**
  it('gives parseStack and serializeStack the same verdict, errors and truncated flag as validateStack', () => {
    assertProperty(
      fc.property(arbAgreementCandidate, (candidate) => {
        const validation = validateStack(candidate);

        // parseStack agrees with the validator.
        const parsed = parseStack(candidate);
        expect(parsed.ok).toBe(validation.valid);
        if (!parsed.ok) {
          expect(parsed.errors).toEqual(validation.errors);
          expect(parsed.truncated).toBe(validation.truncated);
        }

        if (typeof candidate === 'string') {
          // A string is not a Stack, so it is never parsed: one WRONG_TYPE at "".
          const serialized = serializeStack(candidate);
          expect(serialized.ok).toBe(false);
          if (!serialized.ok) {
            expect(serialized.errors).toHaveLength(1);
            expect(serialized.errors[0]?.code).toBe('WRONG_TYPE');
            expect(serialized.errors[0]?.path).toBe('');
            expect(serialized.truncated).toBe(false);
          }
        } else if (typeof candidate === 'object' && candidate !== null) {
          // An object candidate: the validator's errors and no text when it is rejected.
          const serialized = serializeStack(candidate);
          expect(serialized.ok).toBe(validation.valid);
          if (serialized.ok) {
            expect(typeof serialized.value).toBe('string');
          } else {
            expect(serialized.errors).toEqual(validation.errors);
            expect(serialized.truncated).toBe(validation.truncated);
            expect('value' in serialized).toBe(false);
          }
        }
      }),
    );
  });
});
