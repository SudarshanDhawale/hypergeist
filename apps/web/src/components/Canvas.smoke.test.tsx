import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { loadStack } from '../stacks/load-stack.ts';
import { StackStoreProvider, useStackStoreApi } from '../state/StackStoreContext.tsx';
import { Canvas } from './Canvas.tsx';

function renderCanvas() {
  const loaded = loadStack(demoText);
  if (!loaded.ok) throw new Error('Demo_Stack must be valid');
  let api: ReturnType<typeof useStackStoreApi> | undefined;
  function Capture() {
    api = useStackStoreApi();
    return null;
  }
  const view = render(
    <StackStoreProvider stack={loaded.stack}>
      <Canvas />
      <Capture />
    </StackStoreProvider>,
  );
  if (api === undefined) throw new Error('store missing');
  return { ...view, store: api };
}

describe('Canvas smoke test', () => {
  it('renders the Demo_Stack to-do card at scale 1 in Interact mode', () => {
    const { container } = renderCanvas();
    const canvas = container.querySelector('.canvas');
    expect(canvas?.getAttribute('data-mode')).toBe('interact');
    expect(canvas?.getAttribute('data-scale')).toBe('1');
    expect(screen.getByRole('button', { name: 'Add item' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'New item' })).toBeTruthy();
    expect(container.querySelector('.selection-overlay')).toBeNull();
  });

  it('selects an object in Edit mode with 8 handles, and Escape clears it', () => {
    const { container, store } = renderCanvas();
    act(() => store.getState().setMode('edit'));
    fireEvent.click(container.querySelector('.canvas-object[data-type="button"]') as Element);
    expect(store.getState().selectedObjectId).toBe('todo-add');
    expect(container.querySelectorAll('.selection-overlay .selection-handle')).toHaveLength(8);
    fireEvent.keyDown(container.querySelector('.canvas') as Element, { key: 'Escape' });
    expect(store.getState().selectedObjectId).toBeNull();
  });
});
