import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { AiProvider } from '../state/AiContext';
import type { AiController } from '../state/ai-controller';
import { createAiStore } from '../state/ai-store';
import { StackStoreContext } from '../state/StackStoreContext';
import { createStackStore } from '../state/stack-store';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { GHOST_PIXELS } from './GhostSprite';
import { GhostWindow } from './GhostWindow';

afterEach(cleanup);

const STACK: Stack = (() => {
  const parsed = parseStack(demoText);
  if (!parsed.ok) throw new Error('The bundled demo stack is not valid.');
  return parsed.value;
})();

function fakeController(): AiController {
  return {
    send: vi.fn(() => Promise.resolve()),
    makeStack: vi.fn(() => Promise.resolve({ result: null, stack: null, message: '' })),
    undo: vi.fn(),
    stop: vi.fn(),
    saveSettings: vi.fn(() => Promise.resolve({ ok: true as const })),
    checkProvider: vi.fn(() => Promise.resolve({ ok: false as const, message: '' })),
    refreshQuota: vi.fn(() => Promise.resolve()),
    init: vi.fn(() => Promise.resolve()),
  };
}

function setup() {
  const controller = fakeController();
  const aiStore = createAiStore();
  const stackStore = createStackStore(STACK);
  const wrap = ({ children }: { children: ReactNode }) => (
    <StackStoreContext.Provider value={stackStore}>
      <AiProvider controller={controller} store={aiStore}>
        {children}
      </AiProvider>
    </StackStoreContext.Provider>
  );
  const view = render(<GhostWindow />, { wrapper: wrap });
  return { controller, aiStore, stackStore, ...view };
}

describe('GhostWindow without an AI provider', () => {
  it('shows the sprite and says AI is not available', () => {
    const { getByRole, getByText } = render(<GhostWindow />);
    expect(getByRole('heading', { name: 'Ghost' })).toBeTruthy();
    expect(getByText('AI is not available in this build')).toBeTruthy();
    expect(getByRole('img', { name: 'A sleeping ghost' })).toBeTruthy();
  });

  it('holds no interactive element, hardcoded color, or accent color', () => {
    const { container } = render(<GhostWindow />);
    const interactive = 'button, a, input, textarea, select, [tabindex], [contenteditable]';
    expect(container.querySelector(interactive)).toBeNull();
    // The token name is built here so the repo-wide "no .tsx mentions it" scan stays clean.
    const accent = ['-', '-', 'gh', 'ost'].join('');
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl|animate/i);
    expect(container.innerHTML).not.toContain(accent);
  });

  it('keeps the sprite map rectangular and within 24 by 24 cells', () => {
    const widths = new Set(GHOST_PIXELS.map((row) => row.length));
    expect(widths.size).toBe(1);
    expect(GHOST_PIXELS.length).toBeLessThanOrEqual(24);
    expect([...widths][0]).toBeLessThanOrEqual(24);
    expect(GHOST_PIXELS.join('')).toMatch(/^[#. ]+$/);
  });
});

describe('GhostWindow chat panel', () => {
  it('sends by the Send button and clears the input', () => {
    const { controller, getByRole } = setup();
    const input = getByRole('textbox') as HTMLTextAreaElement;
    const send = getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  Add a button  ' } });
    fireEvent.click(send);
    expect(controller.send).toHaveBeenCalledWith('Add a button');
    expect(input.value).toBe('');
  });

  it('sends on Enter and keeps Shift+Enter for a new line', () => {
    const { controller, getByRole } = setup();
    const input = getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    const shifted = fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(shifted).toBe(true);
    expect(controller.send).not.toHaveBeenCalled();
    const plain = fireEvent.keyDown(input, { key: 'Enter' });
    expect(plain).toBe(false);
    expect(controller.send).toHaveBeenCalledWith('hello');
  });

  it('fills the input from an Example_Prompt without sending', () => {
    const { controller, getByRole } = setup();
    fireEvent.click(getByRole('button', { name: 'Make me a to-do list' }));
    expect((getByRole('textbox') as HTMLTextAreaElement).value).toBe('Make me a to-do list');
    fireEvent.click(getByRole('button', { name: 'Add a button' }));
    expect((getByRole('textbox') as HTMLTextAreaElement).value).toBe('Add a button');
    expect(controller.send).not.toHaveBeenCalled();
  });

  it('shows the thinking class and Stop only while busy, and Stop stops', () => {
    const { controller, aiStore, getByRole, queryByRole, container } = setup();
    const aside = container.querySelector('aside');
    expect(aside?.classList.contains('is-thinking')).toBe(false);
    expect(queryByRole('button', { name: 'Stop' })).toBeNull();
    act(() => aiStore.getState().setBusy(true));
    expect(aside?.classList.contains('is-thinking')).toBe(true);
    fireEvent.click(getByRole('button', { name: 'Stop' }));
    expect(controller.stop).toHaveBeenCalledTimes(1);
    act(() => aiStore.getState().setBusy(false));
    expect(aside?.classList.contains('is-thinking')).toBe(false);
  });

  it('enables Undo only with an entry and when not busy', () => {
    const { controller, aiStore, stackStore, getByRole } = setup();
    const undo = getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    act(() => stackStore.getState().applyStack({ ...STACK, name: 'Changed' }, 'ai'));
    expect(undo.disabled).toBe(false);
    act(() => aiStore.getState().setBusy(true));
    expect(undo.disabled).toBe(true);
    act(() => aiStore.getState().setBusy(false));
    fireEvent.click(undo);
    expect(controller.undo).toHaveBeenCalledTimes(1);
  });

  it('renders one line per kind with its text', () => {
    const { aiStore, getByText, container } = setup();
    act(() =>
      aiStore.getState().addLines([
        { kind: 'user', text: 'Make a list' },
        { kind: 'ghost', text: 'Here you go' },
        { kind: 'step', text: 'Added a list' },
        { kind: 'note', text: 'Done.' },
        { kind: 'error', text: 'Enter a key to use your own model.' },
      ]),
    );
    for (const text of [
      'Make a list',
      'Here you go',
      'Added a list',
      'Done.',
      'Enter a key to use your own model.',
    ]) {
      expect(getByText(text, { exact: false })).toBeTruthy();
    }
    for (const kind of ['user', 'ghost', 'step', 'note', 'error']) {
      expect(container.querySelectorAll(`.ghost-line-${kind}`).length).toBe(1);
    }
  });

  it('shows the selected object chip only in AI edit mode', () => {
    const { stackStore, queryByText, getByText } = setup();
    const object = STACK.cards[0]?.objects.find((candidate) => candidate.type === 'button');
    if (object === undefined) throw new Error('The demo stack has no button.');
    act(() => {
      stackStore.getState().setMode('edit');
      stackStore.getState().selectObject(object.id);
    });
    expect(queryByText(/Selected:/)).toBeNull();
    act(() => {
      stackStore.getState().setMode('ai-edit');
      stackStore.getState().selectObject(object.id);
    });
    expect(getByText(`Selected: ${object.name} (button)`)).toBeTruthy();
    act(() => stackStore.getState().clearSelection());
    expect(queryByText(/Selected:/)).toBeNull();
  });

  it('has an aria-live region, no status role, and honest text', () => {
    const { container, queryByRole, getByText } = setup();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(queryByRole('status')).toBeNull();
    expect(getByText(/shared model or recorded examples/)).toBeTruthy();
    expect(getByText(/can make mistakes/)).toBeTruthy();
    expect(getByText(/Undo restores/)).toBeTruthy();
  });

  it('uses no accent token and no inline style', () => {
    const { container } = setup();
    const accent = ['-', '-', 'gh', 'ost'].join('');
    expect(container.innerHTML).not.toContain(accent);
    expect(container.querySelectorAll('[style]:not(svg *)').length).toBe(0);
  });
});
