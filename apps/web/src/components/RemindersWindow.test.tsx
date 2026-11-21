import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../reminders/types.ts';
import { createEffectsStore } from '../state/effects-store.ts';
import type { EffectsStoreApi } from '../state/effects-store.ts';
import { EffectsProvider } from '../state/EffectsContext.tsx';
import type { EffectsActions } from '../state/EffectsContext.tsx';
import {
  countOpenReminders,
  formatDueTime,
  NO_REMINDERS_TEXT,
  REMINDERS_LIMIT_TEXT,
  RemindersWindow,
} from './RemindersWindow.tsx';

afterEach(cleanup);

function reminder(overrides: Partial<Reminder> & Pick<Reminder, 'id'>): Reminder {
  return {
    stackId: 'one',
    message: `Message ${overrides.id}`,
    dueAt: Date.UTC(2030, 0, 2, 3, 4),
    createdAt: 1000,
    state: 'pending',
    ...overrides,
  };
}

function setup(reminders: readonly Reminder[], withRuntime = true) {
  const store: EffectsStoreApi = createEffectsStore();
  store.getState().setReminders(reminders);
  const runtime = { cancelReminder: vi.fn(), dismissReminder: vi.fn() } satisfies EffectsActions;
  const onClose = vi.fn();
  render(
    <EffectsProvider store={store} runtime={withRuntime ? runtime : null}>
      <RemindersWindow onClose={onClose} />
    </EffectsProvider>,
  );
  return { store, runtime, onClose };
}

describe('RemindersWindow', () => {
  it('renders nothing without an EffectsProvider', () => {
    render(<RemindersWindow onClose={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the empty message and the limit sentence', () => {
    setup([]);
    const dialog = screen.getByRole('dialog', { name: 'Reminders' });
    expect(within(dialog).getByText(NO_REMINDERS_TEXT)).toBeTruthy();
    expect(NO_REMINDERS_TEXT).toBe('No reminders.');
    expect(within(dialog).getByText(REMINDERS_LIMIT_TEXT)).toBeTruthy();
    expect(REMINDERS_LIMIT_TEXT).toBe(
      'Reminders fire only while HyperGeist is open or installed. If the browser or system blocks notifications, they show inside HyperGeist only.',
    );
    expect(within(dialog).queryByRole('list', { name: 'Reminders' })).toBeNull();
  });

  it('lists message, local due time and state for each reminder, sorted by due time', () => {
    const later = reminder({ id: 'b', message: 'Later one', dueAt: Date.UTC(2031, 5, 6, 7, 8) });
    const sooner = reminder({
      id: 'a',
      message: 'Sooner one',
      dueAt: Date.UTC(2030, 5, 6, 7, 8),
      state: 'fired',
    });
    const missed = reminder({
      id: 'c',
      message: 'Missed one',
      dueAt: Date.UTC(2029, 5, 6, 7, 8),
      state: 'missed',
    });
    setup([later, sooner, missed]);
    const items = within(screen.getByRole('list', { name: 'Reminders' })).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items.map((item) => within(item).getByText(/one$/u).textContent)).toEqual([
      'Missed one',
      'Sooner one',
      'Later one',
    ]);
    const [first, second, third] = items;
    expect(within(first as HTMLElement).getByText(formatDueTime(missed.dueAt))).toBeTruthy();
    expect(
      within(first as HTMLElement).getByText('Missed while HyperGeist was closed'),
    ).toBeTruthy();
    expect(within(second as HTMLElement).getByText(formatDueTime(sooner.dueAt))).toBeTruthy();
    expect(within(second as HTMLElement).getByText('Fired')).toBeTruthy();
    expect(within(third as HTMLElement).getByText(formatDueTime(later.dueAt))).toBeTruthy();
    expect(within(third as HTMLElement).getByText('Pending')).toBeTruthy();
  });

  it('formats the due time in the user locale', () => {
    const dueAt = Date.UTC(2030, 0, 2, 3, 4);
    expect(formatDueTime(dueAt)).toBe(new Date(dueAt).toLocaleString());
    expect(formatDueTime(Number.MAX_SAFE_INTEGER)).toBe('unknown time');
  });

  it('Cancel on a pending reminder calls cancelReminder with its id', () => {
    const { runtime } = setup([reminder({ id: 'p1' })]);
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button.getAttribute('aria-describedby')).not.toBeNull();
    fireEvent.click(button);
    expect(runtime.cancelReminder).toHaveBeenCalledExactlyOnceWith('p1');
    expect(runtime.dismissReminder).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it.each(['fired', 'missed'] as const)(
    'Dismiss on a %s reminder calls dismissReminder with its id',
    (state) => {
      const { runtime } = setup([reminder({ id: 'x1', state })]);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(runtime.dismissReminder).toHaveBeenCalledExactlyOnceWith('x1');
      expect(runtime.cancelReminder).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    },
  );

  it('disables the action buttons when there is no runtime', () => {
    setup([reminder({ id: 'p1' })], false);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
  });

  it('follows the store when a reminder is removed', () => {
    const { store } = setup([reminder({ id: 'p1' })]);
    expect(screen.getByRole('list', { name: 'Reminders' })).toBeTruthy();
    store.getState().setReminders([]);
    return screen.findByText(NO_REMINDERS_TEXT);
  });

  it('Escape and Close call onClose', () => {
    const { onClose } = setup([]);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Reminders' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('describes the dialog with the limit sentence', () => {
    setup([]);
    const dialog = screen.getByRole('dialog', { name: 'Reminders' });
    const id = dialog.getAttribute('aria-describedby');
    expect(id).not.toBeNull();
    expect(document.getElementById(id ?? '')?.textContent).toBe(REMINDERS_LIMIT_TEXT);
  });
});

describe('countOpenReminders', () => {
  it('counts pending and missed, not fired', () => {
    expect(
      countOpenReminders([
        reminder({ id: 'a', state: 'pending' }),
        reminder({ id: 'b', state: 'missed' }),
        reminder({ id: 'c', state: 'fired' }),
      ]),
    ).toBe(2);
    expect(countOpenReminders([])).toBe(0);
  });
});
