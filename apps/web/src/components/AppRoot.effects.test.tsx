import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { createKeyHolder, createSettingsRepository, loadScenarios } from '../ai/index.ts';
import { bootPersistence } from '../persistence/boot.ts';
import type { BootOptions } from '../persistence/boot.ts';
import { createMemoryRepository } from '../persistence/memory-repository.ts';
import type { SeedSet } from '../persistence/seed-set.ts';
import { createMemoryReminderRepository } from '../reminders/memory-reminder-repository.ts';
import { createAiStore } from '../state/ai-store.ts';
import type { EffectsRuntimeDeps } from '../state/effects-runtime.ts';
import type { EffectsStoreApi } from '../state/effects-store.ts';
import { StackStoreProvider, useStackStoreApi } from '../state/StackStoreContext.tsx';
import type { StackStoreApi } from '../state/stack-store.ts';
import { AppRoot } from './AppRoot.tsx';
import { EffectsRoot } from './EffectsRoot.tsx';
import type { EffectsParts } from './EffectsRoot.tsx';

/**
 * The real runtime and the real effects store, wrapped so a test can count how often each is
 * created, started, stopped and given effects.
 */
const spy = vi.hoisted(() => ({
  created: 0,
  inits: 0,
  disposes: 0,
  handled: 0,
  stores: [] as unknown[],
}));

vi.mock('../state/effects-runtime.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/effects-runtime.ts')>();
  return {
    ...actual,
    createEffectsRuntime: (deps: EffectsRuntimeDeps) => {
      spy.created += 1;
      const runtime = actual.createEffectsRuntime(deps);
      return {
        ...runtime,
        handle: (...args: Parameters<typeof runtime.handle>) => {
          spy.handled += 1;
          runtime.handle(...args);
        },
        init: () => {
          spy.inits += 1;
          return runtime.init();
        },
        dispose: () => {
          spy.disposes += 1;
          runtime.dispose();
        },
      };
    },
  };
});

vi.mock('../state/effects-store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/effects-store.ts')>();
  return {
    ...actual,
    createEffectsStore: () => {
      const store = actual.createEffectsStore();
      spy.stores.push(store);
      return store;
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  spy.created = 0;
  spy.inits = 0;
  spy.disposes = 0;
  spy.handled = 0;
  spy.stores.length = 0;
});

const NOW = Date.UTC(2026, 10, 20, 9, 0);
const RECORDED_SUMMARY = 'This is a recorded demo summary of your notes.';

/** One card: a field with notes, an AI field, a button that fills it and a button that sets a reminder. */
const STACK: Stack = (() => {
  const parsed = parseStack(
    JSON.stringify({
      formatVersion: 1,
      id: 'effects-demo',
      name: 'Effects demo',
      cardWidth: 512,
      cardHeight: 342,
      startCardId: 'main',
      cards: [
        {
          id: 'main',
          name: 'Main',
          objects: [
            {
              id: 'notes',
              type: 'field',
              name: 'Notes',
              x: 16,
              y: 16,
              width: 300,
              height: 28,
              value: 'Buy milk and call Sam.',
              placeholder: '',
              multiline: false,
              readOnly: false,
            },
            {
              id: 'summary',
              type: 'ai-field',
              name: 'Summary',
              x: 16,
              y: 56,
              width: 300,
              height: 60,
              prompt: 'Summarize my notes in one sentence',
              inputObjectIds: ['notes'],
              value: '',
            },
            {
              id: 'run',
              type: 'button',
              name: 'Summarize',
              x: 16,
              y: 130,
              width: 120,
              height: 28,
              label: 'Summarize',
              onClick: [{ type: 'run_ai_field', targetObjectId: 'summary' }],
            },
            {
              id: 'remind',
              type: 'button',
              name: 'Remind me',
              x: 150,
              y: 130,
              width: 120,
              height: 28,
              label: 'Remind me',
              onClick: [
                {
                  type: 'schedule_notification',
                  message: 'Stretch your legs',
                  at: '2026-11-21T09:00:00Z',
                },
              ],
            },
          ],
          links: [],
          onOpen: [],
        },
      ],
    }),
  );
  if (!parsed.ok) throw new Error('The test stack is not valid.');
  return parsed.value;
})();

const seedSet: SeedSet = { stacks: [{ stack: STACK }], problems: [] };

function boot(options: BootOptions) {
  return bootPersistence({
    ...options,
    openRepository: () =>
      Promise.resolve({ repository: createMemoryRepository(), mode: 'indexeddb' as const }),
  });
}

function lastEffectsStore(): EffectsStoreApi {
  const store = spy.stores.at(-1);
  if (store === undefined) throw new Error('No effects store was created.');
  return store as EffectsStoreApi;
}

/** Lets the microtask that stops an unmounted runtime run. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('EffectsRoot: lifecycle', () => {
  function makeParts(): EffectsParts {
    return {
      aiStore: createAiStore(),
      keyHolder: createKeyHolder(),
      scenarios: [],
      fetch: () => Promise.reject(new Error('offline')),
      reminderRepo: createMemoryReminderRepository(),
    };
  }

  /** Renders `EffectsRoot` without an AI context and hands back the stack store of the tree. */
  function renderRoot(strict: boolean) {
    const parts = makeParts();
    const stores: StackStoreApi[] = [];
    function Probe(): null {
      stores.push(useStackStoreApi());
      return null;
    }
    const tree = (
      <StackStoreProvider stack={STACK}>
        <EffectsRoot parts={parts} clock={() => NOW}>
          <Probe />
        </EffectsRoot>
      </StackStoreProvider>
    );
    const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    const store = stores.at(-1);
    if (store === undefined) throw new Error('The probe did not render.');
    return { view, store };
  }

  it('creates the runtime once, attaches it on mount and detaches it on unmount', async () => {
    const { view, store } = renderRoot(false);
    expect(spy.created).toBe(1);
    expect(spy.inits).toBe(1);

    store.getState().activateButton('run');
    expect(spy.handled).toBe(1);

    view.unmount();
    store.getState().activateButton('run');
    expect(spy.handled).toBe(1);

    await flushMicrotasks();
    expect(spy.disposes).toBe(1);
    expect(spy.created).toBe(1);
    expect(spy.inits).toBe(1);
  });

  it('calls init once under StrictMode, keeps the runtime attached, and stops it on unmount', async () => {
    const { view, store } = renderRoot(true);
    await flushMicrotasks();
    expect(spy.inits).toBe(1);
    expect(spy.disposes).toBe(0);

    store.getState().activateButton('run');
    expect(spy.handled).toBe(1);

    view.unmount();
    store.getState().activateButton('run');
    expect(spy.handled).toBe(1);
    await flushMicrotasks();
    expect(spy.disposes).toBe(1);
    expect(spy.inits).toBe(1);
  });

  it('starts a new runtime after mount, unmount, mount', async () => {
    const first = renderRoot(false);
    first.view.unmount();
    await flushMicrotasks();
    expect(spy.disposes).toBe(1);

    const second = renderRoot(false);
    expect(spy.created).toBe(2);
    expect(spy.inits).toBe(2);
    second.store.getState().activateButton('run');
    expect(spy.handled).toBe(1);
  });

  it('works without an AI context: the field run ends and reports the demo-only message', async () => {
    const { store } = renderRoot(false);
    store.getState().activateButton('run');
    expect(lastEffectsStore().getState().running.has('effects-demo/summary')).toBe(true);
    await waitFor(() => {
      expect(lastEffectsStore().getState().running.size).toBe(0);
    });
    expect(store.getState().status?.text).toBe(
      'In demo mode this field only answers its recorded example.',
    );
  });
});

describe('AppRoot: effects wiring', () => {
  function renderApp(
    options: { reminderRepository?: ReturnType<typeof createMemoryReminderRepository> } = {},
  ) {
    const calls: string[] = [];
    const fetchStub = (input: RequestInfo | URL): Promise<Response> => {
      calls.push(typeof input === 'string' ? input : 'other');
      return Promise.reject(new Error('offline'));
    };
    render(
      <AppRoot
        boot={boot}
        now={() => NOW}
        seedSet={seedSet}
        fetch={fetchStub as typeof fetch}
        scenarios={loadScenarios().scenarios}
        settingsRepository={createSettingsRepository(null)}
        {...(options.reminderRepository === undefined
          ? {}
          : { reminderRepository: options.reminderRepository })}
      />,
    );
    return { calls };
  }

  it('creates the runtime once and starts it once', async () => {
    renderApp({ reminderRepository: createMemoryReminderRepository() });
    await screen.findByRole('button', { name: 'Summarize' });
    expect(spy.created).toBe(1);
    expect(spy.inits).toBe(1);
    expect(spy.stores).toHaveLength(1);
  });

  it('fills the AI field from the recorded example when a button runs it, and refreshes the quota', async () => {
    const { calls } = renderApp({ reminderRepository: createMemoryReminderRepository() });
    const button = await screen.findByRole('button', { name: 'Summarize' });
    await waitFor(() => {
      expect(calls.filter((call) => call === '/api/ai/quota')).toHaveLength(1);
    });

    button.click();
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveProperty(
        'value',
        RECORDED_SUMMARY,
      );
    });
    await waitFor(() => {
      expect(lastEffectsStore().getState().running.size).toBe(0);
      expect(calls.filter((call) => call === '/api/ai/quota').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('stores a reminder in the effects store and the injected repository, and asks for permission once', async () => {
    const requestPermission = vi.fn(() => Promise.resolve('granted'));
    class FakeNotification {
      static permission = 'default';
      static requestPermission = requestPermission;
    }
    vi.stubGlobal('Notification', FakeNotification);

    const reminderRepository = createMemoryReminderRepository();
    renderApp({ reminderRepository });
    const button = await screen.findByRole('button', { name: 'Remind me' });
    button.click();

    await waitFor(() => {
      expect(lastEffectsStore().getState().reminders).toHaveLength(1);
    });
    const [reminder] = lastEffectsStore().getState().reminders;
    expect(reminder).toMatchObject({
      stackId: 'effects-demo',
      message: 'Stretch your legs',
      dueAt: Date.UTC(2026, 10, 21, 9, 0),
      createdAt: NOW,
      state: 'pending',
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);

    const stored = await reminderRepository.list();
    expect(stored.ok && stored.value.map((item) => item.id)).toEqual([reminder?.id]);
  });

  it('opens its own reminder repository when none is injected', async () => {
    renderApp();
    const button = await screen.findByRole('button', { name: 'Remind me' });
    button.click();
    await waitFor(() => {
      expect(lastEffectsStore().getState().reminders).toHaveLength(1);
    });
    expect(lastEffectsStore().getState().reminders[0]?.message).toBe('Stretch your legs');
  });
});
