import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { loadStack } from '../stacks/load-stack.ts';
import { createSaveStateStore } from '../state/save-state-store.ts';
import { SaveStateProvider } from '../state/SaveStateContext.tsx';
import { StackStoreProvider, useStackStoreApi } from '../state/StackStoreContext.tsx';
import { StackWindow } from './StackWindow.tsx';

afterEach(cleanup);

function renderWindow() {
  const loaded = loadStack(demoText);
  if (!loaded.ok) throw new Error('Demo_Stack must be valid');
  let api: ReturnType<typeof useStackStoreApi> | undefined;
  function Capture() {
    api = useStackStoreApi();
    return null;
  }
  const view = render(
    <StackStoreProvider stack={loaded.stack}>
      <StackWindow />
      <Capture />
    </StackStoreProvider>,
  );
  if (api === undefined) throw new Error('store missing');
  return { ...view, store: api, name: loaded.stack.name };
}

describe('StackWindow smoke test', () => {
  it('renders the parts in order, named by the title bar, without the old notice', () => {
    const { container, name } = renderWindow();
    const section = container.querySelector('section.window.stack-window');
    expect(section).not.toBeNull();
    expect(screen.getByRole('region', { name })).toBe(section);
    const classes = Array.from(section?.children ?? []).map((child) => child.className);
    expect(classes).toEqual(['title-bar', 'canvas-frame', 'link-bar', 'status-bar']);
    expect(section?.querySelector('.title-bar > h2')?.textContent).toBe(name);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('puts the Memory_Mode banner and the save indicator between the link bar and the status bar', () => {
    const loaded = loadStack(demoText);
    if (!loaded.ok) throw new Error('Demo_Stack must be valid');
    const { container } = render(
      <SaveStateProvider store={createSaveStateStore()} memoryMode={true} onExport={vi.fn()}>
        <StackStoreProvider stack={loaded.stack}>
          <StackWindow />
        </StackStoreProvider>
      </SaveStateProvider>,
    );
    const classes = Array.from(container.querySelector('.stack-window')?.children ?? []).map(
      (child) => child.className,
    );
    expect(classes).toEqual([
      'title-bar',
      'canvas-frame',
      'link-bar',
      'memory-banner',
      'save-indicator-row',
      'status-bar',
    ]);
  });

  it('adds the Property_Readout in Edit mode only', () => {
    const { container, store } = renderWindow();
    expect(container.querySelector('.property-readout')).toBeNull();
    act(() => store.getState().setMode('edit'));
    expect(container.querySelector('.property-readout')).not.toBeNull();
  });
});
