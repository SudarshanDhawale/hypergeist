import { describe, expect, it } from 'vitest';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { loadStack } from '../stacks/load-stack.ts';
import { AI_EDIT_HINT, EDIT_HINT, INTERACT_HINT, hintForMode } from './hints.ts';
import { createStackStore } from './stack-store.ts';

function demoStore() {
  const loaded = loadStack(demoText);
  if (!loaded.ok) throw new Error('Demo_Stack must be valid');
  return createStackStore(loaded.stack);
}

describe('stack store smoke test', () => {
  it('starts on the start card in Interact mode and runs the Add button', () => {
    const store = demoStore();
    expect(store.getState().currentCardId).toBe('todo');
    expect(store.getState().mode).toBe('interact');

    store.getState().typeInField('todo-input', 'Milk');
    store.getState().activateButton('todo-add');

    const card = store.getState().stack.cards[0];
    const list = card?.objects.find((o) => o.id === 'todo-list');
    expect(list?.type === 'list' && list.items).toEqual(['Milk']);
    expect(store.getState().status?.text).toBe('Item added.');
  });

  it('has three different hints that all name Alt+M', () => {
    expect(new Set([INTERACT_HINT, EDIT_HINT, AI_EDIT_HINT]).size).toBe(3);
    expect(INTERACT_HINT).toContain('Alt+M');
    expect(EDIT_HINT).toContain('Alt+M');
    expect(AI_EDIT_HINT).toBe(
      'AI edit mode. Click an object, then tell the Ghost what to change. Alt+M switches mode.',
    );
  });

  it('hintForMode returns the hint of each mode', () => {
    expect(hintForMode('interact')).toBe(INTERACT_HINT);
    expect(hintForMode('edit')).toBe(EDIT_HINT);
    expect(hintForMode('ai-edit')).toBe(AI_EDIT_HINT);
  });
});
