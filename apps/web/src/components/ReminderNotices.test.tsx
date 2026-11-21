import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createEffectsStore } from '../state/effects-store.ts';
import { EffectsProvider } from '../state/EffectsContext.tsx';
import { ReminderNotices } from './ReminderNotices.tsx';

afterEach(cleanup);

function setup() {
  const store = createEffectsStore();
  const view = render(
    <EffectsProvider store={store}>
      <ReminderNotices />
    </EffectsProvider>,
  );
  return { store, container: view.container };
}

describe('ReminderNotices', () => {
  it('renders nothing without an EffectsProvider', () => {
    const { container } = render(<ReminderNotices />);
    expect(container.innerHTML).toBe('');
  });

  it('keeps an empty polite live region without a role', () => {
    const { container } = setup();
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.hasAttribute('role')).toBe(false);
    expect(region?.children).toHaveLength(0);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows each notice with a Dismiss button that removes only that notice', () => {
    const { store, container } = setup();
    act(() => {
      store.getState().addNotice({ id: 'n1', text: 'Dentist is due' });
      store.getState().addNotice({ id: 'n2', text: 'Call Sam is due' });
    });
    const region = container.querySelector('[aria-live="polite"]');
    expect(region?.textContent).toContain('Dentist is due');
    expect(region?.textContent).toContain('Call Sam is due');
    const buttons = screen.getAllByRole('button', { name: 'Dismiss' });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute('aria-describedby')).not.toBeNull();
    fireEvent.click(buttons[0] as HTMLElement);
    expect(store.getState().notices.map((notice) => notice.id)).toEqual(['n2']);
    expect(screen.queryByText('Dentist is due')).toBeNull();
    expect(screen.getByText('Call Sam is due')).toBeTruthy();
  });

  it('keeps a notice until it is dismissed', () => {
    const { store } = setup();
    act(() => store.getState().addNotice({ id: 'n1', text: 'Still here' }));
    act(() => store.getState().setReminders([]));
    expect(screen.getByText('Still here')).toBeTruthy();
  });
});
