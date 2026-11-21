import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStack } from '@hypergeist/shared/engine';
import { validateStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { createKeyHolder, createSettingsRepository, loadScenarios } from '../ai/index.ts';
import type { Provider } from '../ai/index.ts';
import {
  createScriptedProvider,
  providerFailure,
  reply,
  resetToolCallIds,
  toolCall,
} from '../ai/testing/scripted-provider.ts';
import { createMemoryRepository } from '../persistence/memory-repository.ts';
import type { MemoryRepository } from '../persistence/memory-repository.ts';
import { AiProvider } from '../state/AiContext.tsx';
import { createAiController } from '../state/ai-controller.ts';
import type { AiControllerDeps } from '../state/ai-controller.ts';
import { createAiStore } from '../state/ai-store.ts';
import { PersistenceProvider } from '../state/PersistenceContext.tsx';
import { createStackStore } from '../state/stack-store.ts';
import { StacksWindow } from './StacksWindow.tsx';

afterEach(() => {
  cleanup();
  resetToolCallIds();
});

const SAVED_AT = Date.UTC(2026, 10, 15, 14, 30);

function makeStack(id: string, name: string): Stack {
  const made = createStack({ id, name });
  if (!made.ok) throw new Error('test stack must be valid');
  return made.stack;
}

const DEMO = makeStack('demo', 'Demo stack');

/** The shared model is down (503), so the recorded examples answer. */
const offlineFetch = ((): Promise<Response> =>
  Promise.resolve(new Response('{}', { status: 503 }))) as typeof fetch;

type Setup = {
  readonly provider?: Provider;
  readonly beforeAction?: () => Promise<void>;
  readonly withAi?: boolean;
};

function setup(options: Setup = {}) {
  const repository: MemoryRepository = createMemoryRepository({
    initial: { stacks: [{ stack: DEMO, savedAt: SAVED_AT, origin: 'seed' as const }] },
  });
  const aiStore = createAiStore();
  const stackStore = createStackStore(DEMO);
  const provider = options.provider;
  const deps: AiControllerDeps = {
    stackStore,
    aiStore,
    settingsRepo: createSettingsRepository(null),
    keyHolder: createKeyHolder(),
    fetch: offlineFetch,
    scenarios: loadScenarios().scenarios,
    now: () => 0,
    ...(provider === undefined
      ? {}
      : {
          chooseChain: () => ({ ok: true as const, chain: [provider], label: 'own' as const }),
        }),
  };
  const controller = createAiController(deps);
  let clock = 10_000;
  const onOpenStack = vi.fn();
  const onClose = vi.fn();
  const window = (
    <PersistenceProvider
      repository={repository}
      seeds={[{ stack: DEMO }]}
      openStackId="demo"
      now={() => (clock += 1000)}
      onOpenStack={onOpenStack}
      onStacksChanged={vi.fn()}
      beforeAction={options.beforeAction}
    >
      <StacksWindow onClose={onClose} />
    </PersistenceProvider>
  );
  render(
    options.withAi === false ? (
      window
    ) : (
      <AiProvider controller={controller} store={aiStore}>
        {window}
      </AiProvider>
    ),
  );
  return { repository, aiStore, onOpenStack, onClose };
}

function input(): HTMLInputElement {
  const field = screen.getByRole('textbox', { name: 'Describe the stack' });
  if (!(field instanceof HTMLInputElement)) throw new Error('expected an input');
  return field;
}

async function ready() {
  const list = await screen.findByRole('list', { name: 'Stacks' });
  await waitFor(() => expect(within(list).queryByText('Loading stacks.')).toBeNull());
}

function submit(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Make it' }));
}

function scripted(script: Parameters<typeof createScriptedProvider>[0]) {
  return createScriptedProvider(script, { kind: 'direct' });
}

describe('MakeStackSection', () => {
  it('renders nothing AI-related without an AI provider', async () => {
    setup({ withAi: false });
    await ready();
    expect(screen.queryByText('Make a stack with the Ghost')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make it' })).toBeNull();
  });

  it('shows the input, "Make it" and both example buttons', async () => {
    setup();
    await ready();
    expect(screen.getByRole('heading', { name: 'Make a stack with the Ghost' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make me a to-do list' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a button' })).toBeTruthy();
    const make = screen.getByRole('button', { name: 'Make it' });
    expect(make).toHaveProperty('disabled', true);
    fireEvent.change(input(), { target: { value: 'a notes stack' } });
    expect(make).toHaveProperty('disabled', false);
  });

  it('creates, stores and opens a to-do stack from the recorded example, and its card works', async () => {
    const { repository, onOpenStack, onClose } = setup();
    await ready();
    submit('Make me a to-do list');

    await waitFor(() => expect(onOpenStack).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    const opened = onOpenStack.mock.calls[0]?.[0] as Stack;
    expect(validateStack(opened).valid).toBe(true);
    expect(opened.name).toBe('To-do');
    const objects = opened.cards.flatMap((card) => card.objects);
    expect(objects.map((object) => object.type).sort()).toEqual(['button', 'field', 'list']);

    const listed = await repository.list(1);
    if (!listed.ok) throw new Error('list failed');
    const stored = listed.value.stacks.find((summary) => summary.id === opened.id);
    expect(stored?.origin).toBe('user');

    const store = createStackStore(opened);
    store.getState().typeInField('todo-new', 'Buy milk');
    store.getState().activateButton('todo-add');
    const list = store
      .getState()
      .stack.cards.flatMap((card) => card.objects)
      .find((object) => object.id === 'todo-items');
    expect(list?.type === 'list' ? list.items : undefined).toEqual(['Buy milk']);
  });

  it('runs an example button at once', async () => {
    const { onOpenStack } = setup();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Make me a to-do list' }));
    await waitFor(() => expect(onOpenStack).toHaveBeenCalledTimes(1));
  });

  it('flushes pending edits before the Turn', async () => {
    const beforeAction = vi.fn(() => Promise.resolve());
    const { onOpenStack } = setup({ beforeAction });
    await ready();
    beforeAction.mockClear();
    submit('Make me a to-do list');
    await waitFor(() => expect(onOpenStack).toHaveBeenCalledTimes(1));
    expect(beforeAction).toHaveBeenCalled();
  });

  it('stores nothing and shows the message when the Turn fails', async () => {
    const { repository, onOpenStack, onClose } = setup({
      provider: scripted(() => providerFailure('SERVER')),
    });
    await ready();
    submit('Make a notes stack');

    const status = await screen.findByText(/I could not do that\./);
    expect(status).toBeTruthy();
    expect(onOpenStack).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const listed = await repository.list(1);
    if (!listed.ok) throw new Error('list failed');
    expect(listed.value.stacks.map((summary) => summary.id)).toEqual(['demo']);
    expect(input().disabled).toBe(false);
  });

  it('shows a busy state with a Stop button, keeps the window usable, and Stop ends the Turn', async () => {
    const never = scripted(
      () =>
        new Promise(() => {
          // Never answers. Stop aborts it.
        }),
    );
    const { onOpenStack, aiStore } = setup({ provider: never });
    await ready();
    submit('Make a notes stack');

    const stop = await screen.findByRole('button', { name: 'Stop' });
    expect(aiStore.getState().busyNewStack).toBe(true);
    expect(screen.getByText('The Ghost is making your stack.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make it' })).toHaveProperty('disabled', true);
    expect(input().disabled).toBe(true);
    // The rest of the window works while the Turn runs.
    expect(screen.getByRole('button', { name: 'Import a stack' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByRole('button', { name: 'Export Demo stack' })).toHaveProperty(
      'disabled',
      false,
    );

    fireEvent.click(stop);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    expect(screen.getByText(/Stopped/)).toBeTruthy();
    expect(onOpenStack).not.toHaveBeenCalled();
    expect(input().disabled).toBe(false);
  });

  it('names the stack with the name the model gave', async () => {
    const { onOpenStack } = setup({
      provider: scripted([
        reply({ calls: [toolCall('create_stack', { name: 'Recipes' })] }),
        reply({ content: 'Made it.' }),
      ]),
    });
    await ready();
    submit('Make a recipe stack');
    await waitFor(() => expect(onOpenStack).toHaveBeenCalledTimes(1));
    expect((onOpenStack.mock.calls[0]?.[0] as Stack).name).toBe('Recipes');
  });
});
