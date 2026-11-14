import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { loadStack } from '../stacks/load-stack.ts';
import { EDIT_HINT, INTERACT_HINT } from '../state/hints.ts';
import { StackStoreContext } from '../state/StackStoreContext.tsx';
import { createStackStore } from '../state/stack-store.ts';
import { PropertyReadout } from './PropertyReadout.tsx';
import { StatusBar } from './StatusBar.tsx';

afterEach(cleanup);

function renderWithStore() {
  const loaded = loadStack(demoText);
  if (!loaded.ok) throw new Error('Demo_Stack must be valid');
  const store = createStackStore(loaded.stack);
  render(
    <StackStoreContext.Provider value={store}>
      <PropertyReadout />
      <StatusBar />
    </StackStoreContext.Provider>,
  );
  return store;
}

describe('PropertyReadout and StatusBar', () => {
  it('shows the card, the mode, the hint, and no readout in Interact mode', () => {
    renderWithStore();
    expect(screen.getByText('Card 1 of 3')).toBeTruthy();
    expect(screen.getByText('Mode: Interact')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(INTERACT_HINT);
    expect(screen.queryByLabelText('Properties')).toBeNull();
  });

  it('shows a prompt, then the rows of the selected Object, in Edit mode', () => {
    const store = renderWithStore();
    act(() => {
      store.getState().setMode('edit');
    });
    expect(screen.getByText('Mode: Edit')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(EDIT_HINT);
    expect(screen.getByText('Select an object to see its properties.')).toBeTruthy();

    act(() => {
      store.getState().selectObject('todo-add');
    });
    const region = screen.getByLabelText('Properties');
    expect(region.querySelectorAll('dt').length).toBeGreaterThan(7);
    expect(region.textContent).toContain('todo-add');
    expect(region.textContent).toContain('button');
    expect(region.querySelector('input, textarea, button, select')).toBeNull();
  });
});
