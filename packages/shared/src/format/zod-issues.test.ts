import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ACTION_TYPES, ENTITY_ID_PATTERN, IMAGE_SRC_PATTERN, OBJECT_TYPES } from './limits.ts';
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

  describe('image source pattern', () => {
    const Image = z.strictObject({
      id: z.string(),
      src: z.string().regex(IMAGE_SRC_PATTERN),
    });
    const IMAGE_HINT =
      'Use an https: URL, or a base64 data:image URI of type png, jpeg, gif, or webp.';

    function mapImage(candidate: unknown): RawError[] {
      const result = Image.safeParse(candidate);
      if (result.success) return [];
      return mapZodIssues(result.error.issues, candidate);
    }

    it.each([
      'http://example.com/a.png',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,AAAA',
      'data:image/png;base64,',
      'HTTPS://example.com',
    ])('reports INVALID_VALUE at src for %s and names the image id', (src) => {
      const errors = mapImage({ id: 'logo', src });
      expect(errors).toHaveLength(1);
      const e = errors[0] as RawError;
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.segments).toEqual(['src']);
      expect(e.actual).toBe(src);
      expect(e.message).toContain('"logo"');
      expect(e.hint).toBe(IMAGE_HINT);
      expect(e.expected.length).toBeGreaterThan(0);
    });

    it('still gives a message when the image has no usable id', () => {
      const result = z
        .strictObject({ src: z.string().regex(IMAGE_SRC_PATTERN) })
        .safeParse({ src: 'x' });
      if (result.success) throw new Error('expected a failure');
      const [e] = mapZodIssues(result.error.issues, { src: 'x' });
      expect(e?.code).toBe('INVALID_VALUE');
      expect(e?.message).toBe('The source of the image is not an allowed image source.');
    });

    it('keeps the generic regex text for patterns that are not in the table', () => {
      const result = z.strictObject({ code: z.string().regex(/^a+$/) }).safeParse({ code: 'b' });
      if (result.success) throw new Error('expected a failure');
      const [e] = mapZodIssues(result.error.issues, { code: 'b' });
      expect(e?.expected).toBe('a string matching the pattern /^a+$/');
    });

    it('maps a too_big string issue at src to LIMIT_EXCEEDED alongside the format error', () => {
      const long = `https://${'a'.repeat(2_000)}`;
      const ImageWithLimit = z.strictObject({
        id: z.string(),
        src: z.string().regex(IMAGE_SRC_PATTERN).max(5),
      });
      const result = ImageWithLimit.safeParse({ id: 'logo', src: `${long} ` });
      if (result.success) throw new Error('expected a failure');
      const codes = mapZodIssues(result.error.issues, { id: 'logo', src: `${long} ` }).map(
        (e) => e.code,
      );
      expect(codes).toContain('INVALID_VALUE');
      expect(codes).toContain('LIMIT_EXCEEDED');
    });
  });

  describe('timestamps, topics and notification messages', () => {
    const Notify = z.strictObject({
      message: z.string().min(1).max(500),
      at: z.iso.datetime(),
    });
    const News = z.strictObject({
      topics: z.array(z.string().min(1).max(100)).min(1),
    });

    function mapWith(schema: z.ZodType, candidate: unknown): RawError[] {
      const result = schema.safeParse(candidate);
      if (result.success) return [];
      return mapZodIssues(result.error.issues, candidate);
    }

    it.each([
      '2026-12-01T09:00:00+02:00',
      '2026-12-01T09:00Z',
      '2026-12-01T09:00:00z',
      '2026-12-01 09:00:00Z',
      'tomorrow',
    ])('reports INVALID_VALUE with the timestamp hint for at = %s', (at) => {
      const errors = mapWith(Notify, { message: 'Hi', at });
      expect(errors).toHaveLength(1);
      const e = errors[0] as RawError;
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.segments).toEqual(['at']);
      expect(e.actual).toBe(at);
      expect(e.expected).toBe('a UTC timestamp such as 2026-12-01T09:00:00Z');
      expect(e.hint).toBe('Write the time in UTC with seconds and a trailing Z.');
      expect(e.message.length).toBeGreaterThan(0);
    });

    it('accepts a UTC timestamp with seconds', () => {
      expect(mapWith(Notify, { message: 'Hi', at: '2026-12-01T09:00:00Z' })).toEqual([]);
    });

    it('reports an empty topics array as INVALID_VALUE with an add-an-item hint', () => {
      const [e, ...rest] = mapWith(News, { topics: [] });
      expect(rest).toEqual([]);
      expect(e?.code).toBe('INVALID_VALUE');
      expect(e?.segments).toEqual(['topics']);
      expect(e?.expected).toBe('an array of at least 1 item');
      expect(e?.hint).toBe('Add 1 item to this array.');
    });

    it('reports an empty or over-long topic at the topic index', () => {
      const empty = mapWith(News, { topics: ['ok', ''] });
      expect(empty.map((e) => [e.code, e.segments])).toEqual([['INVALID_VALUE', ['topics', 1]]]);
      const long = mapWith(News, { topics: ['x'.repeat(101)] });
      expect(long.map((e) => [e.code, e.segments])).toEqual([['LIMIT_EXCEEDED', ['topics', 0]]]);
      expect(long[0]?.hint).toBe('Remove 1 character from this text.');
    });

    it('reports an empty or over-long notification message', () => {
      const empty = mapWith(Notify, { message: '', at: '2026-12-01T09:00:00Z' });
      expect(empty.map((e) => [e.code, e.segments])).toEqual([['INVALID_VALUE', ['message']]]);
      expect(empty[0]?.hint).toBe('Add 1 character to this text.');
      const long = mapWith(Notify, { message: 'x'.repeat(501), at: '2026-12-01T09:00:00Z' });
      expect(long.map((e) => [e.code, e.segments])).toEqual([['LIMIT_EXCEEDED', ['message']]]);
      expect(long[0]?.hint).toBe('Remove 1 character from this text.');
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

    it.each(['image', 'list', 'ai-field', 'nope'])(
      'reports the object type %s as unknown when the union does not list it',
      (type) => {
        // The local Root only lists button and field, so every other name is unknown here.
        const e = only(objectAt({ type, id: 'b', extra: 1 }));
        expect(e.code).toBe('INVALID_VALUE');
        expect(e.segments).toEqual(['cards', 0, 'objects', 0, 'type']);
        expect(e.message).toBe(`The object type "${type}" is unknown.`);
        expect(e.message).not.toContain('not supported');
        expect(e.hint).toBe(`Use one of: ${OBJECT_TYPES.join(', ')}.`);
      },
    );

    it.each(['nope', 'fetch_news'])(
      'reports the action type %s as unknown when the union does not list it',
      (type) => {
        // The local Root only lists show_message and go_to_card, so every other name is unknown here.
        const e = only(actionAt({ type, id: 'a' }));
        expect(e.code).toBe('INVALID_VALUE');
        expect(e.segments).toEqual(['cards', 0, 'onOpen', 0, 'type']);
        expect(e.message).toBe(`The action type "${type}" is unknown.`);
        expect(e.message).not.toContain('not supported');
        expect(e.hint).toBe(`Use one of: ${ACTION_TYPES.join(', ')}.`);
      },
    );

    it('rejects an unknown object type with the "is unknown" message', () => {
      const e = only(objectAt({ type: 'widget' }));
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.message).toBe('The object type "widget" is unknown.');
      expect(e.hint).toBe(`Use one of: ${OBJECT_TYPES.join(', ')}.`);
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
            card({ objects: [{ type: 'button', id: 'b', label: '', x: 1.5 }, { type: 'nope' }] }),
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
      const candidate = root({ extra: 1, cards: [card({ onOpen: [{ type: 'nope' }] })] });
      const before = JSON.stringify(candidate);
      const first = map(candidate);
      expect(JSON.stringify(candidate)).toBe(before);
      expect(map(candidate)).toEqual(first);
    });

    it('reports no other error for an Object or Action with a bad type (Requirement 5.4)', () => {
      const errors = map(
        root({ cards: [card({ objects: [{ type: 'nope', id: 'BAD ID', extra: 1 }] })] }),
      );
      expect(errors).toHaveLength(1);
    });
  });
});
