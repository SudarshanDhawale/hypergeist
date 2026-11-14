import { describe, expect, it } from 'vitest';
import type { ButtonObject, FieldObject, ListObject, Stack } from '../format/index.ts';
import { findObject, textOf, withObject } from './stack-edit.ts';
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

  it('returns the empty string for a Button', () => {
    expect(textOf(button)).toBe('');
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
