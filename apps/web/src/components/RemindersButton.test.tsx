import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../reminders/types.ts';
import { createEffectsStore } from '../state/effects-store.ts';
import { EffectsProvider } from '../state/EffectsContext.tsx';
import { RemindersButton } from './RemindersButton.tsx';

afterEach(cleanup);

function reminder(id: string, state: Reminder['state']): Reminder {
  return { id, stackId: 'one', message: `Message ${id}`, dueAt: 5_000_000, createdAt: 1, state };
}

function setup(reminders: readonly Reminder[] = []) {
  const store = createEffectsStore();
  store.getState().setReminders(reminders);
  const runtime = { cancelReminder: vi.fn(), dismissReminder: vi.fn() };
  render(
    <EffectsProvider store={store} runtime={runtime}>
      <RemindersButton />
    </EffectsProvider>,
  );
  return { store, runtime };
}

describe('RemindersButton', () => {
  it('renders nothing without an EffectsProvider', () => {
    const { container } = render(<RemindersButton />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the count of pending and missed reminders and follows the store', () => {
    const { store } = setup([
      reminder('a', 'pending'),
      reminder('b', 'missed'),
      reminder('c', 'fired'),
    ]);
    const button = screen.getByRole('button', { name: 'Reminders (2)' });
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    act(() => store.getState().setReminders([]));
    expect(screen.getByRole('button', { name: 'Reminders (0)' })).toBeTruthy();
  });

  it('opens the window, Escape closes it and focus returns to the button', async () => {
    setup([reminder('a', 'pending')]);
    const button = screen.getByRole('button', { name: 'Reminders (1)' });
    button.focus();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Reminders' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('Close returns focus to the button even if the click did not focus it', async () => {
    setup();
    const button = screen.getByRole('button', { name: 'Reminders (0)' });
    fireEvent.click(button);
    await screen.findByRole('dialog', { name: 'Reminders' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('Cancel in the open window reaches the runtime', async () => {
    const { runtime } = setup([reminder('a', 'pending')]);
    fireEvent.click(screen.getByRole('button', { name: 'Reminders (1)' }));
    await screen.findByRole('dialog', { name: 'Reminders' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(runtime.cancelReminder).toHaveBeenCalledExactlyOnceWith('a');
  });
});
