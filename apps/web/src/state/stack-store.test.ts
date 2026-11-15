import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as engine from '@hypergeist/shared/engine';
import type { Handler, Stack } from '@hypergeist/shared/format';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { loadStack } from '../stacks/load-stack.ts';
import { createStackStore } from './stack-store.ts';

// Wrap the real executor in a spy so the tests can see when the store calls it.
vi.mock('@hypergeist/shared/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hypergeist/shared/engine')>();
  return { ...actual, executeHandler: vi.fn(actual.executeHandler) };
});

const executeSpy = vi.mocked(engine.executeHandler);

function demoStack(): Stack {
  const loaded = loadStack(demoText);
  if (!loaded.ok) throw new Error('Demo_Stack must be valid');
  return loaded.stack;
}

function demoStore() {
  return createStackStore(demoStack());
}

/** Demo stack whose Add button runs `onClick` instead of its own Handler. */
function stackWithAddHandler(onClick: Handler): Stack {
  const stack = demoStack();
  return {
    ...stack,
    cards: stack.cards.map((card) => ({
      ...card,
      objects: card.objects.map((object) =>
        object.id === 'todo-add' && object.type === 'button' ? { ...object, onClick } : object,
      ),
    })),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function items(store: ReturnType<typeof demoStore>): readonly string[] | undefined {
  const list = store
    .getState()
    .stack.cards.flatMap((card) => card.objects)
    .find((object) => object.id === 'todo-list');
  return list?.type === 'list' ? list.items : undefined;
}

function fieldValue(store: ReturnType<typeof demoStore>, id: string): string | undefined {
  const field = store
    .getState()
    .stack.cards.flatMap((card) => card.objects)
    .find((object) => object.id === id);
  return field?.type === 'field' ? field.value : undefined;
}

beforeEach(() => {
  executeSpy.mockClear();
});

describe('initial state', () => {
  it('starts on the start card in Interact mode with nothing selected and no status', () => {
    const state = demoStore().getState();
    expect(state.currentCardId).toBe('todo');
    expect(state.mode).toBe('interact');
    expect(state.selectedObjectId).toBeNull();
    expect(state.status).toBeNull();
    expect(state.statusSeq).toBe(0);
  });
});

describe('mode changes', () => {
  it('toggleMode switches between Interact and Edit', () => {
    const store = demoStore();
    store.getState().toggleMode();
    expect(store.getState().mode).toBe('edit');
    store.getState().toggleMode();
    expect(store.getState().mode).toBe('interact');
  });

  it('clears the selection when the mode changes', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().selectObject('todo-add');
    expect(store.getState().selectedObjectId).toBe('todo-add');
    store.getState().toggleMode();
    expect(store.getState().selectedObjectId).toBeNull();
  });

  it('clears the status when the mode changes, in both directions', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    expect(store.getState().status).not.toBeNull();
    store.getState().setMode('edit');
    expect(store.getState().status).toBeNull();

    store.getState().setMode('interact');
    store.getState().activateButton('todo-add');
    expect(store.getState().status).not.toBeNull();
    store.getState().toggleMode();
    expect(store.getState().status).toBeNull();
  });

  it('clears selection and status even when the mode is set to its current value', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().selectObject('todo-input');
    store.getState().setMode('edit');
    expect(store.getState().selectedObjectId).toBeNull();
  });

  it('keeps the statusSeq counter growing across a mode change', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    store.getState().toggleMode();
    expect(store.getState().statusSeq).toBe(1);
    store.getState().toggleMode();
    store.getState().activateButton('todo-add');
    expect(store.getState().status?.seq).toBe(2);
  });
});

describe('selection', () => {
  it('selects an object on the current card in Edit mode', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().selectObject('todo-list');
    expect(store.getState().selectedObjectId).toBe('todo-list');
    store.getState().selectObject('todo-input');
    expect(store.getState().selectedObjectId).toBe('todo-input');
  });

  it('ignores selection in Interact mode', () => {
    const store = demoStore();
    store.getState().selectObject('todo-add');
    expect(store.getState().selectedObjectId).toBeNull();
  });

  it('ignores an id that is not on the current card', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().selectObject('todo-add');
    store.getState().selectObject('about-text'); // exists, but on another card
    expect(store.getState().selectedObjectId).toBe('todo-add');
    store.getState().selectObject('does-not-exist');
    expect(store.getState().selectedObjectId).toBe('todo-add');
  });

  it('does not select a Link id or a Card id', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().selectObject('todo-link-about');
    store.getState().selectObject('todo');
    expect(store.getState().selectedObjectId).toBeNull();
  });

  it('clearSelection clears in Edit mode and does nothing else', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().selectObject('todo-add');
    store.getState().clearSelection();
    expect(store.getState().selectedObjectId).toBeNull();
    expect(store.getState().mode).toBe('edit');
  });

  it('clearSelection is a no-op in Interact mode', () => {
    const store = demoStore();
    const before = store.getState();
    store.getState().clearSelection();
    expect(store.getState()).toBe(before);
  });
});

describe('Add button flow on the demo stack', () => {
  it('appends the typed text, empties the field, and shows "Item added."', () => {
    const store = demoStore();
    store.getState().typeInField('todo-input', 'Milk');
    expect(fieldValue(store, 'todo-input')).toBe('Milk');

    store.getState().activateButton('todo-add');
    expect(items(store)).toEqual(['Milk']);
    expect(fieldValue(store, 'todo-input')).toBe('');
    expect(store.getState().status).toEqual({ text: 'Item added.', seq: 1 });
    expect(store.getState().currentCardId).toBe('todo');
  });

  it('keeps items in order across several adds and bumps the seq each time', () => {
    const store = demoStore();
    for (const text of ['one', 'two', 'three']) {
      store.getState().typeInField('todo-input', text);
      store.getState().activateButton('todo-add');
    }
    expect(items(store)).toEqual(['one', 'two', 'three']);
    expect(store.getState().status?.seq).toBe(3);
  });

  it('appends an empty item when the field is empty', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    expect(items(store)).toEqual(['']);
  });
});

describe('Interact-only actions', () => {
  it('activateButton does nothing in Edit mode and never calls the executor', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().selectObject('todo-add');
    const before = store.getState();
    store.getState().activateButton('todo-add');
    expect(store.getState()).toBe(before);
    expect(items(store)).toEqual([]);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('typeInField does nothing in Edit mode and never calls the executor', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().typeInField('todo-input', 'Milk');
    expect(fieldValue(store, 'todo-input')).toBe('');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('followLink does nothing in Edit mode', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().followLink('todo-link-about');
    expect(store.getState().currentCardId).toBe('todo');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('typeInField goes through the executor with one set_value', () => {
    const store = demoStore();
    store.getState().typeInField('todo-input', 'Milk');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toEqual([
      { type: 'set_value', targetObjectId: 'todo-input', value: 'Milk' },
    ]);
  });
});

describe('typeInField', () => {
  it('ignores a read-only Field', () => {
    const store = demoStore();
    store.getState().followLink('todo-link-about');
    const before = store.getState();
    store.getState().typeInField('about-text', 'hacked');
    expect(store.getState()).toBe(before);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('ignores ids that are not a Field on the current card', () => {
    const store = demoStore();
    const before = store.getState();
    store.getState().typeInField('todo-add', 'x'); // a button
    store.getState().typeInField('todo-list', 'x'); // a list
    store.getState().typeInField('about-text', 'x'); // a field on another card
    store.getState().typeInField('nope', 'x');
    expect(store.getState()).toBe(before);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('leaves an existing status unchanged because typing returns no messages', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    const status = store.getState().status;
    store.getState().typeInField('todo-input', 'next');
    expect(store.getState().status).toBe(status);
    expect(store.getState().statusSeq).toBe(1);
  });

  it('leaves the status null when none was set', () => {
    const store = demoStore();
    store.getState().typeInField('todo-input', 'a');
    expect(store.getState().status).toBeNull();
    expect(store.getState().statusSeq).toBe(0);
  });
});

describe('invalid actions are ignored', () => {
  it('activateButton ignores unknown ids, non-buttons, and buttons on other cards', () => {
    const store = demoStore();
    const before = store.getState();
    store.getState().activateButton('nope');
    store.getState().activateButton('todo-input');
    store.getState().activateButton('todo-list');
    store.getState().activateButton('about-back');
    expect(store.getState()).toBe(before);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('followLink ignores unknown ids and Links of other cards', () => {
    const store = demoStore();
    const before = store.getState();
    store.getState().followLink('nope');
    store.getState().followLink('about-link-limits');
    expect(store.getState()).toBe(before);
  });

  it('followLink ignores a Link whose target Card does not exist', () => {
    const stack = demoStack();
    const broken: Stack = {
      ...stack,
      cards: stack.cards.map((card) =>
        card.id === 'todo'
          ? {
              ...card,
              links: card.links.map((link) => ({ ...link, targetCardId: 'missing' })),
            }
          : card,
      ),
    };
    const store = createStackStore(broken);
    store.getState().followLink('todo-link-about');
    expect(store.getState().currentCardId).toBe('todo');
  });

  it('keeps the stack unchanged when the executor rejects a handler', () => {
    const invalid: Stack = { ...demoStack(), formatVersion: 2 } as unknown as Stack;
    const store = createStackStore(invalid);
    store.getState().activateButton('todo-add');
    expect(store.getState().stack).toBe(invalid);
  });

  it('selectObject, clearSelection and expireStatus never change the stack', () => {
    const store = demoStore();
    const stack = store.getState().stack;
    store.getState().setMode('edit');
    store.getState().selectObject('todo-add');
    store.getState().clearSelection();
    store.getState().expireStatus(99);
    expect(store.getState().stack).toBe(stack);
  });
});

describe('navigation', () => {
  it('followLink changes the card, and clears the selection and the status', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    expect(store.getState().status).not.toBeNull();

    store.getState().followLink('todo-link-about');
    const state = store.getState();
    expect(state.currentCardId).toBe('about');
    expect(state.selectedObjectId).toBeNull();
    expect(state.status).toBeNull();
  });

  it('follows a chain of Links from card to card', () => {
    const store = demoStore();
    store.getState().followLink('todo-link-about');
    store.getState().followLink('about-link-limits');
    expect(store.getState().currentCardId).toBe('limits');
  });

  it('go_to_card in a Button Handler moves to the target card and clears the old status', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    store.getState().followLink('todo-link-about');
    store.getState().activateButton('about-back');
    expect(store.getState().currentCardId).toBe('todo');
    expect(store.getState().status).toBeNull();
    expect(store.getState().selectedObjectId).toBeNull();
  });

  it('go_to_card clears an earlier status and then shows the Handler messages', () => {
    const onClick: Handler = [
      { type: 'show_message', text: 'Going.' },
      { type: 'go_to_card', cardId: 'about' },
    ];
    const store = createStackStore(stackWithAddHandler(onClick));
    store.getState().typeInField('todo-input', 'x');
    store.getState().activateButton('todo-add');
    expect(store.getState().currentCardId).toBe('about');
    expect(store.getState().status).toEqual({ text: 'Going.', seq: 1 });
  });

  it('keeps the stack changes made before go_to_card', () => {
    const onClick: Handler = [
      { type: 'append_item', targetObjectId: 'todo-list', fromObjectId: 'todo-input' },
      { type: 'go_to_card', cardId: 'limits' },
    ];
    const store = createStackStore(stackWithAddHandler(onClick));
    store.getState().typeInField('todo-input', 'kept');
    store.getState().activateButton('todo-add');
    expect(store.getState().currentCardId).toBe('limits');
    expect(items(store)).toEqual(['kept']);
  });
});

describe('status messages', () => {
  it('joins several messages of one handler with a space', () => {
    const onClick: Handler = [
      { type: 'show_message', text: 'First.' },
      { type: 'show_message', text: 'Second.' },
      { type: 'show_message', text: 'Third.' },
    ];
    const store = createStackStore(stackWithAddHandler(onClick));
    store.getState().activateButton('todo-add');
    expect(store.getState().status?.text).toBe('First. Second. Third.');
  });

  it('increases seq on every new message and never reuses one after a clear', () => {
    const store = demoStore();
    const seen: number[] = [];
    store.getState().activateButton('todo-add');
    seen.push(store.getState().status?.seq ?? -1);
    store.getState().activateButton('todo-add');
    seen.push(store.getState().status?.seq ?? -1);
    store.getState().expireStatus(2);
    expect(store.getState().status).toBeNull();
    store.getState().activateButton('todo-add');
    seen.push(store.getState().status?.seq ?? -1);
    store.getState().followLink('todo-link-about');
    store.getState().followLink('about-link-limits');
    store.getState().activateButton('limits-back');
    store.getState().activateButton('about-back');
    store.getState().activateButton('todo-add');
    seen.push(store.getState().status?.seq ?? -1);

    expect(seen).toEqual([1, 2, 3, 4]);
    expect(store.getState().statusSeq).toBe(4);
  });

  it('replaces the previous message with the new one', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    const first = store.getState().status;
    store.getState().activateButton('todo-add');
    const second = store.getState().status;
    expect(second?.text).toBe(first?.text);
    expect(second?.seq).toBe((first?.seq ?? 0) + 1);
  });

  it('shows the executor "full" message and joins it with the Handler message', () => {
    const store = demoStore();
    for (let i = 0; i < 500; i += 1) store.getState().activateButton('todo-add');
    expect(items(store)).toHaveLength(500);
    store.getState().activateButton('todo-add');
    expect(items(store)).toHaveLength(500);
    const text = store.getState().status?.text ?? '';
    expect(text.endsWith('Item added.')).toBe(true);
    expect(text).toContain(' ');
    expect(text.length).toBeGreaterThan('Item added.'.length);
  });

  it('a handler with no messages leaves the status and statusSeq unchanged', () => {
    const store = createStackStore(stackWithAddHandler([]));
    store.getState().activateButton('todo-add');
    expect(store.getState().status).toBeNull();
    expect(store.getState().statusSeq).toBe(0);
  });
});

describe('Actions that are validated but not executable in this release', () => {
  const removeItem: Handler = [{ type: 'remove_item', targetObjectId: 'todo-list', index: 0 }];

  it('shows the skip message for a remove_item Button and leaves the stack unchanged', () => {
    const store = createStackStore(stackWithAddHandler(removeItem));
    const before = store.getState().stack;
    store.getState().activateButton('todo-add');

    expect(store.getState().status).toEqual({
      text: 'Skipped action 1 (remove_item): this action type is not supported.',
      seq: 1,
    });
    expect(store.getState().stack).toEqual(before);
    expect(store.getState().currentCardId).toBe('todo');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.results[0]?.value.effects).toEqual([]);
  });

  it('skips only the new Action and keeps the rest of the Handler working', () => {
    const onClick: Handler = [
      { type: 'append_item', targetObjectId: 'todo-list', fromObjectId: 'todo-input' },
      { type: 'remove_item', targetObjectId: 'todo-list', index: 0 },
      { type: 'show_message', text: 'Done.' },
      { type: 'go_to_card', cardId: 'about' },
    ];
    const store = createStackStore(stackWithAddHandler(onClick));
    store.getState().typeInField('todo-input', 'kept');
    store.getState().activateButton('todo-add');

    expect(items(store)).toEqual(['kept']);
    expect(store.getState().currentCardId).toBe('about');
    expect(store.getState().status?.text).toBe(
      'Skipped action 2 (remove_item): this action type is not supported. Done.',
    );
    expect(executeSpy.mock.results.at(-1)?.value.effects).toEqual([]);
  });
});

describe('expireStatus', () => {
  it('clears the status when the seq matches', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    store.getState().expireStatus(1);
    expect(store.getState().status).toBeNull();
  });

  it('ignores a stale seq and keeps the newer message', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    store.getState().activateButton('todo-add');
    store.getState().expireStatus(1);
    expect(store.getState().status?.seq).toBe(2);
  });

  it('ignores a future seq', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    store.getState().expireStatus(5);
    expect(store.getState().status?.seq).toBe(1);
  });

  it('does nothing when there is no status', () => {
    const store = demoStore();
    const before = store.getState();
    store.getState().expireStatus(0);
    expect(store.getState()).toBe(before);
  });

  it('does not reset statusSeq', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    store.getState().expireStatus(1);
    expect(store.getState().statusSeq).toBe(1);
  });
});

describe('input immutability', () => {
  it('never mutates the input stack, and returns a new stack after edits', () => {
    const input = deepFreeze(demoStack());
    const snapshot = JSON.stringify(input);
    const store = createStackStore(input);

    store.getState().typeInField('todo-input', 'Milk');
    store.getState().activateButton('todo-add');
    store.getState().followLink('todo-link-about');
    store.getState().activateButton('about-back');

    expect(JSON.stringify(input)).toBe(snapshot);
    expect(store.getState().stack).not.toBe(input);
    expect(items(store)).toEqual(['Milk']);
  });

  it('keeps the same stack reference when nothing changes the stack', () => {
    const input = demoStack();
    const store = createStackStore(input);
    store.getState().followLink('todo-link-about');
    store.getState().toggleMode();
    expect(store.getState().stack).toBe(input);
  });
});
