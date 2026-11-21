import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, MutableRefObject, ReactNode } from 'react';
import type { Stack } from '@hypergeist/shared/format';
import { createKeyHolder, createSettingsRepository, loadScenarios } from '../ai/index.ts';
import type { Scenario } from '../ai/index.ts';
import { downloadText } from '../lib/download-text.ts';
import { createAutosave } from '../persistence/autosave.ts';
import type { Autosave } from '../persistence/autosave.ts';
import { bootPersistence, LAST_OPENED_KEY } from '../persistence/boot.ts';
import type { BootOptions, BootResult } from '../persistence/boot.ts';
import { exportStack } from '../persistence/export-stack.ts';
import { loadSeedSet } from '../persistence/seed-set.ts';
import type { SeedSet } from '../persistence/seed-set.ts';
import type { Repository } from '../persistence/types.ts';
import { openReminderRepository } from '../reminders/open-reminder-repository.ts';
import type { ReminderRepository } from '../reminders/types.ts';
import { createAiController } from '../state/ai-controller.ts';
import type { AiController, SettingsRepository } from '../state/ai-controller.ts';
import { createAiStore } from '../state/ai-store.ts';
import { AiProvider } from '../state/AiContext.tsx';
import { PersistenceProvider } from '../state/PersistenceContext.tsx';
import { createSaveStateStore } from '../state/save-state-store.ts';
import type { SaveStateStoreApi } from '../state/save-state-store.ts';
import { SaveStateProvider } from '../state/SaveStateContext.tsx';
import { StackStoreProvider, useStackStoreApi } from '../state/StackStoreContext.tsx';
import type { StackStoreApi } from '../state/stack-store.ts';
import { Desktop } from './Desktop.tsx';
import { EffectsRoot } from './EffectsRoot.tsx';
import type { EffectsParts } from './EffectsRoot.tsx';

export type AppRootProps = {
  /** Opens the repository and picks the first stack. Defaults to `bootPersistence`. */
  readonly boot?: (options: BootOptions) => Promise<BootResult>;
  /** The clock. Defaults to `Date.now`. The only place the app reads the clock for saving. */
  readonly now?: () => number;
  /** The demo stacks. Defaults to the bundled files. */
  readonly seedSet?: SeedSet;
  /** The network call of the AI. Defaults to the global `fetch`, looked up at call time. */
  readonly fetch?: typeof fetch;
  /** The recorded demo scenarios. Defaults to the bundled files. */
  readonly scenarios?: readonly Scenario[];
  /** Where the AI settings are stored. Defaults to the IndexedDB repository. */
  readonly settingsRepository?: SettingsRepository;
  /** Where reminders are stored. Defaults to the IndexedDB repository, opened on first use. */
  readonly reminderRepository?: ReminderRepository;
};

type Phase =
  | { readonly kind: 'booting' }
  | { readonly kind: 'ready'; readonly booted: BootResult }
  | { readonly kind: 'failed' };

/** The open stack and a counter. The counter changes on every open, even for the same id. */
type OpenStack = { readonly stack: Stack; readonly counter: number };

const EXPORT_DOWNLOAD_FAILED = 'The file could not be downloaded.';

/**
 * Boots persistence, shows "Opening your stacks..." until it is done, then renders the desktop
 * with the stack that was chosen. See `ReadyApp` for how saving is wired.
 */
export function AppRoot({
  boot = bootPersistence,
  now = Date.now,
  seedSet,
  fetch: fetchProp,
  scenarios,
  settingsRepository,
  reminderRepository,
}: AppRootProps): JSX.Element {
  const [seeds] = useState(() => seedSet ?? loadSeedSet());
  // Created once per mount. The key holder is memory only and never reaches the repository.
  const [ai] = useState<AiParts>(() => ({
    aiStore: createAiStore(),
    keyHolder: createKeyHolder(),
    settingsRepo: settingsRepository ?? createSettingsRepository(),
    scenarios: scenarios ?? loadScenarios().scenarios,
    fetch: fetchProp ?? ((input, init) => globalThis.fetch(input, init)),
    reminderRepo: reminderRepository ?? createLazyReminderRepository(),
  }));
  const [phase, setPhase] = useState<Phase>({ kind: 'booting' });
  // The boot runs once, even if the effect runs twice (StrictMode).
  const bootPromise = useRef<Promise<BootResult> | null>(null);
  // Always the newest clock, so a new `now` prop never changes the identity of what uses it.
  const nowRef = useRef(now);
  nowRef.current = now;
  const clock = useCallback(() => nowRef.current(), []);

  useEffect(() => {
    let cancelled = false;
    bootPromise.current ??= boot({ now: clock(), seedSet: seeds });
    bootPromise.current.then(
      (booted) => {
        if (!cancelled) setPhase({ kind: 'ready', booted });
      },
      () => {
        if (!cancelled) setPhase({ kind: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase.kind === 'booting') {
    return (
      <p className="app-loading" role="status">
        Opening your stacks...
      </p>
    );
  }
  if (phase.kind === 'failed') {
    return (
      <p className="app-loading" role="alert">
        Your stacks could not be opened. Reload the page to try again.
      </p>
    );
  }
  return <ReadyApp booted={phase.booted} seeds={seeds} clock={clock} ai={ai} />;
}

/**
 * What `AppRoot` creates once for the AI and the effects. The controller and the effects runtime
 * need the stack store, so `AiRoot` and `EffectsRoot` make them.
 */
type AiParts = EffectsParts & {
  readonly settingsRepo: SettingsRepository;
};

/**
 * A reminder repository that opens the real one (IndexedDB, or memory when that is not possible)
 * on first use, once. Creating it does no work. `openReminderRepository` never rejects.
 */
function createLazyReminderRepository(): ReminderRepository {
  let opened: Promise<ReminderRepository> | null = null;
  const open = (): Promise<ReminderRepository> => {
    opened ??= openReminderRepository().then((result) => result.repository);
    return opened;
  };
  return {
    list: async () => (await open()).list(),
    put: async (reminder) => (await open()).put(reminder),
    remove: async (id) => (await open()).remove(id),
  };
}

/**
 * Creates the AI controller once, over the stack store of this app, starts it, and provides it.
 * It must live inside `StackStoreProvider`.
 */
function AiRoot({
  ai,
  clock,
  children,
}: {
  readonly ai: AiParts;
  readonly clock: () => number;
  readonly children: ReactNode;
}): JSX.Element {
  const stackStore = useStackStoreApi();
  const [controller] = useState<AiController>(() =>
    createAiController({ ...ai, stackStore, now: clock }),
  );
  const started = useRef(false);
  useEffect(() => {
    // Once, even if the effect runs twice (StrictMode).
    if (started.current) return;
    started.current = true;
    void controller.init();
  }, [controller]);
  return (
    <AiProvider controller={controller} store={ai.aiStore}>
      {children}
    </AiProvider>
  );
}

/**
 * One save state store and one stack store per app. The open stack and a counter live in React
 * state. The stack store is created once from the first stack. Opening, importing, deleting or
 * restoring a stack replaces the stack inside that store (see `OpenStackBridge`), so nothing
 * else remounts: the Stacks window stays open and keeps its notices.
 */
function ReadyApp({
  booted,
  seeds,
  clock,
  ai,
}: {
  readonly booted: BootResult;
  readonly seeds: SeedSet;
  readonly clock: () => number;
  readonly ai: AiParts;
}): JSX.Element {
  const { repository, mode } = booted;
  const [saveStore] = useState(createSaveStateStore);
  const [open, setOpen] = useState<OpenStack>({ stack: booted.initial, counter: 0 });
  const [exportError, setExportError] = useState<string | null>(null);
  // Filled by `OpenStackBridge`, which lives inside the stack store provider.
  const stackStoreRef = useRef<StackStoreApi | null>(null);
  const autosaveRef = useRef<Autosave | null>(null);

  const onOpenStack = useCallback(
    (stack: Stack) => {
      setExportError(null);
      setOpen((previous) => ({ stack, counter: previous.counter + 1 }));
      void repository.setMeta(LAST_OPENED_KEY, stack.id).catch(() => undefined);
    },
    [repository],
  );

  const onExport = useCallback(() => {
    const current = stackStoreRef.current?.getState().stack;
    if (current === undefined) return;
    const exported = exportStack(current);
    if (!exported.ok) {
      setExportError(exported.message);
      return;
    }
    try {
      downloadText(exported.filename, exported.text);
      setExportError(null);
    } catch {
      setExportError(EXPORT_DOWNLOAD_FAILED);
    }
  }, []);

  // Writes the pending edit before the Stacks window reads or changes storage.
  const beforeAction = useCallback(() => autosaveRef.current?.flush() ?? Promise.resolve(), []);

  return (
    <SaveStateProvider store={saveStore} memoryMode={mode === 'memory'} onExport={onExport}>
      <PersistenceProvider
        repository={repository}
        seeds={seeds.stacks}
        openStackId={open.stack.id}
        now={clock}
        onOpenStack={onOpenStack}
        beforeAction={beforeAction}
      >
        <StackStoreProvider stack={booted.initial}>
          <AiRoot ai={ai} clock={clock}>
            <EffectsRoot parts={ai} clock={clock}>
              <OpenStackBridge
                open={open}
                repository={repository}
                clock={clock}
                saveStore={saveStore}
                stackStoreRef={stackStoreRef}
                autosaveRef={autosaveRef}
              />
              <Desktop />
            </EffectsRoot>
          </AiRoot>
        </StackStoreProvider>
      </PersistenceProvider>
      {exportError === null ? null : (
        <div className="app-notice stacks-note stacks-note-error" aria-live="polite">
          <p>{exportError}</p>
          <button type="button" onClick={() => setExportError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </SaveStateProvider>
  );
}

/**
 * Renders nothing. It keeps the stack store and the autosave in step with the open stack:
 * for each open (a new `open.counter`) it puts the stack into the store, creates a fresh
 * autosave for it, passes later stack changes to that autosave, flushes it when the page is
 * hidden, and lets `ReadyApp` reach the stack store and the autosave through refs. It must
 * live inside `StackStoreProvider`.
 *
 * It is a layout effect on purpose: the cleanup of the old stack and the replace both run in
 * the commit that renders the new `open`, before the browser paints, so the old stack is never
 * shown next to the new stack's name in the Stacks window.
 */
function OpenStackBridge({
  open,
  repository,
  clock,
  saveStore,
  stackStoreRef,
  autosaveRef,
}: {
  readonly open: OpenStack;
  readonly repository: Repository;
  readonly clock: () => number;
  readonly saveStore: SaveStateStoreApi;
  readonly stackStoreRef: MutableRefObject<StackStoreApi | null>;
  readonly autosaveRef: MutableRefObject<Autosave | null>;
}): null {
  const stackStore = useStackStoreApi();
  // The counter of the open that the store already holds. The store is created from the first
  // stack, so it starts as the current counter. It stops a re-run of the effect with the same
  // `open` (StrictMode) from replacing a stack that has been edited since.
  const appliedCounter = useRef(open.counter);

  useLayoutEffect(() => {
    // Load the new stack before anything listens, so the load is not seen as an edit to save.
    if (appliedCounter.current !== open.counter) {
      stackStore.getState().replaceStack(open.stack);
      appliedCounter.current = open.counter;
    }
    // A stack that was just opened is what is stored.
    saveStore.getState().markSaved();

    const autosave = createAutosave({
      write: (stack) => repository.save(stack, clock()),
      onState: (state) => {
        const actions = saveStore.getState();
        if (state.status === 'saving') actions.markSaving();
        else if (state.status === 'saved') actions.markSaved();
        else actions.markNotSaved(state.reason ?? 'The stack could not be saved.', state.canExport);
      },
    });
    stackStoreRef.current = stackStore;
    autosaveRef.current = autosave;

    // Only a new `stack` reference is a change to save. Mode, selection and card are not saved.
    const unsubscribe = stackStore.subscribe((state, previous) => {
      if (state.stack !== previous.stack) autosave.notify(state.stack);
    });

    function onVisibilityChange(): void {
      if (document.visibilityState === 'hidden') void autosave.flush();
    }
    function onPageHide(): void {
      void autosave.flush();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      unsubscribe();
      autosave.dispose();
      if (autosaveRef.current === autosave) autosaveRef.current = null;
      if (stackStoreRef.current === stackStore) stackStoreRef.current = null;
    };
  }, [
    open.counter,
    open.stack,
    stackStore,
    repository,
    clock,
    saveStore,
    stackStoreRef,
    autosaveRef,
  ]);

  return null;
}
