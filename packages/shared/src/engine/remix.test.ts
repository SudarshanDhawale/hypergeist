import { describe, expect, it } from 'vitest';
import { serializeStack, validateStack } from '../format/index.ts';
import type { Stack } from '../format/index.ts';
import { remixStack } from './remix.ts';

const frame = { x: 10, y: 10, width: 100, height: 30 };

function makeStack(extra: { readonly remixedFrom?: string } = {}): Stack {
  return {
    formatVersion: 1,
    id: 'original',
    name: 'Original',
    cardWidth: 512,
    cardHeight: 342,
    startCardId: 'card-1',
    ...extra,
    cards: [
      {
        id: 'card-1',
        name: 'One',
        objects: [
          {
            id: 'go',
            type: 'button',
            name: 'Go',
            ...frame,
            label: 'Go',
            onClick: [{ type: 'go_to_card', cardId: 'card-2' }],
          },
          {
            id: 'note',
            type: 'field',
            name: 'Note',
            ...frame,
            y: 50,
            value: 'hello',
            placeholder: '',
            multiline: false,
            readOnly: false,
          },
        ],
        links: [{ id: 'link-1', label: 'Next', targetCardId: 'card-2' }],
        onOpen: [{ type: 'show_message', text: 'Welcome' }],
      },
      {
        id: 'card-2',
        name: 'Two',
        objects: [
          {
            id: 'items',
            type: 'list',
            name: 'Items',
            ...frame,
            items: ['a', 'b'],
            ordered: false,
          },
        ],
        links: [],
        onOpen: [],
      },
    ],
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function remixed(stack: unknown, newId: unknown): Stack {
  const result = remixStack(stack, newId);
  if (!result.ok) {
    throw new Error(`expected a remixed Stack, got ${JSON.stringify(result.errors)}`);
  }
  return result.stack;
}

describe('remixStack', () => {
  it('sets the new id and remixedFrom and keeps every other field deeply equal', () => {
    const input = makeStack();
    const output = remixed(input, 'copy');
    expect(output.id).toBe('copy');
    expect(output.remixedFrom).toBe('original');
    expect(output).toEqual({ ...input, id: 'copy', remixedFrom: 'original' });
    expect(output.cards).toEqual(input.cards);
    expect(validateStack(output).valid).toBe(true);
  });

  it('writes keys in canonical order, so JSON.stringify equals the canonical serialization', () => {
    const output = remixed(makeStack(), 'copy');
    expect(Object.keys(output)).toEqual([
      'formatVersion',
      'id',
      'name',
      'cardWidth',
      'cardHeight',
      'startCardId',
      'remixedFrom',
      'cards',
    ]);
    const serialized = serializeStack(output);
    expect(serialized.ok).toBe(true);
    if (serialized.ok) {
      expect(serialized.value).toBe(`${JSON.stringify(output, null, 2)}\n`);
    }
  });

  it('replaces an existing remixedFrom with the id of the Stack being remixed', () => {
    const output = remixed(makeStack({ remixedFrom: 'ancestor' }), 'copy');
    expect(output.id).toBe('copy');
    expect(output.remixedFrom).toBe('original');
  });

  it('accepts the same id as the old one', () => {
    const output = remixed(makeStack(), 'original');
    expect(output.id).toBe('original');
    expect(output.remixedFrom).toBe('original');
    expect(validateStack(output).valid).toBe(true);
  });

  it('keeps every Card, Object and Link id', () => {
    const input = makeStack();
    const output = remixed(input, 'copy');
    const ids = (stack: Stack): string[] =>
      stack.cards.flatMap((card) => [
        card.id,
        ...card.objects.map((object) => object.id),
        ...card.links.map((link) => link.id),
      ]);
    expect(ids(output)).toEqual(ids(input));
    expect(output.startCardId).toBe(input.startCardId);
  });

  it('accepts ids at the pattern boundaries', () => {
    expect(remixed(makeStack(), '0').id).toBe('0');
    expect(remixed(makeStack(), `a${'b'.repeat(63)}`).id).toBe(`a${'b'.repeat(63)}`);
  });

  it('accepts JSON text for the Stack, as validateStack does', () => {
    const output = remixed(JSON.stringify(makeStack()), 'copy');
    expect(output.remixedFrom).toBe('original');
  });

  it.each([
    ['empty', ''],
    ['uppercase', 'Copy'],
    ['leading dash', '-copy'],
    ['leading underscore', '_copy'],
    ['space', 'my copy'],
    ['65 characters', `a${'b'.repeat(64)}`],
    ['non-ASCII', 'café'],
    ['trailing newline', 'copy\n'],
  ])('rejects a new id with a bad pattern (%s)', (_label, newId) => {
    const result = remixStack(makeStack(), newId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.code).toBe('INVALID_VALUE');
      expect(result.errors[0]?.path).toBe('/newId');
    }
    expect('stack' in result).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 7],
    ['an object', { id: 'copy' }],
    ['an array', ['copy']],
  ])('rejects a non-string new id (%s)', (_label, newId) => {
    const result = remixStack(makeStack(), newId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.code).toBe('INVALID_VALUE');
      expect(result.errors[0]?.path).toBe('/newId');
    }
    expect('stack' in result).toBe(false);
  });

  it('returns exactly the validateStack errors for an invalid Stack, and no Stack', () => {
    const broken = { ...makeStack(), startCardId: 'missing' };
    const expected = validateStack(broken);
    expect(expected.valid).toBe(false);
    const result = remixStack(broken, 'copy');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expected.errors);
    }
    expect('stack' in result).toBe(false);
  });

  it.each([
    ['null', null],
    ['a number', 3],
    ['an array', []],
    ['text that is not JSON', '{nope'],
  ])('returns the validateStack errors for a non-Stack value (%s)', (_label, value) => {
    const expected = validateStack(value);
    const result = remixStack(value, 'copy');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expected.errors);
    }
  });

  it('does not throw on a cyclic value and returns validator errors', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const result = remixStack(cyclic, 'copy');
    expect(result.ok).toBe(false);
  });

  it('reports only the newId error when both arguments are bad', () => {
    const result = remixStack({ nonsense: true }, 'Bad Id');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.path).toBe('/newId');
    }
  });

  it('leaves a deeply frozen input unmodified and returns a result that shares nothing with it', () => {
    const input = deepFreeze(makeStack());
    const before = JSON.stringify(input);
    const output = remixed(input, 'copy');
    expect(JSON.stringify(input)).toBe(before);
    expect(output.cards).not.toBe(input.cards);
    expect(Object.isFrozen(output)).toBe(false);
  });

  it('gives deeply equal results for equal calls', () => {
    const input = deepFreeze(makeStack());
    expect(remixStack(input, 'copy')).toEqual(remixStack(input, 'copy'));
  });
});
