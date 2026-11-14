import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StackSchema } from '../format/index.ts';
import type {
  Action,
  ButtonObject,
  FieldObject,
  Handler,
  ListObject,
  Stack,
  StackObject,
} from '../format/index.ts';
import { executeHandler } from './execute-handler.ts';
import { findObject } from './stack-edit.ts';

const frame = { x: 0, y: 0, width: 100, height: 30 };

function makeField(id: string, value: string, readOnly = false): FieldObject {
  return {
    id,
    type: 'field',
    name: id,
    ...frame,
    value,
    placeholder: '',
    multiline: false,
    readOnly,
  };
}

function makeList(id: string, items: readonly string[]): ListObject {
  return { id, type: 'list', name: 'Items', ...frame, items: [...items], ordered: false };
}

function makeButton(id: string): ButtonObject {
  return { id, type: 'button', name: id, ...frame, label: 'Go', onClick: [] };
}

function makeStack(objects?: readonly StackObject[]): Stack {
  return {
    formatVersion: 1,
    id: 's',
    name: 'S',
    cardWidth: 512,
    cardHeight: 342,
    startCardId: 'c1',
    cards: [
      {
        id: 'c1',
        name: 'One',
        objects: [
          makeButton('go'),
          makeField('note', 'hello'),
          makeField('out', ''),
          makeList('items', ['a', 'b', 'c']),
          makeList('empty', []),
          ...(objects ?? []),
        ],
        links: [],
        onOpen: [],
      },
      { id: 'c2', name: 'Two', objects: [], links: [], onOpen: [] },
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

function fieldValue(stack: Stack, id: string): string | undefined {
  const object = findObject(stack, id);
  return object?.type === 'field' ? object.value : undefined;
}

function listItems(stack: Stack, id: string): readonly string[] | undefined {
  const object = findObject(stack, id);
  return object?.type === 'list' ? object.items : undefined;
}

describe('executeHandler: set_value', () => {
  it('sets a Field to a literal value', () => {
    const stack = makeStack();
    const result = executeHandler(stack, [
      { type: 'set_value', targetObjectId: 'out', value: 'literal' },
    ]);
    expect(fieldValue(result.stack, 'out')).toBe('literal');
    expect(fieldValue(result.stack, 'note')).toBe('hello');
    expect(result.messages).toEqual([]);
    expect(result).not.toHaveProperty('navigateTo');
    expect(result.effects).toEqual([]);
  });

  it('sets a Field to the empty string', () => {
    const result = executeHandler(makeStack(), [
      { type: 'set_value', targetObjectId: 'note', value: '' },
    ]);
    expect(fieldValue(result.stack, 'note')).toBe('');
    expect(result.messages).toEqual([]);
  });

  it('copies the value of another Field with fromObjectId', () => {
    const result = executeHandler(makeStack(), [
      { type: 'set_value', targetObjectId: 'out', fromObjectId: 'note' },
    ]);
    expect(fieldValue(result.stack, 'out')).toBe('hello');
    expect(result.messages).toEqual([]);
    expect(result.effects).toEqual([]);
  });

  it('copies a List with its items joined by newline characters', () => {
    const result = executeHandler(makeStack(), [
      { type: 'set_value', targetObjectId: 'out', fromObjectId: 'items' },
    ]);
    expect(fieldValue(result.stack, 'out')).toBe('a\nb\nc');
    expect(listItems(result.stack, 'items')).toEqual(['a', 'b', 'c']);
  });

  it('copies an empty List as the empty string', () => {
    const result = executeHandler(makeStack(), [
      { type: 'set_value', targetObjectId: 'note', fromObjectId: 'empty' },
    ]);
    expect(fieldValue(result.stack, 'note')).toBe('');
  });

  it('skips the action when the joined List text exceeds 10,000 characters', () => {
    const longItems = Array.from({ length: 500 }, () => 'x'.repeat(20));
    const stack = makeStack([makeList('long', longItems)]);
    const result = executeHandler(stack, [
      { type: 'set_value', targetObjectId: 'out', fromObjectId: 'long' },
      { type: 'show_message', text: 'after' },
    ]);
    expect(fieldValue(result.stack, 'out')).toBe('');
    expect(result.stack).toEqual(stack);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatch(/^Skipped action 1 \(set_value\)/);
    expect(result.messages[1]).toBe('after');
  });

  it('accepts a joined List text of exactly 10,000 characters', () => {
    // 499 newline separators plus 9,501 characters of item text: 499 items of 19 and one of 20.
    const items = Array.from({ length: 500 }, (_, i) => 'x'.repeat(i === 0 ? 20 : 19));
    const stack = makeStack([makeList('edge', items)]);
    expect(items.join('\n')).toHaveLength(10_000);
    const result = executeHandler(stack, [
      { type: 'set_value', targetObjectId: 'out', fromObjectId: 'edge' },
    ]);
    expect(fieldValue(result.stack, 'out')).toHaveLength(10_000);
    expect(result.messages).toEqual([]);
  });
});

describe('executeHandler: append_item', () => {
  it('appends a literal item to the end of the List', () => {
    const result = executeHandler(makeStack(), [
      { type: 'append_item', targetObjectId: 'items', item: 'd' },
    ]);
    expect(listItems(result.stack, 'items')).toEqual(['a', 'b', 'c', 'd']);
    expect(result.messages).toEqual([]);
    expect(result).not.toHaveProperty('navigateTo');
    expect(result.effects).toEqual([]);
  });

  it('appends an empty literal item', () => {
    const result = executeHandler(makeStack(), [
      { type: 'append_item', targetObjectId: 'empty', item: '' },
    ]);
    expect(listItems(result.stack, 'empty')).toEqual(['']);
  });

  it('appends the current text of a Field with fromObjectId', () => {
    const result = executeHandler(makeStack(), [
      { type: 'append_item', targetObjectId: 'items', fromObjectId: 'note' },
    ]);
    expect(listItems(result.stack, 'items')).toEqual(['a', 'b', 'c', 'hello']);
    expect(fieldValue(result.stack, 'note')).toBe('hello');
    expect(result.messages).toEqual([]);
  });

  it('appends in action order when several Actions target the same List', () => {
    const result = executeHandler(makeStack(), [
      { type: 'append_item', targetObjectId: 'empty', item: '1' },
      { type: 'append_item', targetObjectId: 'empty', item: '2' },
      { type: 'append_item', targetObjectId: 'empty', fromObjectId: 'note' },
    ]);
    expect(listItems(result.stack, 'empty')).toEqual(['1', '2', 'hello']);
  });

  it('appends the 500th item and then reports the List as full', () => {
    const stack = makeStack([
      makeList(
        'big',
        Array.from({ length: 499 }, () => 'i'),
      ),
    ]);
    const first = executeHandler(stack, [
      { type: 'append_item', targetObjectId: 'big', item: 'z' },
    ]);
    expect(listItems(first.stack, 'big')).toHaveLength(500);
    expect(first.messages).toEqual([]);
  });

  it('leaves a List of 500 items unchanged and adds a "full" message', () => {
    const stack = makeStack([
      makeList(
        'big',
        Array.from({ length: 500 }, () => 'i'),
      ),
    ]);
    const result = executeHandler(stack, [
      { type: 'append_item', targetObjectId: 'big', item: 'z' },
      { type: 'show_message', text: 'after' },
    ]);
    expect(result.stack).toEqual(stack);
    expect(listItems(result.stack, 'big')).toHaveLength(500);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatch(/full/);
    expect(result.messages[0]).toContain('500');
    expect(result.messages[1]).toBe('after');
    expect(result.effects).toEqual([]);
  });

  it('skips the action when a Field longer than 500 characters is appended', () => {
    const stack = makeStack([makeField('long', 'x'.repeat(501))]);
    const result = executeHandler(stack, [
      { type: 'append_item', targetObjectId: 'items', fromObjectId: 'long' },
      { type: 'append_item', targetObjectId: 'items', item: 'next' },
    ]);
    expect(listItems(result.stack, 'items')).toEqual(['a', 'b', 'c', 'next']);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/^Skipped action 1 \(append_item\)/);
  });

  it('accepts a Field of exactly 500 characters', () => {
    const stack = makeStack([makeField('edge', 'x'.repeat(500))]);
    const result = executeHandler(stack, [
      { type: 'append_item', targetObjectId: 'empty', fromObjectId: 'edge' },
    ]);
    expect(listItems(result.stack, 'empty')).toEqual(['x'.repeat(500)]);
    expect(result.messages).toEqual([]);
  });
});

describe('executeHandler: show_message and go_to_card', () => {
  it('collects show_message texts in action order', () => {
    const result = executeHandler(makeStack(), [
      { type: 'show_message', text: 'first' },
      { type: 'set_value', targetObjectId: 'out', value: 'v' },
      { type: 'show_message', text: 'second' },
      { type: 'show_message', text: 'third' },
    ]);
    expect(result.messages).toEqual(['first', 'second', 'third']);
    expect(fieldValue(result.stack, 'out')).toBe('v');
    expect(result).not.toHaveProperty('navigateTo');
    expect(result.effects).toEqual([]);
  });

  it('orders skip messages among show_message texts by action position', () => {
    const stack = makeStack([makeField('long', 'x'.repeat(501))]);
    const result = executeHandler(stack, [
      { type: 'show_message', text: 'one' },
      { type: 'append_item', targetObjectId: 'items', fromObjectId: 'long' },
      { type: 'show_message', text: 'three' },
    ]);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toBe('one');
    expect(result.messages[1]).toMatch(/^Skipped action 2 \(append_item\)/);
    expect(result.messages[2]).toBe('three');
  });

  it('sets navigateTo and returns the Stack unchanged for a lone go_to_card', () => {
    const stack = makeStack();
    const result = executeHandler(stack, [{ type: 'go_to_card', cardId: 'c2' }]);
    expect(result.navigateTo).toBe('c2');
    expect(result.stack).toEqual(stack);
    expect(result.messages).toEqual([]);
    expect(result.effects).toEqual([]);
  });

  it('keeps earlier changes and messages and skips the Actions after go_to_card', () => {
    const result = executeHandler(makeStack(), [
      { type: 'set_value', targetObjectId: 'out', value: 'kept' },
      { type: 'append_item', targetObjectId: 'empty', item: 'kept' },
      { type: 'show_message', text: 'before' },
      { type: 'go_to_card', cardId: 'c2' },
      { type: 'set_value', targetObjectId: 'out', value: 'dropped' },
      { type: 'append_item', targetObjectId: 'empty', item: 'dropped' },
      { type: 'show_message', text: 'after' },
      { type: 'go_to_card', cardId: 'c1' },
    ]);
    expect(result.navigateTo).toBe('c2');
    expect(fieldValue(result.stack, 'out')).toBe('kept');
    expect(listItems(result.stack, 'empty')).toEqual(['kept']);
    expect(result.messages).toEqual(['before']);
    expect(result.effects).toEqual([]);
  });
});

describe('executeHandler: empty Handler', () => {
  it('returns an equal Stack, no messages, no effects, and no navigateTo', () => {
    const stack = makeStack();
    const result = executeHandler(stack, []);
    expect(result.stack).toEqual(stack);
    expect(result.messages).toEqual([]);
    expect(result.effects).toEqual([]);
    expect(result).not.toHaveProperty('navigateTo');
  });
});

describe('executeHandler: skipped actions', () => {
  it('keeps earlier results and reports the position of a skipped set_value', () => {
    const items = Array.from({ length: 500 }, () => 'y'.repeat(20));
    const stack = makeStack([makeList('long', items)]);
    const result = executeHandler(stack, [
      { type: 'set_value', targetObjectId: 'note', value: 'ok' },
      { type: 'set_value', targetObjectId: 'out', fromObjectId: 'long' },
      { type: 'show_message', text: 'done' },
    ]);
    expect(fieldValue(result.stack, 'note')).toBe('ok');
    expect(fieldValue(result.stack, 'out')).toBe('');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatch(/^Skipped action 2 \(set_value\)/);
    expect(result.messages[1]).toBe('done');
  });

  it('puts each skip message on its own entry', () => {
    const stack = makeStack([makeField('long', 'x'.repeat(501))]);
    const result = executeHandler(stack, [
      { type: 'append_item', targetObjectId: 'items', fromObjectId: 'long' },
      { type: 'append_item', targetObjectId: 'empty', fromObjectId: 'long' },
    ]);
    expect(result.stack).toEqual(stack);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatch(/^Skipped action 1 /);
    expect(result.messages[1]).toMatch(/^Skipped action 2 /);
  });
});

describe('executeHandler: invalid input', () => {
  it('runs nothing and reports an invalid Stack', () => {
    const stack: Stack = { ...makeStack(), startCardId: 'missing' };
    const result = executeHandler(stack, [
      { type: 'set_value', targetObjectId: 'out', value: 'x' },
      { type: 'go_to_card', cardId: 'c2' },
    ]);
    expect(result.stack).toBe(stack);
    expect(result.effects).toEqual([]);
    expect(result).not.toHaveProperty('navigateTo');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/stack is not valid/i);
  });

  it('runs nothing and reports an invalid Handler', () => {
    const stack = makeStack();
    const handler: Handler = [
      { type: 'set_value', targetObjectId: 'out', value: 'x' },
      { type: 'go_to_card', cardId: 'nowhere' },
    ];
    const result = executeHandler(stack, handler);
    expect(result.stack).toBe(stack);
    expect(fieldValue(result.stack, 'out')).toBe('');
    expect(result.effects).toEqual([]);
    expect(result).not.toHaveProperty('navigateTo');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/handler is not valid/i);
  });

  it('rejects a Handler whose reference has the wrong kind', () => {
    const stack = makeStack();
    const result = executeHandler(stack, [
      { type: 'append_item', targetObjectId: 'note', item: 'x' },
    ]);
    expect(result.stack).toBe(stack);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/handler is not valid/i);
  });

  it('rejects a Handler with more than 20 Actions', () => {
    const stack = makeStack();
    const handler: Action[] = Array.from({ length: 21 }, () => ({
      type: 'show_message',
      text: 'm',
    }));
    const result = executeHandler(stack, handler);
    expect(result.stack).toBe(stack);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/handler is not valid/i);
  });
});

describe('executeHandler: purity', () => {
  it('does not mutate deeply frozen inputs and returns a new Stack', () => {
    const stack = deepFreeze(makeStack());
    const handler: Handler = deepFreeze([
      { type: 'append_item', targetObjectId: 'items', fromObjectId: 'note' },
      { type: 'set_value', targetObjectId: 'out', fromObjectId: 'items' },
      { type: 'show_message', text: 'done' },
      { type: 'go_to_card', cardId: 'c2' },
    ] satisfies Action[]);
    const stackBefore = structuredClone(stack);
    const handlerBefore = structuredClone(handler);

    const result = executeHandler(stack, handler);

    expect(stack).toEqual(stackBefore);
    expect(handler).toEqual(handlerBefore);
    expect(result.stack).not.toBe(stack);
    expect(listItems(result.stack, 'items')).toEqual(['a', 'b', 'c', 'hello']);
    expect(fieldValue(result.stack, 'out')).toBe('a\nb\nc\nhello');
    expect(result.navigateTo).toBe('c2');
    expect(result.messages).toEqual(['done']);
    expect(result.effects).toEqual([]);
  });

  it('does not mutate frozen inputs on the invalid-input paths', () => {
    const stack = deepFreeze(makeStack());
    const handler: Handler = deepFreeze([
      { type: 'go_to_card', cardId: 'nowhere' },
    ] satisfies Action[]);
    expect(() => executeHandler(stack, handler)).not.toThrow();
  });

  it('returns deeply equal results for repeated calls', () => {
    const stack = makeStack();
    const handler: Handler = [
      { type: 'append_item', targetObjectId: 'items', item: 'd' },
      { type: 'show_message', text: 'm' },
    ];
    expect(executeHandler(stack, handler)).toEqual(executeHandler(stack, handler));
  });

  it('always returns an empty effects array', () => {
    const handlers: Handler[] = [
      [],
      [{ type: 'show_message', text: 'm' }],
      [{ type: 'go_to_card', cardId: 'c2' }],
      [{ type: 'set_value', targetObjectId: 'out', value: 'v' }],
      [{ type: 'append_item', targetObjectId: 'items', item: 'd' }],
      [{ type: 'go_to_card', cardId: 'nowhere' }],
    ];
    for (const handler of handlers) {
      expect(executeHandler(makeStack(), handler).effects).toEqual([]);
    }
    expect(executeHandler({ ...makeStack(), startCardId: 'missing' }, []).effects).toEqual([]);
  });
});

describe('executeHandler: Demo_Stack Add button', () => {
  const text = readFileSync(
    new URL('../../../../apps/web/src/stacks/thin-slice-todo.json', import.meta.url),
    'utf8',
  );
  const demo = StackSchema.parse(JSON.parse(text));

  function addHandler(stack: Stack): Handler {
    const button = findObject(stack, 'todo-add');
    if (button?.type !== 'button') {
      throw new Error('The Demo_Stack has no Add button.');
    }
    return button.onClick;
  }

  function withInput(stack: Stack, value: string): Stack {
    return {
      ...stack,
      cards: stack.cards.map((card) => ({
        ...card,
        objects: card.objects.map((object) =>
          object.id === 'todo-input' && object.type === 'field' ? { ...object, value } : object,
        ),
      })),
    };
  }

  it('has the append, clear, message handler', () => {
    expect(addHandler(demo).map((action) => action.type)).toEqual([
      'append_item',
      'set_value',
      'show_message',
    ]);
  });

  it('appends the typed text, clears the Field, and reports "Item added."', () => {
    const typed = deepFreeze(withInput(demo, 'Buy milk'));
    const result = executeHandler(typed, deepFreeze(structuredClone(addHandler(demo))));
    expect(listItems(result.stack, 'todo-list')).toEqual(['Buy milk']);
    expect(fieldValue(result.stack, 'todo-input')).toBe('');
    expect(result.messages).toEqual(['Item added.']);
    expect(result).not.toHaveProperty('navigateTo');
    expect(result.effects).toEqual([]);
  });

  it('appends in order across repeated presses', () => {
    const first = executeHandler(withInput(demo, 'one'), addHandler(demo));
    const second = executeHandler(withInput(first.stack, 'two'), addHandler(demo));
    expect(listItems(second.stack, 'todo-list')).toEqual(['one', 'two']);
    expect(fieldValue(second.stack, 'todo-input')).toBe('');
  });

  it('appends an empty item when the Field is empty', () => {
    const result = executeHandler(demo, addHandler(demo));
    expect(listItems(result.stack, 'todo-list')).toEqual(['']);
    expect(result.messages).toEqual(['Item added.']);
  });

  it('navigates with the About card Back button', () => {
    const back = findObject(demo, 'about-back');
    if (back?.type !== 'button') {
      throw new Error('The Demo_Stack has no Back button.');
    }
    const result = executeHandler(demo, back.onClick);
    expect(result.navigateTo).toBe('todo');
    expect(result.stack).toEqual(demo);
    expect(result.messages).toEqual([]);
  });
});
