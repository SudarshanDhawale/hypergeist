import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ENTITY_ID_PATTERN,
  SUPPORTED_ACTION_TYPES,
  SUPPORTED_OBJECT_TYPES,
  UNSUPPORTED_ACTION_TYPES,
  UNSUPPORTED_OBJECT_TYPES,
} from './limits.ts';
import { ABSENT, mapZodIssues } from './zod-issues.ts';
import type { RawError } from './zod-issues.ts';

// Tiny local schemas that mimic the shapes of the real format, so the mapper
// is fed real Zod 4 issues without depending on schemas.ts.
const Id = z.string().regex(ENTITY_ID_PATTERN);
const Button = z.strictObject({
  type: z.literal('button'),
  id: Id,
  label: z.string().min(1),
  x: z.int().min(0).max(100),
});
const Field = z.strictObject({ type: z.literal('field'), id: Id });
const ShowMessage = z.strictObject({ type: z.literal('show_message'), text: z.string() });
const GoToCard = z.strictObject({ type: z.literal('go_to_card'), cardId: Id });
const Card = z.strictObject({
  id: Id,
  name: z.string().check((ctx) => {
    if ([...ctx.value].length > 5) {
      ctx.issues.push({
        code: 'too_big',
        origin: 'string',
        maximum: 5,
        inclusive: true,
        input: ctx.value,
      });
    }
  }),
  objects: z.array(z.discriminatedUnion('type', [Button, Field])).max(2),
  onOpen: z.array(z.discriminatedUnion('type', [ShowMessage, GoToCard])).max(3),
});
const Root = z.strictObject({
  formatVersion: z.literal(1),
  cards: z.array(Card).min(1).max(2),
  flag: z.boolean().optional(),
});

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'c1', name: 'Home', objects: [], onOpen: [], ...overrides };
}

function root(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { formatVersion: 1, cards: [card()], ...overrides };
}

function map(candidate: unknown): RawError[] {
  const result = Root.safeParse(candidate);
  if (result.success) return [];
  return mapZodIssues(result.error.issues, candidate);
}

function only(candidate: unknown): RawError {
  const errors = map(candidate);
  expect(errors).toHaveLength(1);
  return errors[0] as RawError;
}

describe('mapZodIssues', () => {
  it('returns no errors for a valid candidate', () => {
    expect(map(root())).toEqual([]);
  });

  describe('unknown properties', () => {
    it('reports one UNKNOWN_PROPERTY per key at parent/key', () => {
      const errors = map(root({ extra: 1, other: 'x' }));
      expect(errors.map((e) => [e.code, e.segments, e.actual])).toEqual([
        ['UNKNOWN_PROPERTY', ['extra'], 1],
        ['UNKNOWN_PROPERTY', ['other'], 'x'],
      ]);
    });

    it('reports an unknown key inside a nested object', () => {
      const e = only(root({ cards: [card({ zzz: true })] }));
      expect(e.code).toBe('UNKNOWN_PROPERTY');
      expect(e.segments).toEqual(['cards', 0, 'zzz']);
    });

    it('keeps __proto__ as a plain key name', () => {
      const candidate = JSON.parse(
        '{"formatVersion":1,"cards":[{"id":"c1","name":"a","objects":[],"onOpen":[]}],"__proto__":1}',
      );
      const e = only(candidate);
      expect(e.segments).toEqual(['__proto__']);
      expect(e.actual).toBe(1);
    });
  });

  describe('missing properties', () => {
    it('reports MISSING_PROPERTY at the parent with an absent actual', () => {
      const e = only({ cards: [card()] });
      expect(e.code).toBe('MISSING_PROPERTY');
      expect(e.segments).toEqual([]);
      expect(e.actual).toBe(ABSENT);
      expect(e.message).toContain('"formatVersion"');
    });

    it('reports a missing required string inside an array element', () => {
      const e = only(root({ cards: [{ id: 'c1', objects: [], onOpen: [] }] }));
      expect(e.code).toBe('MISSING_PROPERTY');
      expect(e.segments).toEqual(['cards', 0]);
      expect(e.message).toContain('"name"');
    });

    it('treats a property set to undefined as present, so WRONG_TYPE', () => {
      const e = only(root({ cards: [card({ name: undefined })] }));
      expect(e.code).toBe('WRONG_TYPE');
      expect(e.segments).toEqual(['cards', 0, 'name']);
    });
  });

  describe('type and integer errors', () => {
    it('reports WRONG_TYPE at the property', () => {
      const e = only(root({ cards: [card({ name: 5 })] }));
      expect(e.code).toBe('WRONG_TYPE');
      expect(e.segments).toEqual(['cards', 0, 'name']);
      expect(e.actual).toBe(5);
      expect(e.message).toBe('Expected a string, received a number.');
    });

    it('reports WRONG_TYPE for a non-object array element', () => {
      const e = only(root({ cards: [null] }));
      expect(e.code).toBe('WRONG_TYPE');
      expect(e.segments).toEqual(['cards', 0]);
      expect(e.expected).toBe('an object');
    });

    it('reports WRONG_TYPE for a non-number where an integer is required', () => {
      const e = only(
        root({ cards: [card({ objects: [{ type: 'button', id: 'b', label: 'x', x: '3' }] })] }),
      );
      expect(e.code).toBe('WRONG_TYPE');
      expect(e.segments).toEqual(['cards', 0, 'objects', 0, 'x']);
    });

    it('reports INVALID_VALUE for a non-integer number', () => {
      const e = only(
        root({ cards: [card({ objects: [{ type: 'button', id: 'b', label: 'x', x: 2.5 }] })] }),
      );
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.expected).toBe('an integer');
      expect(e.actual).toBe(2.5);
      expect(e.hint).toContain('3');
    });

    it('reports WRONG_TYPE for a literal given a different JSON type', () => {
      const e = only(root({ formatVersion: '1' }));
      expect(e.code).toBe('WRONG_TYPE');
      expect(e.segments).toEqual(['formatVersion']);
    });

    it('reports INVALID_VALUE for a literal given the same type with another value', () => {
      const e = only(root({ formatVersion: 2 }));
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.expected).toBe('the value 1');
    });
  });

  describe('limits and minimums', () => {
    it('reports LIMIT_EXCEEDED for a long array and counts the excess', () => {
      const e = only(
        root({
          cards: [
            card({ onOpen: [1, 2, 3, 4, 5].map(() => ({ type: 'show_message', text: 'x' })) }),
          ],
        }),
      );
      expect(e.code).toBe('LIMIT_EXCEEDED');
      expect(e.segments).toEqual(['cards', 0, 'onOpen']);
      expect(e.hint).toBe('Remove 2 items from this array.');
      expect(e.expected).toBe('an array of at most 3 items');
    });

    it('reports LIMIT_EXCEEDED for text, counting code points', () => {
      const e = only(root({ cards: [card({ name: '😀😀😀😀😀😀' })] }));
      expect(e.code).toBe('LIMIT_EXCEEDED');
      expect(e.segments).toEqual(['cards', 0, 'name']);
      expect(e.message).toContain('6 characters');
      expect(e.hint).toBe('Remove 1 character from this text.');
    });

    it('reports INVALID_VALUE for a number over its maximum', () => {
      const e = only(
        root({ cards: [card({ objects: [{ type: 'button', id: 'b', label: 'x', x: 101 }] })] }),
      );
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.expected).toBe('a number of at most 100');
      expect(e.hint).toBe('Use a value of 100 or less.');
    });

    it('reports INVALID_VALUE for a number under its minimum', () => {
      const e = only(
        root({ cards: [card({ objects: [{ type: 'button', id: 'b', label: 'x', x: -1 }] })] }),
      );
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.hint).toBe('Use a value of 0 or more.');
    });

    it('reports INVALID_VALUE for an empty string under its minimum', () => {
      const e = only(
        root({ cards: [card({ objects: [{ type: 'button', id: 'b', label: '', x: 1 }] })] }),
      );
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.segments).toEqual(['cards', 0, 'objects', 0, 'label']);
      expect(e.hint).toBe('Add 1 character to this text.');
    });

    it('reports INVALID_VALUE for an empty array under its minimum', () => {
      const e = only(root({ cards: [] }));
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.expected).toBe('an array of at least 1 item');
      expect(e.hint).toBe('Add 1 item to this array.');
    });

    it('reports INVALID_VALUE for a failed pattern with an id-specific hint', () => {
      const e = only(root({ cards: [card({ id: 'Bad Id' })] }));
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.segments).toEqual(['cards', 0, 'id']);
      expect(e.expected).toContain('lowercase');
      expect(e.actual).toBe('Bad Id');
    });

    it('reports INVALID_VALUE for a failed generic regex', () => {
      const schema = z.strictObject({ code: z.string().regex(/^a+$/) });
      const candidate = { code: 'b' };
      const result = schema.safeParse(candidate);
      if (result.success) throw new Error('expected a failure');
      const [e] = mapZodIssues(result.error.issues, candidate);
      expect(e?.code).toBe('INVALID_VALUE');
      expect(e?.expected).toContain('/^a+$/');
    });
  });

  describe('discriminator handling', () => {
    const objectAt = (object: unknown) => root({ cards: [card({ objects: [object] })] });
    const actionAt = (action: unknown) => root({ cards: [card({ onOpen: [action] })] });

    it('reports an absent type as MISSING_PROPERTY at the Object', () => {
      const e = only(objectAt({ id: 'b' }));
      expect(e.code).toBe('MISSING_PROPERTY');
      expect(e.segments).toEqual(['cards', 0, 'objects', 0]);
      expect(e.actual).toBe(ABSENT);
      expect(e.message).toContain('"type"');
    });

    it('reports an absent type as MISSING_PROPERTY at the Action', () => {
      const e = only(actionAt({ text: 'x' }));
      expect(e.code).toBe('MISSING_PROPERTY');
      expect(e.segments).toEqual(['cards', 0, 'onOpen', 0]);
    });

    it('reports a non-string type as WRONG_TYPE at .../type', () => {
      for (const value of [5, null, true, ['button'], { a: 1 }]) {
        const e = only(objectAt({ type: value, id: 'b' }));
        expect(e.code).toBe('WRONG_TYPE');
        expect(e.segments).toEqual(['cards', 0, 'objects', 0, 'type']);
        expect(e.actual).toEqual(value);
      }
    });

    it.each(UNSUPPORTED_OBJECT_TYPES)('rejects the unsupported object type %s', (type) => {
      const e = only(objectAt({ type, id: 'b', extra: 1 }));
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.segments).toEqual(['cards', 0, 'objects', 0, 'type']);
      expect(e.message).toBe(`The object type "${type}" is not supported in this release.`);
      expect(e.hint).toBe(`Use one of: ${SUPPORTED_OBJECT_TYPES.join(', ')}.`);
    });

    it.each(UNSUPPORTED_ACTION_TYPES)('rejects the unsupported action type %s', (type) => {
      const e = only(actionAt({ type, id: 'a' }));
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.segments).toEqual(['cards', 0, 'onOpen', 0, 'type']);
      expect(e.message).toBe(`The action type "${type}" is not supported in this release.`);
      expect(e.hint).toBe(`Use one of: ${SUPPORTED_ACTION_TYPES.join(', ')}.`);
    });

    it('rejects an unknown object type with the "is unknown" message', () => {
      const e = only(objectAt({ type: 'widget' }));
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.message).toBe('The object type "widget" is unknown.');
      expect(e.hint).toBe(`Use one of: ${SUPPORTED_OBJECT_TYPES.join(', ')}.`);
    });

    it('rejects an unknown action type, and an action type used on an Object', () => {
      expect(only(actionAt({ type: 'dance' })).message).toBe('The action type "dance" is unknown.');
      expect(only(objectAt({ type: 'remove_item' })).message).toBe(
        'The object type "remove_item" is unknown.',
      );
    });

    it('cuts a very long type name in the message', () => {
      const e = only(objectAt({ type: 'x'.repeat(500) }));
      expect(e.message.length).toBeLessThan(120);
      expect(e.actual).toBe('x'.repeat(500));
    });
  });

  describe('fallback and shape', () => {
    it('maps any other issue to INVALID_VALUE with the Zod message', () => {
      const schema = z.strictObject({ n: z.number().multipleOf(5) });
      const candidate = { n: 7 };
      const result = schema.safeParse(candidate);
      if (result.success) throw new Error('expected a failure');
      const [e] = mapZodIssues(result.error.issues, candidate);
      expect(e?.code).toBe('INVALID_VALUE');
      expect(e?.message).toBe(result.error.issues[0]?.message);
      expect(e?.actual).toBe(7);
    });

    it('gives every error a non-empty message, expected, and hint, and array segments', () => {
      const candidates: unknown[] = [
        root({ extra: 1 }),
        { cards: [card()] },
        root({ formatVersion: 'x' }),
        root({ formatVersion: 3 }),
        root({ cards: [] }),
        root({ cards: [card(), card(), card()] }),
        root({
          cards: [
            card({
              id: 'NO',
              name: 7,
              onOpen: [{ type: 'fetch_news' }, { type: 9 }, {}, { type: 'q' }],
            }),
          ],
        }),
        root({
          cards: [
            card({ objects: [{ type: 'button', id: 'b', label: '', x: 1.5 }, { type: 'image' }] }),
          ],
        }),
        root({
          cards: [
            card({
              objects: [
                { type: 'button', id: 'b', label: 'x', x: 1000 },
                { type: 'field', id: 'f', q: 1 },
              ],
            }),
          ],
        }),
      ];
      for (const candidate of candidates) {
        const errors = map(candidate);
        expect(errors.length).toBeGreaterThan(0);
        for (const e of errors) {
          expect(e.message.length).toBeGreaterThan(0);
          expect(e.expected.length).toBeGreaterThan(0);
          expect(e.hint.length).toBeGreaterThan(0);
          expect(Array.isArray(e.segments)).toBe(true);
        }
      }
    });

    it('does not mutate the candidate and is deterministic', () => {
      const candidate = root({ extra: 1, cards: [card({ onOpen: [{ type: 'image' }] })] });
      const before = JSON.stringify(candidate);
      const first = map(candidate);
      expect(JSON.stringify(candidate)).toBe(before);
      expect(map(candidate)).toEqual(first);
    });

    it('reports no other error for an Object or Action with a bad type (Requirement 5.4)', () => {
      const errors = map(
        root({ cards: [card({ objects: [{ type: 'image', id: 'BAD ID', extra: 1 }] })] }),
      );
      expect(errors).toHaveLength(1);
    });
  });
});
