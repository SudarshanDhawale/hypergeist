import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createStack } from '@hypergeist/shared/engine';
import type { Stack } from '@hypergeist/shared/format';
import { createMemoryRepository } from '../persistence/memory-repository.ts';
import type { AiController } from '../state/ai-controller.ts';
import { createAiStore } from '../state/ai-store.ts';
import { AiProvider } from '../state/AiContext.tsx';
import { createEffectsStore } from '../state/effects-store.ts';
import { EffectsProvider } from '../state/EffectsContext.tsx';
import { PersistenceProvider } from '../state/PersistenceContext.tsx';
import { StackStoreProvider } from '../state/StackStoreContext.tsx';
import { MenuBar } from './MenuBar.tsx';

afterEach(cleanup);

function makeStack(id: string, name: string): Stack {
  const made = createStack({ id, name });
  if (!made.ok) throw new Error('test stack must be valid');
  return made.stack;
}

const STACK = makeStack('one', 'One');

function renderBar(withPersistence: boolean) {
  const bar = (
    <StackStoreProvider stack={STACK}>
      <MenuBar />
    </StackStoreProvider>
  );
  if (!withPersistence) return render(bar);
  const repository = createMemoryRepository({
    initial: { stacks: [{ stack: STACK, savedAt: 1000, origin: 'user' }] },
  });
  return render(
    <PersistenceProvider
      repository={repository}
      seeds={[]}
      openStackId="one"
      now={() => 2000}
      onOpenStack={() => undefined}
    >
      {bar}
    </PersistenceProvider>,
  );
}

describe('MenuBar Stacks button', () => {
  it('is absent without a PersistenceProvider', () => {
    renderBar(false);
    expect(screen.queryByRole('button', { name: 'Stacks' })).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeTruthy();
  });

  it('opens the Stacks window', async () => {
    renderBar(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stacks' }));
    expect(await screen.findByRole('dialog', { name: 'Stacks' })).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'Stacks' })).toBeTruthy();
  });

  it('Escape closes the window and returns focus to the Stacks button', async () => {
    renderBar(true);
    const button = screen.getByRole('button', { name: 'Stacks' });
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Stacks' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('Close returns focus to the Stacks button even if the browser did not focus it on click', async () => {
    renderBar(true);
    const button = screen.getByRole('button', { name: 'Stacks' });
    // Like Safari: the click does not focus the button.
    fireEvent.click(button);
    await screen.findByRole('dialog', { name: 'Stacks' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('has no AI settings button or counter without an AiProvider', () => {
    renderBar(true);
    expect(screen.queryByRole('button', { name: 'AI settings' })).toBeNull();
    expect(screen.queryByText(/Demo:/u)).toBeNull();
  });

  it('with an AiProvider: opens AI settings, shows the counter, Escape returns focus', async () => {
    const store = createAiStore();
    store.getState().setQuota({ remaining: 4 });
    const controller = { init: () => Promise.resolve() } as unknown as AiController;
    render(
      <AiProvider controller={controller} store={store}>
        <StackStoreProvider stack={STACK}>
          <MenuBar />
        </StackStoreProvider>
      </AiProvider>,
    );
    expect(screen.getByText('Demo: 4 left today')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'AI settings' });
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'AI settings' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('keeps the Stacks button and the mode control in the menu bar', () => {
    const { container } = renderBar(true);
    const bar = container.querySelector('header.menu-bar');
    expect(bar?.querySelector('.mode-control')).not.toBeNull();
    expect(bar?.querySelector('button')?.textContent).toBe('Stacks');
  });
});

describe('MenuBar Reminders button', () => {
  it('is absent without an EffectsProvider', () => {
    renderBar(true);
    expect(screen.queryByRole('button', { name: /^Reminders/u })).toBeNull();
  });

  it('with an EffectsProvider: shows the count, opens the window, Escape returns focus', async () => {
    const store = createEffectsStore();
    store.getState().setReminders([
      {
        id: 'r1',
        stackId: 'one',
        message: 'Call Sam',
        dueAt: 5_000_000,
        createdAt: 1,
        state: 'pending',
      },
    ]);
    render(
      <EffectsProvider store={store}>
        <StackStoreProvider stack={STACK}>
          <MenuBar />
        </StackStoreProvider>
      </EffectsProvider>,
    );
    const button = screen.getByRole('button', { name: 'Reminders (1)' });
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Reminders' });
    expect(screen.getByText('Call Sam')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('sits right after the AI settings button', () => {
    const aiStore = createAiStore();
    const controller = { init: () => Promise.resolve() } as unknown as AiController;
    const { container } = render(
      <AiProvider controller={controller} store={aiStore}>
        <EffectsProvider store={createEffectsStore()}>
          <StackStoreProvider stack={STACK}>
            <MenuBar />
          </StackStoreProvider>
        </EffectsProvider>
      </AiProvider>,
    );
    const names = Array.from(container.querySelectorAll('header.menu-bar > button')).map(
      (button) => button.textContent,
    );
    expect(names).toEqual(['AI settings', 'Reminders (0)']);
  });
});
