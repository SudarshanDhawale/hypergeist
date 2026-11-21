import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createStack } from '@hypergeist/shared/engine';
import { createKeyHolder, createSettingsRepository } from '../ai/index.ts';
import { createAiController } from '../state/ai-controller.ts';
import type { KeyHolder, SettingsRepository } from '../state/ai-controller.ts';
import { createAiStore } from '../state/ai-store.ts';
import type { AiStoreApi } from '../state/ai-store.ts';
import { AiProvider } from '../state/AiContext.tsx';
import { createStackStore } from '../state/stack-store.ts';
import { AiSettingsDialog } from './AiSettingsDialog.tsx';

afterEach(cleanup);

const STACK = (() => {
  const made = createStack({ id: 'one', name: 'One' });
  if (!made.ok) throw new Error('test stack must be valid');
  return made.stack;
})();

type Setup = {
  readonly aiStore: AiStoreApi;
  readonly keyHolder: KeyHolder;
  readonly settingsRepo: SettingsRepository;
};

function setup(): Setup {
  const aiStore = createAiStore();
  const keyHolder = createKeyHolder();
  const settingsRepo = createSettingsRepository(new IDBFactory(), { name: 'dialog-test' });
  return { aiStore, keyHolder, settingsRepo };
}

function Harness({ env }: { readonly env: Setup }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const controller = createAiController({
    stackStore: createStackStore(STACK),
    aiStore: env.aiStore,
    settingsRepo: env.settingsRepo,
    keyHolder: env.keyHolder,
    // Nothing answers: the check reports that the provider cannot be reached.
    fetch: () => Promise.reject(new TypeError('offline')),
    scenarios: [],
    now: () => 0,
  });
  return (
    <AiProvider controller={controller} store={env.aiStore}>
      <button ref={buttonRef} type="button" onClick={() => setOpen(true)}>
        AI settings
      </button>
      {open ? (
        <AiSettingsDialog
          onClose={() => {
            setOpen(false);
            buttonRef.current?.focus();
          }}
        />
      ) : null}
    </AiProvider>
  );
}

function openDialog(env: Setup = setup()): Setup {
  render(<Harness env={env} />);
  fireEvent.click(screen.getByRole('button', { name: 'AI settings' }));
  return env;
}

function chooseOwn(): void {
  fireEvent.click(screen.getByRole('radio', { name: 'My own model' }));
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('AiSettingsDialog', () => {
  it('renders nothing without a provider', () => {
    render(<AiSettingsDialog onClose={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts in demo mode with the demo sentence and no own-model fields', () => {
    openDialog();
    expect(screen.getByRole('dialog', { name: 'AI settings' })).toBeTruthy();
    const demo = screen.getByRole<HTMLInputElement>('radio', { name: 'Demo (no key needed)' });
    expect(demo.checked).toBe(true);
    expect(
      screen.getByText(/go through this app's server to a hosted model provider/u),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Base URL')).toBeNull();
  });

  it('shows base URL, model name and a password key field for My own model', () => {
    openDialog();
    chooseOwn();
    expect(screen.getByLabelText('Base URL')).toBeTruthy();
    expect(screen.getByLabelText('Model name')).toBeTruthy();
    expect(screen.getByLabelText('Key').getAttribute('type')).toBe('password');
    expect(screen.getByText(/kept only in memory/u)).toBeTruthy();
    expect(screen.getByText(/must enter it again after you reload/u)).toBeTruthy();
    expect(
      screen.getByText(
        'With your own model, the stack and your message are sent to that provider.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check this model' })).toBeTruthy();
  });

  it('shows the validation message for a bad base URL', () => {
    openDialog();
    chooseOwn();
    fill('Base URL', 'http://example.com/v1');
    expect(screen.getByLabelText('Base URL').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/https/u)).toBeTruthy();
    fill('Base URL', 'https://api.example.com/v1');
    expect(screen.getByLabelText('Base URL').getAttribute('aria-invalid')).toBe('false');
  });

  it('refuses to save an own model with no base URL and shows the message', async () => {
    const env = openDialog();
    chooseOwn();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter the web address of the provider.')).toBeTruthy();
    expect(env.aiStore.getState().settings.provider).toBe('demo');
  });

  it('Check this model shows the capability messages', async () => {
    const env = openDialog();
    chooseOwn();
    fill('Base URL', 'https://api.example.com/v1');
    fill('Model name', 'm1');
    fill('Key', 'secret-key');
    fireEvent.click(screen.getByRole('button', { name: 'Check this model' }));
    const list = await screen.findByRole('list', { name: 'Check results' });
    expect(list.querySelectorAll('li').length).toBeGreaterThan(0);
    expect(env.aiStore.getState().capability?.reachable).toBe(false);
    expect(list.textContent).not.toContain('secret-key');
  });

  it('Save writes the settings to the repository and the key to the key holder only', async () => {
    const env = openDialog();
    chooseOwn();
    fill('Base URL', 'https://api.example.com/v1');
    fill('Model name', 'm1');
    fill('Key', 'secret-key');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(env.aiStore.getState().settings).toEqual({
      provider: 'own',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
    });
    expect(env.aiStore.getState().hasKey).toBe(true);
    expect(env.keyHolder.get()).toBe('secret-key');
    const stored = await env.settingsRepo.load();
    expect(JSON.stringify(stored)).not.toContain('secret-key');
    expect(JSON.stringify(stored)).toContain('api.example.com');
  });

  it('Save in demo mode keeps the demo provider', async () => {
    const env = openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(env.aiStore.getState().settings.provider).toBe('demo');
  });

  it('Escape closes the dialog and focus returns to the button', async () => {
    openDialog();
    const button = screen.getByRole('button', { name: 'AI settings' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });
});
