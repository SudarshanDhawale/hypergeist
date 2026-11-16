import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSaveStateStore } from '../state/save-state-store.ts';
import { SaveStateProvider } from '../state/SaveStateContext.tsx';
import { SaveIndicator } from './SaveIndicator.tsx';

afterEach(cleanup);

function setup() {
  const store = createSaveStateStore();
  const onExport = vi.fn();
  const view = render(
    <SaveStateProvider store={store} memoryMode={false} onExport={onExport}>
      <SaveIndicator />
    </SaveStateProvider>,
  );
  return { store, onExport, view };
}

describe('SaveIndicator', () => {
  it('renders nothing without a provider', () => {
    const { container } = render(<SaveIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('shows "Saved" and no Export button at first', () => {
    const { view } = setup();
    expect(view.container.querySelector('.save-indicator')?.textContent).toBe('Saved');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows "Saving"', () => {
    const { store, view } = setup();
    act(() => store.getState().markSaving());
    expect(view.container.querySelector('.save-indicator')?.textContent).toBe('Saving');
  });

  it('shows "Not saved" with the reason', () => {
    const { store, view } = setup();
    act(() => store.getState().markNotSaved('The browser could not write', false));
    expect(view.container.querySelector('.save-indicator')?.textContent).toBe(
      'Not saved: The browser could not write',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Export only when canExport is true, and calls onExport on click', () => {
    const { store, onExport } = setup();
    act(() => store.getState().markNotSaved("The browser's storage is full", true));
    const button = screen.getByRole('button', { name: 'Export this stack' });
    fireEvent.click(button);
    expect(onExport).toHaveBeenCalledTimes(1);
    act(() => store.getState().markSaved());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('uses aria-live="polite" and no role of its own', () => {
    const { store, view } = setup();
    act(() => store.getState().markNotSaved('Storage is full', true));
    const live = view.container.querySelector('.save-indicator');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(view.container.querySelector('[role]')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
