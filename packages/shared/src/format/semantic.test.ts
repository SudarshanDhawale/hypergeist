import { describe, expect, it } from 'vitest';
import { toJsonPointer } from './text.ts';
import { buildEntityIndex, runSemanticPass, walkHandler } from './semantic.ts';
import type { SemanticError } from './semantic.ts';
import { StackSchema } from './schemas.ts';
import { validateHandler, validateStack } from './validate.ts';

type Raw = Record<string, unknown>;

const field = (id: string, extra: Raw = {}): Raw => ({
  id,
  type: 'field',
  name: '',
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  value: '',
  placeholder: '',
  multiline: false,
  readOnly: false,
  ...extra,
});

const list = (id: string, extra: Raw = {}): Raw => ({
  id,
  type: 'list',
  name: '',
  x: 0,
  y: 30,
  width: 100,
  height: 100,
  items: [],
  ordered: false,
  ...extra,
});

const button = (id: string, onClick: unknown[] = [], extra: Raw = {}): Raw => ({
  id,
  type: 'button',
  name: '',
  x: 0,
  y: 140,
  width: 60,
  height: 20,
  label: 'Go',
  onClick,
  ...extra,
});

const image = (id: string, extra: Raw = {}): Raw => ({
  id,
  type: 'image',
  name: '',
  x: 0,
  y: 0,
  width: 50,
  height: 50,
  src: 'https://example.com/a.png',
  alt: '',
  ...extra,
});

const aiField = (id: string, inputObjectIds: unknown[] = [], extra: Raw = {}): Raw => ({
  id,
  type: 'ai-field',
  name: '',
  x: 0,
  y: 150,
  width: 100,
  height: 40,
  prompt: 'Summarize',
  inputObjectIds,
  value: '',
  ...extra,
});

const card = (id: string, extra: Raw = {}): Raw => ({
  id,
  name: id,
  objects: [],
  links: [],
  onOpen: [],
  ...extra,
});

const stack = (cards: Raw[], extra: Raw = {}): Raw => ({
  formatVersion: 1,
  id: 'demo',
  name: 'Demo',
  cardWidth: 200,
  cardHeight: 200,
  startCardId: cards.length > 0 ? String((cards[0] as Raw)['id']) : 'none',
  cards,
  ...extra,
});

/** Compact view of errors: `CODE pointer`. */
function summary(errors: readonly SemanticError[]): string[] {
  return errors.map((error) => `${error.code} ${toJsonPointer(error.segments)}`);
}

function pass(candidate: unknown): string[] {
  return summary(runSemanticPass(candidate));
}

describe('runSemanticPass', () => {
  it('reports nothing for a clean stack', () => {
    const candidate = stack([
      card('a', {
        objects: [field('f'), list('l'), button('b', [{ type: 'go_to_card', cardId: 'c2' }])],
        links: [{ id: 'k', label: 'Next', targetCardId: 'c2' }],
      }),
      card('c2'),
    ]);
    expect(pass(candidate)).toEqual([]);
  });

  it('does not throw and reports nothing for non-object candidates and wrong shapes', () => {
    for (const candidate of [null, 1, 'x', [], { cards: 5 }, { cards: [1, null, 'x', []] }]) {
      expect(pass(candidate)).toEqual([]);
    }
    const bad = stack([{ id: 'a', objects: 'no', links: 7, onOpen: { type: 'go_to_card' } }]);
    expect(pass(bad)).toEqual([]);
  });

  it('does not mutate a deeply frozen candidate', () => {
    const frozen = JSON.parse(
      JSON.stringify(stack([card('a', { objects: [field('a')] })])),
    ) as unknown;
    const freeze = (value: unknown): void => {
      if (typeof value === 'object' && value !== null) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(frozen);
    expect(pass(frozen)).toEqual(['DUPLICATE_ID /cards/0/objects/0/id']);
  });

  describe('DUPLICATE_ID (7.1)', () => {
    it('reports the later occurrence across kinds, in document order', () => {
      const candidate = stack([
        card('a', {
          objects: [field('x'), list('x')],
          links: [{ id: 'a', label: 'L', targetCardId: 'a' }],
        }),
        card('x', { objects: [field('a')] }),
      ]);
      expect(pass(candidate)).toEqual([
        'DUPLICATE_ID /cards/0/objects/1/id',
        'DUPLICATE_ID /cards/0/links/0/id',
        'DUPLICATE_ID /cards/1/id',
        'DUPLICATE_ID /cards/1/objects/0/id',
      ]);
    });

    it('registers a Card id before its Object ids and Object ids before Link ids', () => {
      const candidate = stack([
        card('same', {
          objects: [field('same')],
          links: [{ id: 'same', label: 'L', targetCardId: 'same' }],
        }),
      ]);
      expect(pass(candidate)).toEqual([
        'DUPLICATE_ID /cards/0/objects/0/id',
        'DUPLICATE_ID /cards/0/links/0/id',
      ]);
    });

    it('keeps the first occurrence in the index', () => {
      const candidate = stack([card('a', { objects: [field('a')] })]);
      const { index } = buildEntityIndex(candidate);
      expect(index.get('a')).toEqual({ kind: 'card', cardIndex: 0 });
    });

    it('still registers the id of an Object with an unknown type, and checks nothing else', () => {
      const mystery = { id: 'pic', type: 'mystery', x: 9999, y: 0, width: 1, height: 1 };
      const candidate = stack([card('a', { objects: [mystery, field('pic')] })]);
      expect(pass(candidate)).toEqual(['DUPLICATE_ID /cards/0/objects/1/id']);
      expect(buildEntityIndex(candidate).index.get('pic')).toEqual({
        kind: 'object',
        cardIndex: 0,
        objectType: 'mystery',
      });
    });

    it('records the index of the owning Card for every kind', () => {
      const candidate = stack([
        card('a'),
        card('b', {
          objects: [field('f')],
          links: [{ id: 'k', label: 'L', targetCardId: 'a' }],
        }),
      ]);
      const { index } = buildEntityIndex(candidate);
      expect([index.get('a'), index.get('b'), index.get('f'), index.get('k')]).toEqual([
        { kind: 'card', cardIndex: 0 },
        { kind: 'card', cardIndex: 1 },
        { kind: 'object', cardIndex: 1, objectType: 'field' },
        { kind: 'link', cardIndex: 1 },
      ]);
    });
  });

  describe('references (4.2, 4.3, 4.4, 4.7, 4.8, 7.2, 7.3)', () => {
    it('reports DANGLING_REFERENCE for startCardId and a Link target', () => {
      const candidate = stack(
        [card('a', { links: [{ id: 'k', label: 'L', targetCardId: 'gone' }] })],
        { startCardId: 'missing' },
      );
      expect(pass(candidate)).toEqual([
        'DANGLING_REFERENCE /startCardId',
        'DANGLING_REFERENCE /cards/0/links/0/targetCardId',
      ]);
    });

    it('reports WRONG_REFERENCE_TYPE when startCardId or a Link target is an Object or Link', () => {
      const candidate = stack(
        [
          card('a', {
            objects: [field('f')],
            links: [{ id: 'k', label: 'L', targetCardId: 'f' }],
          }),
        ],
        { startCardId: 'k' },
      );
      expect(pass(candidate)).toEqual([
        'WRONG_REFERENCE_TYPE /startCardId',
        'WRONG_REFERENCE_TYPE /cards/0/links/0/targetCardId',
      ]);
    });

    it('checks go_to_card.cardId', () => {
      const candidate = stack([
        card('a', {
          objects: [
            field('f'),
            button('b1', [{ type: 'go_to_card', cardId: 'gone' }]),
            button('b2', [{ type: 'go_to_card', cardId: 'f' }], { y: 160 }),
          ],
        }),
      ]);
      expect(pass(candidate)).toEqual([
        'DANGLING_REFERENCE /cards/0/objects/1/onClick/0/cardId',
        'WRONG_REFERENCE_TYPE /cards/0/objects/2/onClick/0/cardId',
      ]);
    });

    it('checks set_value targets: target is a Field, source is a Field or List', () => {
      const actions = [
        { type: 'set_value', targetObjectId: 'l', fromObjectId: 'f' },
        { type: 'set_value', targetObjectId: 'f', fromObjectId: 'l' },
        { type: 'set_value', targetObjectId: 'nope', fromObjectId: 'a' },
        { type: 'set_value', targetObjectId: 'f', fromObjectId: 'b' },
      ];
      const candidate = stack([
        card('a', { objects: [field('f'), list('l'), button('b')], onOpen: actions }),
      ]);
      expect(pass(candidate)).toEqual([
        'WRONG_REFERENCE_TYPE /cards/0/onOpen/0/targetObjectId',
        'DANGLING_REFERENCE /cards/0/onOpen/2/targetObjectId',
        'WRONG_REFERENCE_TYPE /cards/0/onOpen/2/fromObjectId',
        'WRONG_REFERENCE_TYPE /cards/0/onOpen/3/fromObjectId',
      ]);
    });

    it('checks append_item targets: target is a List, source is a Field', () => {
      const actions = [
        { type: 'append_item', targetObjectId: 'f', fromObjectId: 'l' },
        { type: 'append_item', targetObjectId: 'l', fromObjectId: 'f' },
        { type: 'append_item', targetObjectId: 'gone', item: 'x' },
      ];
      const candidate = stack([card('a', { objects: [field('f'), list('l')], onOpen: actions })]);
      expect(pass(candidate)).toEqual([
        'WRONG_REFERENCE_TYPE /cards/0/onOpen/0/targetObjectId',
        'WRONG_REFERENCE_TYPE /cards/0/onOpen/0/fromObjectId',
        'DANGLING_REFERENCE /cards/0/onOpen/2/targetObjectId',
      ]);
    });

    it('resolves a reference to an unknown-type Object as WRONG_REFERENCE_TYPE', () => {
      const mystery = { id: 'pic', type: 'mystery' };
      const candidate = stack([
        card('a', {
          objects: [mystery],
          onOpen: [{ type: 'set_value', targetObjectId: 'pic', value: '' }],
        }),
      ]);
      expect(pass(candidate)).toEqual(['WRONG_REFERENCE_TYPE /cards/0/onOpen/0/targetObjectId']);
    });

    it('skips non-string references (the structural pass reports them)', () => {
      const candidate = stack(
        [
          card('a', {
            links: [{ id: 'k', label: 'L', targetCardId: 5 }],
            onOpen: [{ type: 'go_to_card', cardId: null }],
          }),
        ],
        { startCardId: 7 },
      );
      expect(pass(candidate)).toEqual([]);
    });

    it('carries the offending value and an actionable message', () => {
      const [error] = runSemanticPass(stack([card('a')], { startCardId: 'missing' }));
      expect(error).toMatchObject({
        code: 'DANGLING_REFERENCE',
        segments: ['startCardId'],
        actual: { present: true, value: 'missing' },
      });
      expect(error?.message.length).toBeGreaterThan(0);
      expect(error?.expected.length).toBeGreaterThan(0);
      expect(error?.hint.length).toBeGreaterThan(0);
    });
  });

  describe('widened Action references (6.4, 6.5)', () => {
    const run = (action: Raw): string[] =>
      pass(
        stack([
          card('a', {
            objects: [field('f'), list('l'), aiField('ai'), image('pic')],
            onOpen: [action],
          }),
        ]),
      );

    it('lets set_value target a field or an ai-field, and read a field, ai-field, or list', () => {
      expect(run({ type: 'set_value', targetObjectId: 'ai', value: '' })).toEqual([]);
      expect(run({ type: 'set_value', targetObjectId: 'f', fromObjectId: 'ai' })).toEqual([]);
      expect(run({ type: 'set_value', targetObjectId: 'ai', fromObjectId: 'l' })).toEqual([]);
    });

    it('lets append_item read an ai-field', () => {
      expect(run({ type: 'append_item', targetObjectId: 'l', fromObjectId: 'ai' })).toEqual([]);
    });

    it('still rejects a list target for set_value, and an image anywhere', () => {
      expect(run({ type: 'set_value', targetObjectId: 'l', value: '' })).toEqual([
        'WRONG_REFERENCE_TYPE /cards/0/onOpen/0/targetObjectId',
      ]);
      expect(run({ type: 'set_value', targetObjectId: 'pic', value: '' })).toEqual([
        'WRONG_REFERENCE_TYPE /cards/0/onOpen/0/targetObjectId',
      ]);
      expect(run({ type: 'set_value', targetObjectId: 'f', fromObjectId: 'pic' })).toEqual([
        'WRONG_REFERENCE_TYPE /cards/0/onOpen/0/fromObjectId',
      ]);
      expect(run({ type: 'append_item', targetObjectId: 'l', fromObjectId: 'l' })).toEqual([
        'WRONG_REFERENCE_TYPE /cards/0/onOpen/0/fromObjectId',
      ]);
    });

    it('names the allowed types in the message', () => {
      const errors = runSemanticPass(
        stack([
          card('a', {
            objects: [field('f'), button('b')],
            onOpen: [{ type: 'set_value', targetObjectId: 'f', fromObjectId: 'b' }],
          }),
        ]),
      );
      expect(errors.map((e) => e.expected)).toEqual([
        'the id of a field, ai-field, or list object',
      ]);
    });
  });

  describe('the five new Actions (6.3 to 6.11)', () => {
    const run = (action: Raw): string[] =>
      pass(
        stack([
          card('a', {
            objects: [field('f'), list('l'), aiField('ai'), image('pic'), button('b')],
            onOpen: [action],
          }),
        ]),
      );
    const target = '/cards/0/onOpen/0/targetObjectId';

    it('accepts each Action with references of the right type', () => {
      expect(run({ type: 'remove_item', targetObjectId: 'l', index: 0 })).toEqual([]);
      expect(run({ type: 'show_message', text: 'hi' })).toEqual([]);
      expect(run({ type: 'run_ai_field', targetObjectId: 'ai' })).toEqual([]);
      expect(run({ type: 'fetch_news', targetObjectId: 'l', topics: ['a'] })).toEqual([]);
      expect(run({ type: 'transcribe_audio', targetObjectId: 'f' })).toEqual([]);
      expect(run({ type: 'schedule_notification', message: 'm', atFromObjectId: 'f' })).toEqual([]);
      expect(
        run({ type: 'schedule_notification', message: 'm', at: '2026-12-01T09:00:00Z' }),
      ).toEqual([]);
    });

    it.each<[string, Raw]>([
      ['remove_item', { type: 'remove_item', targetObjectId: 'f', index: 0 }],
      ['run_ai_field', { type: 'run_ai_field', targetObjectId: 'f' }],
      ['fetch_news', { type: 'fetch_news', targetObjectId: 'f', topics: ['a'] }],
      ['transcribe_audio', { type: 'transcribe_audio', targetObjectId: 'ai' }],
    ])('reports WRONG_REFERENCE_TYPE for a %s target of the wrong type', (_label, action) => {
      expect(run(action)).toEqual([`WRONG_REFERENCE_TYPE ${target}`]);
    });

    it.each<[string, Raw]>([
      ['remove_item', { type: 'remove_item', targetObjectId: 'gone', index: 0 }],
      ['run_ai_field', { type: 'run_ai_field', targetObjectId: 'gone' }],
      ['fetch_news', { type: 'fetch_news', targetObjectId: 'gone', topics: ['a'] }],
      ['transcribe_audio', { type: 'transcribe_audio', targetObjectId: 'gone' }],
    ])('reports DANGLING_REFERENCE for a %s target that does not exist', (_label, action) => {
      expect(run(action)).toEqual([`DANGLING_REFERENCE ${target}`]);
    });

    it('rejects a Card, a Link, and a Button as a target', () => {
      expect(run({ type: 'run_ai_field', targetObjectId: 'a' })).toEqual([
        `WRONG_REFERENCE_TYPE ${target}`,
      ]);
      expect(run({ type: 'remove_item', targetObjectId: 'b', index: 0 })).toEqual([
        `WRONG_REFERENCE_TYPE ${target}`,
      ]);
      expect(run({ type: 'transcribe_audio', targetObjectId: 'pic' })).toEqual([
        `WRONG_REFERENCE_TYPE ${target}`,
      ]);
    });

    it('checks schedule_notification.atFromObjectId against fields only', () => {
      const at = '/cards/0/onOpen/0/atFromObjectId';
      expect(run({ type: 'schedule_notification', message: 'm', atFromObjectId: 'gone' })).toEqual([
        `DANGLING_REFERENCE ${at}`,
      ]);
      expect(run({ type: 'schedule_notification', message: 'm', atFromObjectId: 'ai' })).toEqual([
        `WRONG_REFERENCE_TYPE ${at}`,
      ]);
    });

    it('requires exactly one of at and atFromObjectId, as INVALID_VALUE at the Action', () => {
      const both = {
        type: 'schedule_notification',
        message: 'm',
        at: '2026-12-01T09:00:00Z',
        atFromObjectId: 'f',
      };
      const neither = { type: 'schedule_notification', message: 'm' };
      expect(run(both)).toEqual(['INVALID_VALUE /cards/0/onOpen/0']);
      expect(run(neither)).toEqual(['INVALID_VALUE /cards/0/onOpen/0']);
    });

    it('limits fetch_news topics to 10 and still checks the reference', () => {
      const topics = (count: number): string[] => Array.from({ length: count }, () => 'x');
      expect(run({ type: 'fetch_news', targetObjectId: 'l', topics: topics(10) })).toEqual([]);
      expect(run({ type: 'fetch_news', targetObjectId: 'l', topics: topics(11) })).toEqual([
        'LIMIT_EXCEEDED /cards/0/onOpen/0/topics',
      ]);
      expect(run({ type: 'fetch_news', targetObjectId: 'gone', topics: topics(11) })).toEqual([
        `DANGLING_REFERENCE ${target}`,
        'LIMIT_EXCEEDED /cards/0/onOpen/0/topics',
      ]);
    });

    it('skips a missing or non-array topics list', () => {
      expect(run({ type: 'fetch_news', targetObjectId: 'l' })).toEqual([]);
      expect(run({ type: 'fetch_news', targetObjectId: 'l', topics: 'x' })).toEqual([]);
    });
  });

  describe('ai-field inputObjectIds (4.7, 4.8)', () => {
    const inputs = (...objects: Raw[]): string[] => pass(stack([card('a', { objects })]));
    const at = (entry: number): string => `/cards/0/objects/3/inputObjectIds/${entry}`;
    const base = (): Raw[] => [field('f'), list('l'), image('pic', { x: 100, y: 0 })];

    it('accepts a field, a list, and another ai-field on the same Card', () => {
      expect(
        inputs(
          field('f'),
          list('l'),
          aiField('other', [], { x: 100 }),
          aiField('ai', ['f', 'l', 'other'], { y: 100, x: 100 }),
        ),
      ).toEqual([]);
      expect(inputs(aiField('ai', []))).toEqual([]);
    });

    it('reports DANGLING_REFERENCE at the entry, and skips non-string entries', () => {
      expect(inputs(...base(), aiField('ai', ['f', 'gone', 5, null]))).toEqual([
        `DANGLING_REFERENCE ${at(1)}`,
      ]);
    });

    it('reports WRONG_REFERENCE_TYPE for the ai-field itself, naming it', () => {
      const candidate = stack([card('a', { objects: [...base(), aiField('ai', ['ai'])] })]);
      const [error] = runSemanticPass(candidate);
      expect(summary(runSemanticPass(candidate))).toEqual([`WRONG_REFERENCE_TYPE ${at(0)}`]);
      expect(error?.message).toContain('"ai"');
      expect(error?.message).toContain('itself');
      expect(error?.actual).toEqual({ present: true, value: 'ai' });
    });

    it('reports WRONG_REFERENCE_TYPE for a Card and a Link', () => {
      const candidate = stack([
        card('a', {
          objects: [...base(), aiField('ai', ['a', 'k'])],
          links: [{ id: 'k', label: 'L', targetCardId: 'a' }],
        }),
      ]);
      const errors = runSemanticPass(candidate);
      expect(summary(errors)).toEqual([
        `WRONG_REFERENCE_TYPE ${at(0)}`,
        `WRONG_REFERENCE_TYPE ${at(1)}`,
      ]);
      expect(errors[0]?.message).toContain('a card');
      expect(errors[1]?.message).toContain('a link');
      expect(errors.every((e) => e.message.includes('"ai"'))).toBe(true);
    });

    it('reports WRONG_REFERENCE_TYPE for a button and an image', () => {
      const candidate = stack([
        card('a', { objects: [...base(), aiField('ai', ['pic', 'b'], { y: 100 }), button('b')] }),
      ]);
      const errors = runSemanticPass(candidate);
      expect(summary(errors)).toEqual([
        `WRONG_REFERENCE_TYPE ${at(0)}`,
        `WRONG_REFERENCE_TYPE ${at(1)}`,
      ]);
      expect(errors[0]?.message).toContain('"image"');
      expect(errors[1]?.message).toContain('"button"');
    });

    it('reports WRONG_REFERENCE_TYPE for an Object of an unknown type', () => {
      const mystery = { id: 'm', type: 'mystery' };
      expect(inputs(...base(), aiField('ai', ['m']), mystery)).toEqual([
        `WRONG_REFERENCE_TYPE ${at(0)}`,
      ]);
    });

    it('reports WRONG_REFERENCE_TYPE for an Object on another Card', () => {
      const candidate = stack([
        card('a', { objects: [field('f1'), list('l1'), aiField('other')] }),
        card('b', { objects: [field('g'), aiField('ai', ['f1', 'g', 'other'])] }),
      ]);
      const errors = runSemanticPass(candidate);
      expect(summary(errors)).toEqual([
        'WRONG_REFERENCE_TYPE /cards/1/objects/1/inputObjectIds/0',
        'WRONG_REFERENCE_TYPE /cards/1/objects/1/inputObjectIds/2',
      ]);
      expect(errors[0]?.message).toContain('different card');
      expect(errors[0]?.message).toContain('"ai"');
    });

    it('reports INVALID_VALUE at the later entry of a repeated id', () => {
      const errors = runSemanticPass(
        stack([card('a', { objects: [...base(), aiField('ai', ['f', 'l', 'f', 'f'])] })]),
      );
      expect(summary(errors)).toEqual([`INVALID_VALUE ${at(2)}`, `INVALID_VALUE ${at(3)}`]);
      expect(errors[0]?.message).toContain('"ai"');
    });

    it('reports a repeated id that is also wrong once per rule', () => {
      expect(inputs(...base(), aiField('ai', ['gone', 'gone']))).toEqual([
        `DANGLING_REFERENCE ${at(0)}`,
        `INVALID_VALUE ${at(1)}`,
        `DANGLING_REFERENCE ${at(1)}`,
      ]);
    });

    it('reports the 10-entry limit and still checks every entry past it', () => {
      const ids = Array.from({ length: 11 }, () => 'gone');
      const errors = pass(stack([card('a', { objects: [aiField('ai', ids)] })]));
      const path = '/cards/0/objects/0/inputObjectIds';
      expect(errors.filter((line) => line === `LIMIT_EXCEEDED ${path}`)).toHaveLength(1);
      expect(errors.filter((line) => line.startsWith('DANGLING_REFERENCE '))).toHaveLength(11);
      expect(errors.filter((line) => line.startsWith('INVALID_VALUE '))).toHaveLength(10);
    });

    it('skips a missing or non-array inputObjectIds (the structural pass reports it)', () => {
      const without = aiField('ai');
      delete without['inputObjectIds'];
      expect(inputs(without)).toEqual([]);
      expect(inputs(aiField('ai', [], { inputObjectIds: 'f' }))).toEqual([]);
    });

    it('does not check inputs of an Object that is not an ai-field', () => {
      expect(inputs(field('f', { inputObjectIds: ['gone'] }))).toEqual([]);
    });
  });

  describe('exactly-one-of (4.6)', () => {
    const run = (action: Raw): string[] =>
      pass(stack([card('a', { objects: [field('f'), list('l')], onOpen: [action] })]));

    it('rejects set_value with both and with neither', () => {
      expect(
        run({ type: 'set_value', targetObjectId: 'f', value: 'x', fromObjectId: 'f' }),
      ).toEqual(['INVALID_VALUE /cards/0/onOpen/0']);
      expect(run({ type: 'set_value', targetObjectId: 'f' })).toEqual([
        'INVALID_VALUE /cards/0/onOpen/0',
      ]);
    });

    it('rejects append_item with both and with neither', () => {
      expect(
        run({ type: 'append_item', targetObjectId: 'l', item: 'x', fromObjectId: 'f' }),
      ).toEqual(['INVALID_VALUE /cards/0/onOpen/0']);
      expect(run({ type: 'append_item', targetObjectId: 'l' })).toEqual([
        'INVALID_VALUE /cards/0/onOpen/0',
      ]);
    });

    it('accepts exactly one', () => {
      expect(run({ type: 'set_value', targetObjectId: 'f', value: '' })).toEqual([]);
      expect(run({ type: 'set_value', targetObjectId: 'f', fromObjectId: 'l' })).toEqual([]);
      expect(run({ type: 'append_item', targetObjectId: 'l', item: '' })).toEqual([]);
      expect(run({ type: 'append_item', targetObjectId: 'l', fromObjectId: 'f' })).toEqual([]);
    });
  });

  describe('OUT_OF_BOUNDS (3.5, 3.6)', () => {
    const run = (extra: Raw): string[] =>
      pass(stack([card('a', { objects: [field('f', extra)] })]));

    it('accepts an Object that ends exactly on the card edge', () => {
      expect(run({ x: 100, y: 180, width: 100, height: 20 })).toEqual([]);
    });

    it('rejects one unit past the right edge, the bottom edge, and both (once)', () => {
      expect(run({ x: 101, y: 180, width: 100, height: 20 })).toEqual([
        'OUT_OF_BOUNDS /cards/0/objects/0',
      ]);
      expect(run({ x: 100, y: 181, width: 100, height: 20 })).toEqual([
        'OUT_OF_BOUNDS /cards/0/objects/0',
      ]);
      expect(run({ x: 101, y: 181, width: 100, height: 20 })).toEqual([
        'OUT_OF_BOUNDS /cards/0/objects/0',
      ]);
    });

    it('checks every supported Object type, and skips non-numeric geometry', () => {
      const candidate = stack([
        card('a', {
          objects: [
            list('l', { x: 150, width: 100 }),
            button('b', [], { x: 150, width: 100 }),
            field('f', { x: '150' }),
          ],
        }),
      ]);
      expect(pass(candidate)).toEqual([
        'OUT_OF_BOUNDS /cards/0/objects/0',
        'OUT_OF_BOUNDS /cards/0/objects/1',
      ]);
    });

    it('checks image and ai-field Objects too', () => {
      const candidate = stack([
        card('a', {
          objects: [
            image('pic', { x: 150, width: 100 }),
            aiField('ai', [], { y: 190, height: 40 }),
            image('ok', { x: 150, y: 150, width: 50, height: 50 }),
          ],
        }),
      ]);
      expect(pass(candidate)).toEqual([
        'OUT_OF_BOUNDS /cards/0/objects/0',
        'OUT_OF_BOUNDS /cards/0/objects/1',
      ]);
    });

    it('skips an unknown-type Object and an unusable card size', () => {
      const mystery = { id: 'pic', type: 'mystery', x: 500, y: 500, width: 500, height: 500 };
      expect(pass(stack([card('a', { objects: [mystery] })]))).toEqual([]);
      expect(
        pass(stack([card('a', { objects: [field('f', { x: 999 })] })], { cardWidth: 'wide' })),
      ).toEqual([]);
    });
  });

  describe('DUPLICATE_LINK (7.4, 7.5, 7.6)', () => {
    const link = (id: string, targetCardId: string): Raw => ({ id, label: 'L', targetCardId });

    it('reports the later Link with the same target in a Card', () => {
      const candidate = stack([
        card('a', { links: [link('k1', 'b'), link('k2', 'a'), link('k3', 'b')] }),
        card('b'),
      ]);
      expect(pass(candidate)).toEqual(['DUPLICATE_LINK /cards/0/links/2/targetCardId']);
    });

    it('accepts a Link to its own Card', () => {
      expect(pass(stack([card('a', { links: [link('k1', 'a')] })]))).toEqual([]);
    });

    it('accepts equal targets in different Cards', () => {
      const candidate = stack([
        card('a', { links: [link('k1', 'c')] }),
        card('b', { links: [link('k2', 'c')] }),
        card('c'),
      ]);
      expect(pass(candidate)).toEqual([]);
    });
  });

  describe('Handlers on Buttons and Cards', () => {
    it('skips unknown Action types and non-record Actions', () => {
      const actions = [
        { type: 'nope', targetObjectId: 'gone' },
        { type: 'mystery', cardId: 'gone' },
        { cardId: 'gone' },
        'go_to_card',
        null,
      ];
      const candidate = stack([card('a', { objects: [button('b', actions)], onOpen: actions })]);
      expect(pass(candidate)).toEqual([]);
    });

    it('reports the 20-action limit and still walks every action past it', () => {
      const actions = Array.from({ length: 21 }, () => ({ type: 'go_to_card', cardId: 'gone' }));
      const errors = pass(stack([card('a', { onOpen: actions })]));
      expect(errors).toHaveLength(22);
      expect(errors.filter((line) => line.startsWith('LIMIT_EXCEEDED '))).toHaveLength(1);
      expect(errors.filter((line) => line.startsWith('DANGLING_REFERENCE '))).toHaveLength(21);
    });

    it('does not walk the onClick of an Object that is not a button', () => {
      const bogus = field('f', { onClick: [{ type: 'go_to_card', cardId: 'gone' }] });
      expect(pass(stack([card('a', { objects: [bogus] })]))).toEqual([]);
    });
  });

  it('returns errors for several rules at once and is deterministic', () => {
    const candidate = stack(
      [
        card('a', {
          objects: [field('a', { x: 500 })],
          links: [{ id: 'k', label: 'L', targetCardId: 'zzz' }],
        }),
      ],
      { startCardId: 'k' },
    );
    const first = pass(candidate);
    expect(first).toEqual([
      'DUPLICATE_ID /cards/0/objects/0/id',
      'WRONG_REFERENCE_TYPE /startCardId',
      'OUT_OF_BOUNDS /cards/0/objects/0',
      'DANGLING_REFERENCE /cards/0/links/0/targetCardId',
    ]);
    expect(pass(candidate)).toEqual(first);
  });
});

describe('walkHandler (the walker validateHandler uses)', () => {
  const candidate = stack([card('a', { objects: [field('f'), list('l')] }), card('b')]);
  const { index } = buildEntityIndex(candidate);

  it('reports errors with paths relative to the Handler root', () => {
    const handler = [
      { type: 'show_message', text: 'hi' },
      { type: 'go_to_card', cardId: 'f' },
      { type: 'append_item', targetObjectId: 'l', fromObjectId: 'missing' },
      { type: 'set_value', targetObjectId: 'f' },
    ];
    expect(summary(walkHandler(handler, [], index))).toEqual([
      'WRONG_REFERENCE_TYPE /1/cardId',
      'DANGLING_REFERENCE /2/fromObjectId',
      'INVALID_VALUE /3',
    ]);
  });

  it('accepts a valid Handler and returns nothing for a non-array', () => {
    const handler = [
      { type: 'append_item', targetObjectId: 'l', fromObjectId: 'f' },
      { type: 'set_value', targetObjectId: 'f', value: '' },
      { type: 'go_to_card', cardId: 'b' },
    ];
    expect(walkHandler(handler, [], index)).toEqual([]);
    expect(walkHandler({ type: 'go_to_card' }, [], index)).toEqual([]);
    expect(walkHandler(undefined, [], index)).toEqual([]);
  });

  it('prefixes the given base path', () => {
    const errors = walkHandler(
      [{ type: 'go_to_card', cardId: 'gone' }],
      ['cards', 0, 'onOpen'],
      index,
    );
    expect(summary(errors)).toEqual(['DANGLING_REFERENCE /cards/0/onOpen/0/cardId']);
  });
});

// ---------------------------------------------------------------------------
// The same rules end to end through `validateStack` and `validateHandler`,
// with the real schemas, pointer building, and document-order sorting.
// Requirements 3.5, 3.6, 4.2 to 4.9, 7.1 to 7.6.
// ---------------------------------------------------------------------------

/** Compact view of a Validation_Result: `[code, path]` per error. */
function run(candidate: unknown): [string, string][] {
  return validateStack(candidate).errors.map((error) => [error.code, error.path]);
}

describe('validateStack: semantic rules end to end', () => {
  it('accepts every rule at its legal edge in one stack', () => {
    const candidate = stack(
      [
        card('a', {
          objects: [
            field('f', { x: 100, y: 180, width: 100, height: 20 }),
            list('l', { x: 0, y: 0, width: 200, height: 180 }),
            button(
              'b',
              [
                { type: 'go_to_card', cardId: 'b2' },
                { type: 'set_value', targetObjectId: 'f', value: '' },
                { type: 'set_value', targetObjectId: 'f', fromObjectId: 'l' },
                { type: 'append_item', targetObjectId: 'l', item: '' },
                { type: 'append_item', targetObjectId: 'l', fromObjectId: 'f' },
              ],
              { x: 0, y: 180, width: 100, height: 20 },
            ),
          ],
          links: [
            { id: 'self', label: 'Me', targetCardId: 'a' },
            { id: 'to-b2', label: 'B2', targetCardId: 'b2' },
          ],
          onOpen: [{ type: 'go_to_card', cardId: 'a' }],
        }),
        card('b2', { links: [{ id: 'also-b2', label: 'B2', targetCardId: 'b2' }] }),
        card('c3', { links: [{ id: 'c3-to-b2', label: 'B2', targetCardId: 'b2' }] }),
      ],
      { startCardId: 'c3' },
    );
    expect(validateStack(candidate)).toEqual({ valid: true, errors: [], truncated: false });
  });

  describe('DUPLICATE_ID (7.1)', () => {
    it('points at the id of the later entity, across Cards, Objects, and Links', () => {
      const candidate = stack([
        card('a', {
          objects: [field('x')],
          links: [{ id: 'x', label: 'L', targetCardId: 'a' }],
        }),
        card('x', { objects: [field('a')] }),
      ]);
      const result = validateStack(candidate);
      expect(run(candidate)).toEqual([
        ['DUPLICATE_ID', '/cards/0/links/0/id'],
        ['DUPLICATE_ID', '/cards/1/id'],
        ['DUPLICATE_ID', '/cards/1/objects/0/id'],
      ]);
      expect(result.errors[0]).toMatchObject({ actual: '"x"' });
      expect(result.errors[0]?.message).toContain('"x"');
      expect(result.errors[0]?.hint.length).toBeGreaterThan(0);
    });

    it('reports every later occurrence of a repeated id, not only the second', () => {
      const candidate = stack([card('a'), card('a'), card('a')]);
      expect(run(candidate)).toEqual([
        ['DUPLICATE_ID', '/cards/1/id'],
        ['DUPLICATE_ID', '/cards/2/id'],
      ]);
    });

    it('does not report the same id in no other place as a duplicate', () => {
      expect(run(stack([card('a', { objects: [field('b')] }), card('c')]))).toEqual([]);
    });
  });

  describe('references (4.2, 4.3, 4.4, 4.7, 4.8, 7.2, 7.3)', () => {
    it('checks startCardId and a Link targetCardId', () => {
      const dangling = stack(
        [card('a', { links: [{ id: 'k', label: 'L', targetCardId: 'gone' }] })],
        {
          startCardId: 'missing',
        },
      );
      expect(run(dangling)).toEqual([
        ['DANGLING_REFERENCE', '/startCardId'],
        ['DANGLING_REFERENCE', '/cards/0/links/0/targetCardId'],
      ]);

      const wrong = stack(
        [
          card('a', {
            objects: [field('f')],
            links: [{ id: 'k', label: 'L', targetCardId: 'f' }],
          }),
        ],
        { startCardId: 'k' },
      );
      const result = validateStack(wrong);
      expect(result.errors.map((e) => [e.code, e.path, e.actual])).toEqual([
        ['WRONG_REFERENCE_TYPE', '/startCardId', '"k"'],
        ['WRONG_REFERENCE_TYPE', '/cards/0/links/0/targetCardId', '"f"'],
      ]);
      expect(result.errors.every((e) => e.message.length > 0 && e.hint.length > 0)).toBe(true);
    });

    // Objects: f field, l list, b button; Card a; Link k.
    const table: readonly [string, Raw, string, string][] = [
      ['go_to_card to a missing id', { type: 'go_to_card', cardId: 'gone' }, 'cardId', 'DANGLING'],
      ['go_to_card to a List', { type: 'go_to_card', cardId: 'l' }, 'cardId', 'WRONG'],
      ['go_to_card to a Link', { type: 'go_to_card', cardId: 'k' }, 'cardId', 'WRONG'],
      [
        'set_value to a missing target',
        { type: 'set_value', targetObjectId: 'gone', value: '' },
        'targetObjectId',
        'DANGLING',
      ],
      [
        'set_value into a List',
        { type: 'set_value', targetObjectId: 'l', value: '' },
        'targetObjectId',
        'WRONG',
      ],
      [
        'set_value into a Card',
        { type: 'set_value', targetObjectId: 'a', value: '' },
        'targetObjectId',
        'WRONG',
      ],
      [
        'set_value from a missing source',
        { type: 'set_value', targetObjectId: 'f', fromObjectId: 'gone' },
        'fromObjectId',
        'DANGLING',
      ],
      [
        'set_value from a Button',
        { type: 'set_value', targetObjectId: 'f', fromObjectId: 'b' },
        'fromObjectId',
        'WRONG',
      ],
      [
        'set_value from a Link',
        { type: 'set_value', targetObjectId: 'f', fromObjectId: 'k' },
        'fromObjectId',
        'WRONG',
      ],
      [
        'append_item to a missing target',
        { type: 'append_item', targetObjectId: 'gone', item: '' },
        'targetObjectId',
        'DANGLING',
      ],
      [
        'append_item to a Field',
        { type: 'append_item', targetObjectId: 'f', item: '' },
        'targetObjectId',
        'WRONG',
      ],
      [
        'append_item from a missing source',
        { type: 'append_item', targetObjectId: 'l', fromObjectId: 'gone' },
        'fromObjectId',
        'DANGLING',
      ],
      [
        'append_item from a List',
        { type: 'append_item', targetObjectId: 'l', fromObjectId: 'l' },
        'fromObjectId',
        'WRONG',
      ],
    ];

    const placements: readonly [string, (action: Raw) => Raw, string][] = [
      [
        'Card onOpen',
        (action) =>
          card('a', {
            objects: [field('f'), list('l'), button('b')],
            links: [{ id: 'k', label: 'L', targetCardId: 'a' }],
            onOpen: [action],
          }),
        '/cards/0/onOpen/0',
      ],
      [
        'Button onClick',
        (action) =>
          card('a', {
            objects: [field('f'), list('l'), button('b', [action])],
            links: [{ id: 'k', label: 'L', targetCardId: 'a' }],
          }),
        '/cards/0/objects/2/onClick/0',
      ],
    ];

    describe.each(placements)('in a %s Handler', (_name, build, actionPath) => {
      it.each(table)('%s', (_label, action, key, kind) => {
        const result = validateStack(stack([build(action)]));
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatchObject({
          code: `${kind}_${kind === 'DANGLING' ? 'REFERENCE' : 'REFERENCE_TYPE'}`,
          path: `${actionPath}/${key}`,
          actual: JSON.stringify(action[key]),
        });
      });
    });
  });

  describe('exactly-one-of (4.6)', () => {
    const through = (action: Raw): ReturnType<typeof validateStack> =>
      validateStack(stack([card('a', { objects: [field('f'), list('l')], onOpen: [action] })]));

    it.each<[string, Raw]>([
      [
        'set_value with both',
        { type: 'set_value', targetObjectId: 'f', value: 'x', fromObjectId: 'l' },
      ],
      ['set_value with neither', { type: 'set_value', targetObjectId: 'f' }],
      [
        'append_item with both',
        { type: 'append_item', targetObjectId: 'l', item: 'x', fromObjectId: 'f' },
      ],
      ['append_item with neither', { type: 'append_item', targetObjectId: 'l' }],
    ])('rejects %s, once, at the Action', (_label, action) => {
      const result = through(action);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        code: 'INVALID_VALUE',
        path: '/cards/0/onOpen/0',
        actual: JSON.stringify(action),
      });
      expect(result.errors[0]?.expected).toContain('exactly one');
    });

    it('accepts an empty string as the one property that is present', () => {
      expect(through({ type: 'set_value', targetObjectId: 'f', value: '' }).valid).toBe(true);
      expect(through({ type: 'append_item', targetObjectId: 'l', item: '' }).valid).toBe(true);
    });

    it('reports the Action error before the reference error under it', () => {
      const result = through({
        type: 'set_value',
        targetObjectId: 'f',
        value: 'x',
        fromObjectId: 'gone',
      });
      expect(result.errors.map((e) => [e.code, e.path])).toEqual([
        ['INVALID_VALUE', '/cards/0/onOpen/0'],
        ['DANGLING_REFERENCE', '/cards/0/onOpen/0/fromObjectId'],
      ]);
    });
  });

  describe('OUT_OF_BOUNDS (3.5, 3.6)', () => {
    // The helper stack is 200 by 200.
    it.each<[string, Raw, boolean]>([
      ['flush with the right and bottom edges', { x: 100, y: 180, width: 100, height: 20 }, true],
      ['covering the whole card', { x: 0, y: 0, width: 200, height: 200 }, true],
      ['one past the right edge', { x: 101, y: 180, width: 100, height: 20 }, false],
      ['one past the bottom edge', { x: 100, y: 181, width: 100, height: 20 }, false],
      ['one wider than the card', { x: 0, y: 0, width: 201, height: 200 }, false],
      ['one taller than the card', { x: 0, y: 0, width: 200, height: 201 }, false],
      ['far past the card (largest legal coordinate)', { x: 4096, y: 4096 }, false],
    ])('an Object %s', (_label, geometry, ok) => {
      const candidate = stack([card('a', { objects: [field('f', geometry)] })]);
      expect(run(candidate)).toEqual(ok ? [] : [['OUT_OF_BOUNDS', '/cards/0/objects/0']]);
    });

    it('reports one error per Object even when both axes overflow, and one per Object', () => {
      const candidate = stack([
        card('a', {
          objects: [
            field('f', { x: 150, y: 150, width: 100, height: 100 }),
            list('l', { x: 0, y: 0, width: 300, height: 300 }),
            button('b', [], { x: 199, y: 199 }),
          ],
        }),
      ]);
      const result = validateStack(candidate);
      expect(result.errors.map((e) => [e.code, e.path])).toEqual([
        ['OUT_OF_BOUNDS', '/cards/0/objects/0'],
        ['OUT_OF_BOUNDS', '/cards/0/objects/1'],
        ['OUT_OF_BOUNDS', '/cards/0/objects/2'],
      ]);
      expect(result.errors[0]?.message).toContain('right edge');
      expect(result.errors[0]?.message).toContain('bottom edge');
    });

    it('measures against each stack, not a fixed card size', () => {
      const object = field('f', { x: 100, y: 0, width: 100, height: 20 });
      expect(run(stack([card('a', { objects: [object] })], { cardWidth: 200 }))).toEqual([]);
      expect(run(stack([card('a', { objects: [object] })], { cardWidth: 199 }))).toEqual([
        ['OUT_OF_BOUNDS', '/cards/0/objects/0'],
      ]);
    });
  });

  describe('Links (7.4, 7.5, 7.6)', () => {
    const link = (id: string, targetCardId: string): Raw => ({ id, label: 'L', targetCardId });

    it('reports each later Link that repeats a target, at its targetCardId', () => {
      const candidate = stack([
        card('a', { links: [link('k1', 'b'), link('k2', 'b'), link('k3', 'a'), link('k4', 'b')] }),
        card('b'),
      ]);
      const result = validateStack(candidate);
      expect(result.errors.map((e) => [e.code, e.path, e.actual])).toEqual([
        ['DUPLICATE_LINK', '/cards/0/links/1/targetCardId', '"b"'],
        ['DUPLICATE_LINK', '/cards/0/links/3/targetCardId', '"b"'],
      ]);
    });

    it('accepts a self-link and equal targets in different Cards', () => {
      const candidate = stack([
        card('a', { links: [link('k1', 'a'), link('k2', 'c')] }),
        card('b', { links: [link('k3', 'b'), link('k4', 'c')] }),
        card('c', { links: [link('k5', 'c')] }),
      ]);
      expect(validateStack(candidate).valid).toBe(true);
    });

    it('reports a repeated self-link as DUPLICATE_LINK', () => {
      const candidate = stack([card('a', { links: [link('k1', 'a'), link('k2', 'a')] })]);
      expect(run(candidate)).toEqual([['DUPLICATE_LINK', '/cards/0/links/1/targetCardId']]);
    });
  });

  describe('document order of structural and semantic errors (6.6)', () => {
    it('merges both kinds across Cards by position in the candidate', () => {
      const candidate = stack(
        [
          card('a', { objects: [field('f', { x: 150 })] }),
          card('b', { bogus: 1 }),
          card('a', { links: [{ id: 'k', label: 'L', targetCardId: 'zzz' }] }),
        ],
        { startCardId: 'ghost' },
      );
      expect(run(candidate)).toEqual([
        ['DANGLING_REFERENCE', '/startCardId'],
        ['OUT_OF_BOUNDS', '/cards/0/objects/0'],
        ['UNKNOWN_PROPERTY', '/cards/1/bogus'],
        ['DUPLICATE_ID', '/cards/2/id'],
        ['DANGLING_REFERENCE', '/cards/2/links/0/targetCardId'],
      ]);
    });

    it('follows the property order of the candidate, not the schema order', () => {
      const { startCardId, ...rest } = stack([card('a', { bogus: 1 })], { startCardId: 'ghost' });
      const candidate = { ...rest, startCardId };
      expect(Object.keys(candidate).at(-1)).toBe('startCardId');
      expect(run(candidate)).toEqual([
        ['UNKNOWN_PROPERTY', '/cards/0/bogus'],
        ['DANGLING_REFERENCE', '/startCardId'],
      ]);
    });

    it('puts the error for an Object before the errors for its properties', () => {
      const candidate = stack([
        card('a', { objects: [field('f', { x: 150, width: 100, placeholder: 5 })] }),
      ]);
      expect(run(candidate)).toEqual([
        ['OUT_OF_BOUNDS', '/cards/0/objects/0'],
        ['WRONG_TYPE', '/cards/0/objects/0/placeholder'],
      ]);
    });

    it('breaks a tie on the same path by code in ascending order', () => {
      const dupLink = stack([
        card('a', {
          links: [
            { id: 'k1', label: 'L', targetCardId: 'zzz' },
            { id: 'k2', label: 'L', targetCardId: 'zzz' },
          ],
        }),
      ]);
      expect(run(dupLink)).toEqual([
        ['DANGLING_REFERENCE', '/cards/0/links/0/targetCardId'],
        ['DANGLING_REFERENCE', '/cards/0/links/1/targetCardId'],
        ['DUPLICATE_LINK', '/cards/0/links/1/targetCardId'],
      ]);

      // Both ids break the id pattern, and the second one is also a duplicate.
      const dupId = stack([card('a', { objects: [field('BAD'), field('BAD')] })]);
      expect(run(dupId)).toEqual([
        ['INVALID_VALUE', '/cards/0/objects/0/id'],
        ['DUPLICATE_ID', '/cards/0/objects/1/id'],
        ['INVALID_VALUE', '/cards/0/objects/1/id'],
      ]);
    });

    it('returns the same order on every call', () => {
      const candidate = stack(
        [
          card('a', {
            objects: [field('f', { x: 150 }), field('f')],
            onOpen: [{ type: 'go_to_card', cardId: 'zzz', extra: 1 }],
          }),
        ],
        { startCardId: 'ghost' },
      );
      expect(run(candidate)).toEqual(run(candidate));
      expect(run(candidate).length).toBeGreaterThan(3);
    });
  });
});

describe('validateHandler: semantic rules end to end', () => {
  const typed = StackSchema.parse(
    stack([
      card('a', { objects: [field('f'), list('l'), button('b')] }),
      card('b2', { objects: [field('g')] }),
    ]),
  );
  const handlerRun = (handler: unknown): [string, string][] =>
    validateHandler(typed, handler).errors.map((error) => [error.code, error.path]);

  it('accepts every Action type, with ids from any Card in the stack', () => {
    expect(
      handlerRun([
        { type: 'go_to_card', cardId: 'b2' },
        { type: 'set_value', targetObjectId: 'g', fromObjectId: 'l' },
        { type: 'append_item', targetObjectId: 'l', fromObjectId: 'g' },
        { type: 'show_message', text: 'ok' },
      ]),
    ).toEqual([]);
  });

  it('reports dangling and wrong-kind references at the property, relative to the Handler', () => {
    expect(
      handlerRun([
        { type: 'go_to_card', cardId: 'gone' },
        { type: 'go_to_card', cardId: 'f' },
        { type: 'set_value', targetObjectId: 'l', fromObjectId: 'b' },
        { type: 'append_item', targetObjectId: 'f', fromObjectId: 'l' },
      ]),
    ).toEqual([
      ['DANGLING_REFERENCE', '/0/cardId'],
      ['WRONG_REFERENCE_TYPE', '/1/cardId'],
      ['WRONG_REFERENCE_TYPE', '/2/targetObjectId'],
      ['WRONG_REFERENCE_TYPE', '/2/fromObjectId'],
      ['WRONG_REFERENCE_TYPE', '/3/targetObjectId'],
      ['WRONG_REFERENCE_TYPE', '/3/fromObjectId'],
    ]);
  });

  it('reports exactly-one-of violations at the Action', () => {
    expect(
      handlerRun([
        { type: 'set_value', targetObjectId: 'f', value: 'x', fromObjectId: 'l' },
        { type: 'append_item', targetObjectId: 'l' },
      ]),
    ).toEqual([
      ['INVALID_VALUE', '/0'],
      ['INVALID_VALUE', '/1'],
    ]);
  });

  it('merges structural and semantic errors in the order of the candidate', () => {
    expect(
      handlerRun([{ type: 'set_value', targetObjectId: 'gone', value: 'x', extra: 1 }]),
    ).toEqual([
      ['DANGLING_REFERENCE', '/0/targetObjectId'],
      ['UNKNOWN_PROPERTY', '/0/extra'],
    ]);
  });

  it('keeps checking references when the Handler is over the 20-action limit', () => {
    const actions = Array.from({ length: 21 }, () => ({ type: 'go_to_card', cardId: 'gone' }));
    const errors = validateHandler(typed, actions).errors;
    expect(errors[0]).toMatchObject({ code: 'LIMIT_EXCEEDED', path: '' });
    expect(errors).toHaveLength(22);
    expect(errors[1]).toMatchObject({ code: 'DANGLING_REFERENCE', path: '/0/cardId' });
  });

  it('skips an Action of an unknown type for the semantic rules, reporting only the type', () => {
    expect(handlerRun([{ type: 'nope', targetObjectId: 'gone' }])).toEqual([
      ['INVALID_VALUE', '/0/type'],
    ]);
  });

  it('checks the references of the five new Actions', () => {
    expect(
      handlerRun([
        { type: 'remove_item', targetObjectId: 'f', index: 0 },
        { type: 'run_ai_field', targetObjectId: 'gone' },
        { type: 'fetch_news', targetObjectId: 'f', topics: ['x'] },
        { type: 'transcribe_audio', targetObjectId: 'l' },
        { type: 'schedule_notification', message: 'm', atFromObjectId: 'l' },
      ]),
    ).toEqual([
      ['WRONG_REFERENCE_TYPE', '/0/targetObjectId'],
      ['DANGLING_REFERENCE', '/1/targetObjectId'],
      ['WRONG_REFERENCE_TYPE', '/2/targetObjectId'],
      ['WRONG_REFERENCE_TYPE', '/3/targetObjectId'],
      ['WRONG_REFERENCE_TYPE', '/4/atFromObjectId'],
    ]);
  });
});
