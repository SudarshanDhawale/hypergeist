import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { loadStack } from '../stacks/load-stack.ts';
import { EDIT_HINT, INTERACT_HINT } from '../state/hints.ts';
import { StackStoreContext } from '../state/StackStoreContext.tsx';
import { createStackStore } from '../state/stack-store.ts';
import type { StackStoreApi } from '../state/stack-store.ts';
import { StatusBar } from './StatusBar.tsx';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  const loaded = loadStack(demoText);
  if (!loaded.ok) throw new Error('Demo_Stack must be valid');
  const store = createStackStore(loaded.stack);
  const view = render(
    <StackStoreContext.Provider value={store}>
      <StatusBar />
    </StackStoreContext.Provider>,
  );
  return { store, view };
}

/** Posts a message the way the store does: a new `seq` per message. */
function post(store: StackStoreApi, text: string): void {
  act(() => {
    const seq = store.getState().statusSeq + 1;
    store.setState({ status: { text, seq }, statusSeq: seq });
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function hint(): string {
  return screen.getByRole('status').textContent;
}

describe('StatusBar Hint_Line timing', () => {
  it('replaces the mode hint with a message from the store', () => {
    const { store } = setup();
    expect(hint()).toBe(INTERACT_HINT);
    post(store, 'Item added.');
    expect(hint()).toBe('Item added.');
  });

  it('shows a message from a real Button action and restores the hint after 4000 ms', () => {
    const { store } = setup();
    act(() => {
      store.getState().typeInField('todo-input', 'milk');
      store.getState().activateButton('todo-add');
    });
    expect(hint()).toBe('Item added.');
    advance(3999);
    expect(hint()).toBe('Item added.');
    advance(1);
    expect(hint()).toBe(INTERACT_HINT);
    expect(store.getState().status).toBeNull();
  });

  it('restores the hint of the current mode after 4000 ms', () => {
    const { store } = setup();
    act(() => {
      store.getState().setMode('edit');
    });
    post(store, 'Hello');
    advance(3999);
    expect(hint()).toBe('Hello');
    advance(1);
    expect(hint()).toBe(EDIT_HINT);
  });

  it('restarts the 4 seconds for a newer message, and the earlier timer does not clear it', () => {
    const { store } = setup();
    post(store, 'First');
    advance(3000);
    post(store, 'Second');
    advance(1000); // 4000 ms after First, 1000 ms after Second
    expect(hint()).toBe('Second');
    advance(2999);
    expect(hint()).toBe('Second');
    advance(1);
    expect(hint()).toBe(INTERACT_HINT);
  });

  it('restarts the period when the same text is posted again', () => {
    const { store } = setup();
    post(store, 'Same');
    advance(3000);
    post(store, 'Same');
    advance(3999);
    expect(hint()).toBe('Same');
    advance(1);
    expect(hint()).toBe(INTERACT_HINT);
  });

  it('clears the message at once when the mode changes', () => {
    const { store } = setup();
    post(store, 'Item added.');
    act(() => {
      store.getState().setMode('edit');
    });
    expect(hint()).toBe(EDIT_HINT);
    expect(screen.getByText('Mode: Edit')).toBeTruthy();
  });

  it('does not let a message cleared by a mode switch cut short the next one', () => {
    const { store } = setup();
    post(store, 'Old');
    advance(2000);
    act(() => {
      store.getState().toggleMode();
    });
    post(store, 'New');
    advance(3999);
    expect(hint()).toBe('New');
    advance(1);
    expect(hint()).toBe(EDIT_HINT);
  });

  it('leaves the text unchanged when an action returns no message', () => {
    const { store } = setup();
    act(() => {
      store.getState().typeInField('todo-input', 'milk');
    });
    expect(hint()).toBe(INTERACT_HINT);
    post(store, 'Kept');
    act(() => {
      store.getState().typeInField('todo-input', 'milk and eggs');
    });
    expect(hint()).toBe('Kept');
  });

  it('announces the message in a polite live region that stays mounted', () => {
    const { store } = setup();
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    post(store, 'Item added.');
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('Item added.');
    advance(4000);
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe(INTERACT_HINT);
  });

  it('clears the timer on unmount', () => {
    const { store, view } = setup();
    post(store, 'Item added.');
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    advance(4000);
    expect(store.getState().status?.text).toBe('Item added.');
  });
});
