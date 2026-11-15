import { describe, expect, it } from 'vitest';
import type {
  AiFieldObject,
  ButtonObject,
  FieldObject,
  ListObject,
  Stack,
} from '../format/index.ts';
import { findCard, findObject, textOf, withCard, withObject } from './stack-edit.ts';
import type { ExecutionResult } from './types.ts';

const frame = { x: 0, y: 0, width: 100, height: 30 };

const button: ButtonObject = {
  id: 'go',
  type: 'button',
  name: 'Go',
  ...frame,
  label: 'Go',
  onClick: [],
};
const field: FieldObject = {
  id: 'note',
  type: 'field',
  name: 'Note',
  ...frame,
  value: 'hello',
  placeholder: '',
  multiline: false,
  readOnly: false,
};
const list: ListObject = {
  id: 'items',
  type: 'list',
  name: 'Items',
  ...frame,
  items: ['a', 'b', 'c'],
  ordered: false,
};
const otherField: FieldObject = { ...field, id: 'other', value: 'x' };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function makeStack(): Stack {
  return {
    formatVersion: 1,
    id: 's',
    name: 'S',
    cardWidth: 512,
    cardHeight: 342,
    startCardId: 'c1',
    cards: [
      { id: 'c1', name: 'One', objects: [button, field], links: [], onOpen: [] },
      { id: 'c2', name: 'Two', objects: [list, otherField], links: [], onOpen: [] },
    ],
  };
}

describe('findObject', () => {
  it('finds an Object on any Card by id', () => {
    const stack = makeStack();
    expect(findObject(stack, 'note')).toBe(field);
    expect(findObject(stack, 'items')).toBe(list);
  });

  it('returns undefined for an unknown id or a Card id', () => {
    const stack = makeStack();
    expect(findObject(stack, 'nope')).toBeUndefined();
    expect(findObject(stack, 'c1')).toBeUndefined();
  });
});

describe('withObject', () => {
  it('replaces the target and keeps the other Objects and Cards by identity', () => {
    const stack = deepFreeze(makeStack());
    const edited: FieldObject = { ...field, value: 'changed' };
    const next = withObject(stack, field, edited);

    expect(findObject(next, 'note')).toBe(edited);
    expect(next.cards[0]?.objects[0]).toBe(stack.cards[0]?.objects[0]);
    expect(next.cards[1]).toBe(stack.cards[1]);
    expect(next.cards[0]).not.toBe(stack.cards[0]);
    expect(next).not.toBe(stack);
  });

  it('does not write to its inputs', () => {
    const stack = makeStack();
    const before = structuredClone(stack);
    withObject(stack, list, { ...list, items: [...list.items, 'd'] });
    expect(stack).toEqual(before);
  });

  it('returns the same Stack when no Object has the target id', () => {
    const stack = makeStack();
    expect(withObject(stack, { ...field, id: 'missing' }, field)).toBe(stack);
  });

  it('replaces only the first Object when ids repeat', () => {
    const dup: Stack = {
      ...makeStack(),
      cards: [
        { id: 'c1', name: 'One', objects: [field], links: [], onOpen: [] },
        { id: 'c2', name: 'Two', objects: [{ ...field }], links: [], onOpen: [] },
      ],
    };
    const next = withObject(dup, field, { ...field, value: 'first' });
    expect(next.cards.map((card) => card.objects.map(textOf))).toEqual([['first'], ['hello']]);
  });
});

describe('textOf', () => {
  it('joins List items with newline characters', () => {
    expect(textOf(list)).toBe('a\nb\nc');
    expect(textOf({ ...list, items: [] })).toBe('');
    expect(textOf({ ...list, items: ['only'] })).toBe('only');
  });

  it('returns the value of a Field', () => {
    expect(textOf(field)).toBe('hello');
    expect(textOf({ ...field, value: '' })).toBe('');
  });

  it('returns the value of an AI field', () => {
    const aiField: AiFieldObject = {
      id: 'ask',
      type: 'ai-field',
      name: 'Ask',
      ...frame,
      prompt: 'Summarize',
      inputObjectIds: [],
      value: 'an answer',
    };
    expect(textOf(aiField)).toBe('an answer');
    expect(textOf({ ...aiField, value: '' })).toBe('');
  });

  it('returns the empty string for a Button', () => {
    expect(textOf(button)).toBe('');
  });
});

describe('findCard', () => {
  it('finds a Card by id', () => {
    const stack = makeStack();
    expect(findCard(stack, 'c1')).toBe(stack.cards[0]);
    expect(findCard(stack, 'c2')).toBe(stack.cards[1]);
  });

  it('returns undefined for an unknown id or an Object id', () => {
    const stack = deepFreeze(makeStack());
    expect(findCard(stack, 'nope')).toBeUndefined();
    expect(findCard(stack, 'note')).toBeUndefined();
  });
});

describe('withCard', () => {
  it('replaces the Card at the index and keeps the other Cards by identity', () => {
    const stack = deepFreeze(makeStack());
    const replacement = { id: 'c2', name: 'Renamed', objects: [], links: [], onOpen: [] };
    const next = withCard(stack, 1, replacement);

    expect(next).not.toBe(stack);
    expect(next.cards[1]).toBe(replacement);
    expect(next.cards[0]).toBe(stack.cards[0]);
    expect(next.cards).toHaveLength(2);
    expect(next.id).toBe(stack.id);
    expect(next.startCardId).toBe(stack.startCardId);
  });

  it('does not write to its inputs', () => {
    const stack = makeStack();
    const before = structuredClone(stack);
    const card = stack.cards[0];
    withCard(stack, 0, { ...(card as NonNullable<typeof card>), name: 'Changed' });
    expect(stack).toEqual(before);
    expect(
      withCard(deepFreeze(makeStack()), 0, {
        id: 'c1',
        name: 'X',
        objects: [],
        links: [],
        onOpen: [],
      }).cards[0]?.name,
    ).toBe('X');
  });

  it('returns the same Stack for an index that is out of range', () => {
    const stack = makeStack();
    const card = { id: 'c3', name: 'Three', objects: [], links: [], onOpen: [] };
    expect(withCard(stack, 2, card)).toBe(stack);
    expect(withCard(stack, -1, card)).toBe(stack);
  });
});

describe('ExecutionResult', () => {
  it('accepts the executor result shape with an empty effects array', () => {
    const withNav: ExecutionResult = {
      stack: makeStack(),
      effects: [],
      navigateTo: 'c2',
      messages: ['m'],
    };
    const withoutNav: ExecutionResult = { stack: makeStack(), effects: [], messages: [] };
    expect(withNav.effects).toEqual([]);
    expect('navigateTo' in withoutNav).toBe(false);
  });
});
