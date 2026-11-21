import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as engine from '@hypergeist/shared/engine';
import type { Handler, Stack } from '@hypergeist/shared/format';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { loadStack } from '../stacks/load-stack.ts';
import { createStackStore, lastEntrySource } from './stack-store.ts';
import type { EffectsHandler } from './stack-store.ts';

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
  it('toggleMode cycles Interact, Edit, AI edit, Interact', () => {
    const store = demoStore();
    store.getState().toggleMode();
    expect(store.getState().mode).toBe('edit');
    store.getState().toggleMode();
    expect(store.getState().mode).toBe('ai-edit');
    store.getState().toggleMode();
    expect(store.getState().mode).toBe('interact');
  });

  it('setMode accepts ai-edit and clears selection and status', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    store.getState().setMode('ai-edit');
    expect(store.getState().mode).toBe('ai-edit');
    expect(store.getState().status).toBeNull();
    store.getState().selectObject('todo-add');
    store.getState().toggleMode();
    expect(store.getState().selectedObjectId).toBeNull();
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
    store.getState().toggleMode();
    expect(store.getState().mode).toBe('interact');
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

  it('selects an object on the current card in AI edit mode', () => {
    const store = demoStore();
    store.getState().setMode('ai-edit');
    store.getState().selectObject('todo-list');
    expect(store.getState().selectedObjectId).toBe('todo-list');
    store.getState().selectObject('about-text'); // on another card
    expect(store.getState().selectedObjectId).toBe('todo-list');
    store.getState().selectObject('todo-link-about'); // a link, not an object
    expect(store.getState().selectedObjectId).toBe('todo-list');
  });

  it('clearSelection clears in AI edit mode and keeps the mode', () => {
    const store = demoStore();
    store.getState().setMode('ai-edit');
    store.getState().selectObject('todo-add');
    store.getState().clearSelection();
    expect(store.getState().selectedObjectId).toBeNull();
    expect(store.getState().mode).toBe('ai-edit');
  });

  it('selectObject is a no-op in Interact mode', () => {
    const store = demoStore();
    const before = store.getState();
    store.getState().selectObject('todo-add');
    expect(store.getState()).toBe(before);
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
  it.each(['edit', 'ai-edit'] as const)(
    'buttons, fields and links are inert in %s mode and never call the executor',
    (mode) => {
      const store = demoStore();
      store.getState().setMode(mode);
      store.getState().selectObject('todo-add');
      const before = store.getState();
      store.getState().activateButton('todo-add');
      store.getState().typeInField('todo-input', 'Milk');
      store.getState().followLink('todo-link-about');
      expect(store.getState()).toBe(before);
      expect(items(store)).toEqual([]);
      expect(fieldValue(store, 'todo-input')).toBe('');
      expect(executeSpy).not.toHaveBeenCalled();
    },
  );

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

describe('remove_item', () => {
  it('removes the item at the index and shows no skip message', () => {
    const onClick: Handler = [
      { type: 'append_item', targetObjectId: 'todo-list', item: 'a' },
      { type: 'append_item', targetObjectId: 'todo-list', item: 'b' },
      { type: 'remove_item', targetObjectId: 'todo-list', index: 0 },
    ];
    const store = createStackStore(stackWithAddHandler(onClick));
    store.getState().activateButton('todo-add');

    expect(items(store)).toEqual(['b']);
    expect(store.getState().status).toBeNull();
    expect(executeSpy.mock.results[0]?.value.effects).toEqual([]);
  });

  it('does nothing and shows no message when the index is out of range', () => {
    const removeItem: Handler = [{ type: 'remove_item', targetObjectId: 'todo-list', index: 0 }];
    const store = createStackStore(stackWithAddHandler(removeItem));
    const before = store.getState().stack;
    store.getState().activateButton('todo-add');

    expect(store.getState().stack).toEqual(before);
    expect(store.getState().status).toBeNull();
    expect(store.getState().statusSeq).toBe(0);
    expect(store.getState().currentCardId).toBe('todo');
  });

  it('works inside a longer Handler: the item is removed and "Done." is shown', () => {
    const onClick: Handler = [
      { type: 'append_item', targetObjectId: 'todo-list', fromObjectId: 'todo-input' },
      { type: 'remove_item', targetObjectId: 'todo-list', index: 0 },
      { type: 'show_message', text: 'Done.' },
      { type: 'go_to_card', cardId: 'about' },
    ];
    const store = createStackStore(stackWithAddHandler(onClick));
    store.getState().typeInField('todo-input', 'gone');
    store.getState().activateButton('todo-add');

    expect(items(store)).toEqual([]);
    expect(store.getState().currentCardId).toBe('about');
    expect(store.getState().status?.text).toBe('Done.');
    expect(executeSpy.mock.results.at(-1)?.value.effects).toEqual([]);
  });
});

describe('Actions that need the outside world', () => {
  /** Demo stack with an ai-field on the to-do card and the Add button running `onClick`. */
  function stackWithEffectHandler(onClick: Handler): Stack {
    const stack = stackWithAddHandler(onClick);
    return {
      ...stack,
      cards: stack.cards.map((card) =>
        card.id === 'todo'
          ? {
              ...card,
              objects: [
                ...card.objects,
                {
                  id: 'todo-ai',
                  type: 'ai-field' as const,
                  name: 'Summary',
                  x: 16,
                  y: 300,
                  width: 480,
                  height: 32,
                  prompt: 'Summarize.',
                  inputObjectIds: ['todo-list'],
                  value: '',
                },
              ],
            }
          : card,
      ),
    };
  }

  const cases: readonly {
    readonly kind: string;
    readonly label: string;
    readonly action: Handler[number];
  }[] = [
    {
      kind: 'run_ai_field',
      label: 'AI fields',
      action: { type: 'run_ai_field', targetObjectId: 'todo-ai' },
    },
    {
      kind: 'fetch_news',
      label: 'News',
      action: { type: 'fetch_news', targetObjectId: 'todo-list', topics: ['tech'] },
    },
    {
      kind: 'transcribe_audio',
      label: 'Voice transcription',
      action: { type: 'transcribe_audio', targetObjectId: 'todo-input' },
    },
    {
      kind: 'schedule_notification',
      label: 'Reminders',
      action: { type: 'schedule_notification', message: 'Ping', at: '2026-12-01T09:00:00Z' },
    },
  ];

  for (const { kind, label, action } of cases) {
    it(`shows a later-release message for a ${kind} Button and leaves the stack unchanged`, () => {
      const stack = stackWithEffectHandler([action]);
      const store = createStackStore(stack);
      store.getState().activateButton('todo-add');

      expect(store.getState().status).toEqual({
        text: `Skipped action 1 (${kind}): ${label} arrives in a later release.`,
        seq: 1,
      });
      expect(store.getState().stack).toEqual(stack);
      expect(store.getState().currentCardId).toBe('todo');
      const effects = executeSpy.mock.results[0]?.value.effects;
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({ kind, actionIndex: 0 });
    });
  }

  it('appends effect messages after the executor messages, with the Action position', () => {
    const onClick: Handler = [
      { type: 'show_message', text: 'Working.' },
      { type: 'fetch_news', targetObjectId: 'todo-list', topics: ['tech'] },
      { type: 'show_message', text: 'Still working.' },
      { type: 'transcribe_audio', targetObjectId: 'todo-input' },
    ];
    const store = createStackStore(stackWithEffectHandler(onClick));
    store.getState().activateButton('todo-add');

    expect(store.getState().status?.text).toBe(
      'Working. Still working. ' +
        'Skipped action 2 (fetch_news): News arrives in a later release. ' +
        'Skipped action 4 (transcribe_audio): Voice transcription arrives in a later release.',
    );
    const effects = executeSpy.mock.results[0]?.value.effects;
    expect(effects.map((effect: { kind: string }) => effect.kind)).toEqual([
      'fetch_news',
      'transcribe_audio',
    ]);
    expect(effects.map((effect: { actionIndex: number }) => effect.actionIndex)).toEqual([1, 3]);
  });

  it('keeps an effect message when go_to_card follows it', () => {
    const onClick: Handler = [
      { type: 'run_ai_field', targetObjectId: 'todo-ai' },
      { type: 'go_to_card', cardId: 'about' },
    ];
    const store = createStackStore(stackWithEffectHandler(onClick));
    store.getState().activateButton('todo-add');

    expect(store.getState().currentCardId).toBe('about');
    expect(store.getState().status?.text).toBe(
      'Skipped action 1 (run_ai_field): AI fields arrives in a later release.',
    );
  });

  describe('with an effects handler attached', () => {
    const aiAction: Handler[number] = { type: 'run_ai_field', targetObjectId: 'todo-ai' };
    const remindAction: Handler[number] = {
      type: 'schedule_notification',
      message: 'Ping',
      at: '2026-12-01T09:00:00Z',
    };
    const newsAction: Handler[number] = {
      type: 'fetch_news',
      targetObjectId: 'todo-list',
      topics: ['tech'],
    };
    const voiceAction: Handler[number] = {
      type: 'transcribe_audio',
      targetObjectId: 'todo-input',
    };

    it('calls the handler once with the two handled kinds and the stack that ran the Handler', () => {
      const stack = stackWithEffectHandler([
        { type: 'show_message', text: 'Go.' },
        aiAction,
        newsAction,
        remindAction,
      ]);
      const store = createStackStore(stack);
      const handler = vi.fn<EffectsHandler>();
      store.getState().attachEffects(handler);
      store.getState().activateButton('todo-add');

      expect(handler).toHaveBeenCalledTimes(1);
      const [effects, snapshot] = handler.mock.calls[0] ?? [];
      expect(effects?.map((effect) => effect.kind)).toEqual([
        'run_ai_field',
        'schedule_notification',
      ]);
      expect(effects?.map((effect) => effect.actionIndex)).toEqual([1, 3]);
      expect(snapshot).toBe(stack);
    });

    it('passes the stack from before the result, not the one the press produced', () => {
      const stack = stackWithEffectHandler([
        { type: 'set_value', targetObjectId: 'todo-input', value: 'changed' },
        aiAction,
      ]);
      const store = createStackStore(stack);
      const handler = vi.fn<EffectsHandler>();
      store.getState().attachEffects(handler);
      store.getState().activateButton('todo-add');

      expect(fieldValue(store, 'todo-input')).toBe('changed');
      expect(handler.mock.calls[0]?.[1]).toBe(stack);
      expect(handler.mock.calls[0]?.[1]).not.toBe(store.getState().stack);
    });

    it('is not called when there are no handled effects', () => {
      const handler = vi.fn<EffectsHandler>();
      const plain = demoStore();
      plain.getState().attachEffects(handler);
      plain.getState().activateButton('todo-add');

      const other = createStackStore(stackWithEffectHandler([newsAction, voiceAction]));
      other.getState().attachEffects(handler);
      other.getState().activateButton('todo-add');

      expect(handler).not.toHaveBeenCalled();
    });

    it('is not called for typeInField or in other modes', () => {
      const handler = vi.fn<EffectsHandler>();
      const store = createStackStore(stackWithEffectHandler([aiAction]));
      store.getState().attachEffects(handler);
      store.getState().typeInField('todo-input', 'x');
      store.getState().setMode('edit');
      store.getState().activateButton('todo-add');
      expect(handler).not.toHaveBeenCalled();
    });

    it('stops calling the handler after the returned function detaches it', () => {
      const store = createStackStore(stackWithEffectHandler([aiAction]));
      const handler = vi.fn<EffectsHandler>();
      const detach = store.getState().attachEffects(handler);
      store.getState().activateButton('todo-add');
      expect(handler).toHaveBeenCalledTimes(1);

      detach();
      store.getState().activateButton('todo-add');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(store.getState().status?.text).toBe(
        'Skipped action 1 (run_ai_field): AI fields arrives in a later release.',
      );
    });

    it('stops calling the handler after attachEffects(null)', () => {
      const store = createStackStore(stackWithEffectHandler([aiAction]));
      const handler = vi.fn<EffectsHandler>();
      store.getState().attachEffects(handler);
      store.getState().attachEffects(null);
      store.getState().activateButton('todo-add');
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not let a stale detach remove a newer handler', () => {
      const store = createStackStore(stackWithEffectHandler([aiAction]));
      const first = vi.fn<EffectsHandler>();
      const second = vi.fn<EffectsHandler>();
      const detachFirst = store.getState().attachEffects(first);
      store.getState().attachEffects(second);
      detachFirst();
      store.getState().activateButton('todo-add');
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('calls the handler synchronously inside activateButton, after the state is set', () => {
      const store = createStackStore(stackWithEffectHandler([aiAction]));
      const order: string[] = [];
      let statusSeenByHandler: unknown = 'unset';
      store.getState().attachEffects(() => {
        order.push('handler');
        statusSeenByHandler = store.getState().status;
      });
      order.push('before');
      store.getState().activateButton('todo-add');
      order.push('after');

      expect(order).toEqual(['before', 'handler', 'after']);
      expect(statusSeenByHandler).toBeNull();
    });

    it('gives no message for handled kinds and the later-release message for the others', () => {
      const store = createStackStore(
        stackWithEffectHandler([
          { type: 'show_message', text: 'Working.' },
          aiAction,
          newsAction,
          remindAction,
          voiceAction,
        ]),
      );
      store.getState().attachEffects(vi.fn<EffectsHandler>());
      store.getState().activateButton('todo-add');

      expect(store.getState().status?.text).toBe(
        'Working. ' +
          'Skipped action 3 (fetch_news): News arrives in a later release. ' +
          'Skipped action 5 (transcribe_audio): Voice transcription arrives in a later release.',
      );
    });

    it('leaves the status unchanged when only handled kinds are returned', () => {
      const store = createStackStore(stackWithEffectHandler([aiAction, remindAction]));
      store.getState().attachEffects(vi.fn<EffectsHandler>());
      store.getState().activateButton('todo-add');
      expect(store.getState().status).toBeNull();
      expect(store.getState().statusSeq).toBe(0);
    });

    it('restores all four messages once the handler is detached', () => {
      const store = createStackStore(
        stackWithEffectHandler([aiAction, newsAction, voiceAction, remindAction]),
      );
      const detach = store.getState().attachEffects(vi.fn<EffectsHandler>());
      detach();
      store.getState().activateButton('todo-add');
      expect(store.getState().status?.text).toBe(
        'Skipped action 1 (run_ai_field): AI fields arrives in a later release. ' +
          'Skipped action 2 (fetch_news): News arrives in a later release. ' +
          'Skipped action 3 (transcribe_audio): Voice transcription arrives in a later release. ' +
          'Skipped action 4 (schedule_notification): Reminders arrives in a later release.',
      );
    });

    it('keeps the press intact when the handler throws', () => {
      const store = createStackStore(
        stackWithEffectHandler([
          { type: 'show_message', text: 'Done.' },
          aiAction,
          { type: 'go_to_card', cardId: 'about' },
        ]),
      );
      const handler = vi.fn<EffectsHandler>(() => {
        throw new Error('boom');
      });
      store.getState().attachEffects(handler);

      expect(() => store.getState().activateButton('todo-add')).not.toThrow();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(store.getState().currentCardId).toBe('about');
      expect(store.getState().status?.text).toBe('Done.');

      store.getState().setMode('interact');
      expect(store.getState().mode).toBe('interact');
    });

    it('does not keep the handler in the state', () => {
      const store = demoStore();
      const handler = vi.fn<EffectsHandler>();
      store.getState().attachEffects(handler);
      expect(Object.values(store.getState())).not.toContain(handler);
    });
  });
});

describe('setStatus', () => {
  it('shows the text with a new seq each time', () => {
    const store = demoStore();
    store.getState().setStatus('First.');
    expect(store.getState().status).toEqual({ text: 'First.', seq: 1 });
    store.getState().setStatus('Second.');
    expect(store.getState().status).toEqual({ text: 'Second.', seq: 2 });
    expect(store.getState().statusSeq).toBe(2);
  });

  it('continues after a handler message and lets the matching seq expire it', () => {
    const store = demoStore();
    store.getState().activateButton('todo-add');
    const before = store.getState().statusSeq;
    store.getState().setStatus('Later.');
    expect(store.getState().status?.seq).toBe(before + 1);

    store.getState().expireStatus(before);
    expect(store.getState().status?.text).toBe('Later.');
    store.getState().expireStatus(before + 1);
    expect(store.getState().status).toBeNull();
  });

  it('does not change the stack, card or mode', () => {
    const store = demoStore();
    const before = store.getState();
    store.getState().setStatus('Hello.');
    const after = store.getState();
    expect(after.stack).toBe(before.stack);
    expect(after.currentCardId).toBe(before.currentCardId);
    expect(after.mode).toBe(before.mode);
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

describe('replaceStack', () => {
  it('shows the new stack from its start card, in Interact mode, with no selection and no status', () => {
    const store = demoStore();
    store.getState().followLink('todo-link-about');
    store.getState().setMode('edit');
    store.getState().selectObject('about-text');
    expect(store.getState().currentCardId).toBe('about');
    expect(store.getState().selectedObjectId).toBe('about-text');

    const next: Stack = { ...demoStack(), id: 'other', name: 'Other', startCardId: 'about' };
    store.getState().replaceStack(next);

    const state = store.getState();
    expect(state.stack).toBe(next);
    expect(state.currentCardId).toBe('about');
    expect(state.mode).toBe('interact');
    expect(state.selectedObjectId).toBeNull();
    expect(state.status).toBeNull();
  });

  it('clears a status message and does not reset statusSeq', () => {
    const store = demoStore();
    store.getState().typeInField('todo-input', 'Milk');
    store.getState().activateButton('todo-add');
    expect(store.getState().status).not.toBeNull();
    const seq = store.getState().statusSeq;

    store.getState().replaceStack(demoStack());
    expect(store.getState().status).toBeNull();
    expect(store.getState().statusSeq).toBe(seq);

    // The next message gets a new seq, so the timer of the old message cannot clear it.
    store.getState().typeInField('todo-input', 'Eggs');
    store.getState().activateButton('todo-add');
    expect(store.getState().status?.seq).toBe(seq + 1);
    store.getState().expireStatus(seq);
    expect(store.getState().status?.seq).toBe(seq + 1);
  });

  it('does not mutate the stack it receives, and edits afterwards return a new stack', () => {
    const store = demoStore();
    const input = deepFreeze({ ...demoStack(), id: 'other' });
    const snapshot = JSON.stringify(input);

    store.getState().replaceStack(input);
    expect(store.getState().stack).toBe(input);
    store.getState().typeInField('todo-input', 'Milk');
    store.getState().activateButton('todo-add');

    expect(JSON.stringify(input)).toBe(snapshot);
    expect(store.getState().stack).not.toBe(input);
    expect(store.getState().stack.id).toBe('other');
    expect(items(store)).toEqual(['Milk']);
  });

  it('notifies subscribers once with the new stack', () => {
    const store = demoStore();
    const seen: Stack[] = [];
    store.subscribe((state, previous) => {
      if (state.stack !== previous.stack) seen.push(state.stack);
    });
    const next = { ...demoStack(), id: 'other' };
    store.getState().replaceStack(next);
    expect(seen).toEqual([next]);
  });
});

describe('applyStack', () => {
  /** The demo stack with the `todo-list` object removed from the first card. */
  function withoutList(stack: Stack): Stack {
    return {
      ...stack,
      cards: stack.cards.map((card) => ({
        ...card,
        objects: card.objects.filter((object) => object.id !== 'todo-list'),
      })),
    };
  }

  it('swaps in the stack and keeps the mode, card and selection', () => {
    const store = demoStore();
    store.getState().setMode('ai-edit');
    store.getState().selectObject('todo-add');
    const next = withoutList(demoStack());
    store.getState().applyStack(next);

    const state = store.getState();
    expect(state.stack).toBe(next);
    expect(state.mode).toBe('ai-edit');
    expect(state.currentCardId).toBe('todo');
    expect(state.selectedObjectId).toBe('todo-add');
  });

  it('keeps the Interact mode too', () => {
    const store = demoStore();
    store.getState().applyStack(demoStack());
    expect(store.getState().mode).toBe('interact');
  });

  it('keeps the current card when it still exists, even if it is not the start card', () => {
    const store = demoStore();
    store.getState().followLink('todo-link-about');
    store.getState().applyStack(demoStack());
    expect(store.getState().currentCardId).toBe('about');
  });

  it('goes to the start card when the current card is gone', () => {
    const store = demoStore();
    store.getState().followLink('todo-link-about');
    const base = demoStack();
    const next: Stack = {
      ...base,
      cards: base.cards
        .filter((card) => card.id !== 'about')
        .map((card) => ({ ...card, links: card.links.filter((l) => l.targetCardId !== 'about') })),
    };
    store.getState().applyStack(next);
    expect(store.getState().currentCardId).toBe(next.startCardId);
  });

  it('clears the selection when that object is gone from the current card', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().selectObject('todo-list');
    store.getState().applyStack(withoutList(demoStack()));
    expect(store.getState().selectedObjectId).toBeNull();
    expect(store.getState().mode).toBe('edit');
  });

  it('clears the selection when the card was reset to the start card and the object is not on it', () => {
    const store = demoStore();
    store.getState().followLink('todo-link-about');
    store.getState().setMode('edit');
    store.getState().selectObject('about-text');
    const base = demoStack();
    const next: Stack = {
      ...base,
      cards: base.cards
        .filter((card) => card.id !== 'about')
        .map((card) => ({ ...card, links: card.links.filter((l) => l.targetCardId !== 'about') })),
    };
    store.getState().applyStack(next);
    expect(store.getState().currentCardId).toBe('todo');
    expect(store.getState().selectedObjectId).toBeNull();
  });

  it('clears the status and leaves statusSeq unchanged', () => {
    const store = demoStore();
    store.getState().typeInField('todo-input', 'Milk');
    store.getState().activateButton('todo-add');
    expect(store.getState().status).not.toBeNull();
    const seq = store.getState().statusSeq;

    store.getState().applyStack(demoStack());
    expect(store.getState().status).toBeNull();
    expect(store.getState().statusSeq).toBe(seq);
  });

  it('notifies subscribers once, with a new state reference', () => {
    const store = demoStore();
    const before = store.getState();
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().applyStack(demoStack());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).not.toBe(before);
    expect(store.getState().stack).not.toBe(before.stack);
  });

  it('does not mutate the stack it receives', () => {
    const input = deepFreeze(demoStack());
    const snapshot = JSON.stringify(input);
    const store = demoStore();
    store.getState().setMode('ai-edit');
    store.getState().selectObject('todo-add');
    store.getState().applyStack(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(store.getState().stack).toBe(input);
  });
});

describe('history', () => {
  function cardOf(store: ReturnType<typeof demoStore>, id: string) {
    return store.getState().stack.cards.find((card) => card.id === id);
  }

  it('starts empty and records a user edit with source user', () => {
    const store = demoStore();
    expect(store.getState().past).toEqual([]);
    expect(lastEntrySource(store.getState())).toBeNull();
    const before = store.getState().stack;
    store.getState().editObject('todo-add', { label: 'Plus' });
    const { past, future } = store.getState();
    expect(past).toHaveLength(1);
    expect(past[0]).toEqual({ stack: before, source: 'user' });
    expect(future).toEqual([]);
    expect(lastEntrySource(store.getState())).toBe('user');
  });

  it('applyStack records with source ai by default and honors an explicit source', () => {
    const store = demoStore();
    store.getState().applyStack({ ...demoStack(), name: 'One' });
    expect(lastEntrySource(store.getState())).toBe('ai');
    store.getState().applyStack({ ...demoStack(), name: 'Two' }, 'user');
    expect(lastEntrySource(store.getState())).toBe('user');
    expect(store.getState().past).toHaveLength(2);
  });

  it('commitStack ignores the same stack and clears future on a real change', () => {
    const store = demoStore();
    store.getState().editObject('todo-add', { label: 'Plus' });
    store.getState().undoEdit();
    expect(store.getState().future).toHaveLength(1);
    store.getState().commitStack(store.getState().stack, { source: 'user' });
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(1);
    store.getState().commitStack({ ...demoStack(), name: 'Other' }, { source: 'user' });
    expect(store.getState().future).toEqual([]);
  });

  it('keeps at most 50 entries in past and in future', () => {
    const store = demoStore();
    for (let index = 0; index < 55; index += 1) {
      store.getState().editObject('todo-add', { label: `L${String(index)}` });
    }
    expect(store.getState().past).toHaveLength(50);
    for (let index = 0; index < 55; index += 1) store.getState().undoEdit();
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(50);
    for (let index = 0; index < 55; index += 1) store.getState().redoEdit();
    expect(store.getState().future).toHaveLength(0);
    expect(store.getState().past).toHaveLength(50);
  });

  it('replaceStack clears past and future', () => {
    const store = demoStore();
    store.getState().editObject('todo-add', { label: 'Plus' });
    store.getState().editObject('todo-add', { label: 'Minus' });
    store.getState().undoEdit();
    store.getState().replaceStack(demoStack());
    expect(store.getState().past).toEqual([]);
    expect(store.getState().future).toEqual([]);
    store.getState().undoEdit();
    store.getState().redoEdit();
    expect(store.getState().past).toEqual([]);
  });

  it('undo and redo restore the stacks and keep the card and the selection when valid', () => {
    const store = demoStore();
    const original = store.getState().stack;
    store.getState().setMode('edit');
    store.getState().selectObject('todo-add');
    store.getState().editObject('todo-add', { label: 'Plus' });
    const edited = store.getState().stack;
    store.getState().undoEdit();
    expect(store.getState().stack).toBe(original);
    expect(store.getState().selectedObjectId).toBe('todo-add');
    expect(store.getState().currentCardId).toBe(original.startCardId);
    store.getState().redoEdit();
    expect(store.getState().stack).toBe(edited);
    expect(store.getState().selectedObjectId).toBe('todo-add');
  });

  it('undo drops the selection and card when they no longer exist', () => {
    const store = demoStore();
    store.getState().addCard();
    const newCard = store.getState().currentCardId;
    store.getState().setMode('edit');
    store.getState().addObjectToCard('button');
    expect(store.getState().selectedObjectId).not.toBeNull();
    store.getState().undoEdit();
    expect(store.getState().selectedObjectId).toBeNull();
    store.getState().undoEdit();
    expect(store.getState().currentCardId).toBe(store.getState().stack.startCardId);
    expect(cardOf(store, newCard)).toBeUndefined();
  });

  it('undo and redo without entries change nothing', () => {
    const store = demoStore();
    const before = store.getState();
    store.getState().undoEdit();
    store.getState().redoEdit();
    expect(store.getState().stack).toBe(before.stack);
  });

  it('a rejected edit leaves the stack and history alone and sets the status', () => {
    const store = demoStore();
    const before = store.getState().stack;
    store.getState().editObject('todo-add', { width: 100000 });
    expect(store.getState().stack).toBe(before);
    expect(store.getState().past).toEqual([]);
    expect(store.getState().status?.text).toEqual(expect.any(String));
    expect(store.getState().status?.text).not.toBe('');
    store.getState().editObject('missing-object', { x: 1 });
    expect(store.getState().stack).toBe(before);
    expect(store.getState().past).toEqual([]);
  });

  it('never mutates the stack it works on', () => {
    const input = deepFreeze(demoStack());
    const store = createStackStore(input);
    const snapshot = JSON.stringify(input);
    store.getState().editObject('todo-add', { x: 40 });
    store.getState().addObjectToCard('field');
    store.getState().addCard();
    store.getState().undoEdit();
    store.getState().redoEdit();
    store.getState().undoEdit();
    store.getState().undoEdit();
    store.getState().undoEdit();
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('adds objects with the defaults, staggered by 8 per object, with unique ids', () => {
    const store = demoStore();
    const expected = {
      button: { width: 96, height: 28 },
      field: { width: 160, height: 28 },
      list: { width: 160, height: 96 },
      image: { width: 96, height: 96 },
    } as const;
    store.getState().addCard();
    const cardId = store.getState().currentCardId;
    const types = ['button', 'field', 'list', 'image'] as const;
    types.forEach((type, index) => {
      store.getState().addObjectToCard(type);
      const objects = cardOf(store, cardId)?.objects ?? [];
      const added = objects[index];
      expect(added?.type).toBe(type);
      expect(added?.width).toBe(expected[type].width);
      expect(added?.height).toBe(expected[type].height);
      expect(added?.x).toBe(16 + 8 * index);
      expect(added?.y).toBe(16 + 8 * index);
      expect(store.getState().selectedObjectId).toBe(added?.id);
    });
    const objects = cardOf(store, cardId)?.objects ?? [];
    const button = objects[0];
    const image = objects[3];
    if (button?.type !== 'button' || image?.type !== 'image') throw new Error('wrong types');
    expect(button.label).toBe('Button');
    expect(image.alt).toBe('Image');
    const ids = store.getState().stack.cards.flatMap((card) => card.objects.map((o) => o.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('clamps a new object inside the card', () => {
    const store = demoStore();
    store.getState().addCard();
    const cardId = store.getState().currentCardId;
    for (let index = 0; index < 60; index += 1) store.getState().addObjectToCard('list');
    const objects = cardOf(store, cardId)?.objects ?? [];
    expect(objects.length).toBe(60);
    const { cardWidth, cardHeight } = store.getState().stack;
    for (const object of objects) {
      expect(object.x + object.width).toBeLessThanOrEqual(cardWidth);
      expect(object.y + object.height).toBeLessThanOrEqual(cardHeight);
    }
  });

  it('removeSelected removes the selection, and does nothing without one', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().removeSelected();
    expect(store.getState().past).toEqual([]);
    store.getState().selectObject('todo-list');
    store.getState().removeSelected();
    expect(cardOf(store, 'todo')?.objects.some((o) => o.id === 'todo-list')).toBe(false);
    expect(store.getState().selectedObjectId).toBeNull();
    expect(store.getState().past).toHaveLength(1);
  });

  it('addCard names the card "Card N" and opens it', () => {
    const store = demoStore();
    const count = store.getState().stack.cards.length;
    store.getState().addCard();
    const { stack, currentCardId } = store.getState();
    expect(stack.cards).toHaveLength(count + 1);
    expect(stack.cards[count]?.name).toBe(`Card ${String(count + 1)}`);
    expect(currentCardId).toBe(stack.cards[count]?.id);
    store.getState().addCard();
    expect(store.getState().stack.cards[count + 1]?.name).toBe(`Card ${String(count + 2)}`);
  });

  it('deleteCurrentCard opens a neighbor, and the last card cannot be deleted', () => {
    const store = demoStore();
    store.getState().goToCard('about');
    store.getState().deleteCurrentCard();
    expect(cardOf(store, 'about')).toBeUndefined();
    expect(store.getState().currentCardId).toBe('limits');
    store.getState().deleteCurrentCard();
    expect(store.getState().currentCardId).toBe('todo');
    expect(store.getState().stack.cards).toHaveLength(1);
    const before = store.getState().stack;
    const pastLength = store.getState().past.length;
    store.getState().deleteCurrentCard();
    expect(store.getState().stack).toBe(before);
    expect(store.getState().past).toHaveLength(pastLength);
    expect(store.getState().status?.text).toContain('last card');
  });

  it('goToCard opens a known card, clears the selection and ignores unknown ids', () => {
    const store = demoStore();
    store.getState().setMode('edit');
    store.getState().selectObject('todo-add');
    store.getState().goToCard('about');
    expect(store.getState().currentCardId).toBe('about');
    expect(store.getState().selectedObjectId).toBeNull();
    store.getState().goToCard('nope');
    expect(store.getState().currentCardId).toBe('about');
    expect(store.getState().past).toEqual([]);
  });
});
