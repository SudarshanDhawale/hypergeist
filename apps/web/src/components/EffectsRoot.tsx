import { useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { Scenario } from '../ai/index.ts';
import type { ReminderRepository } from '../reminders/types.ts';
import type { KeyHolder } from '../state/ai-controller.ts';
import type { AiStoreApi } from '../state/ai-store.ts';
import { useAi } from '../state/AiContext.tsx';
import { createEffectsRuntime } from '../state/effects-runtime.ts';
import type {
  EffectsListenerType,
  EffectsRuntime,
  NotificationPort,
} from '../state/effects-runtime.ts';
import { createEffectsStore } from '../state/effects-store.ts';
import type { EffectsStoreApi } from '../state/effects-store.ts';
import { EffectsProvider } from '../state/EffectsContext.tsx';
import { useStackStoreApi } from '../state/StackStoreContext.tsx';

/** What `AppRoot` creates once and hands to the effects runtime. */
export type EffectsParts = {
  readonly aiStore: AiStoreApi;
  readonly keyHolder: KeyHolder;
  readonly scenarios: readonly Scenario[];
  readonly fetch: typeof fetch;
  readonly reminderRepo: ReminderRepository;
};

/** The last reminder id counter handed out in this page session. */
let lastCounter = 0;

/**
 * A reminder id counter that is based on the clock, so it does not repeat across sessions, and
 * that always increases within a session, even inside one millisecond.
 */
function nextCounter(): number {
  lastCounter = Math.max(lastCounter + 1, Date.now());
  return lastCounter;
}

/**
 * The browser's notifications, or `undefined` when it has none. The port looks `Notification` up
 * again at each call, so a test or a permission change is always seen.
 */
function browserNotification(): NotificationPort | undefined {
  if (typeof globalThis.Notification === 'undefined') return undefined;
  return {
    permission: () => globalThis.Notification.permission,
    requestPermission: () => globalThis.Notification.requestPermission(),
    show: (title, body) => {
      new globalThis.Notification(title, { body });
    },
  };
}

/** Adds a `visibilitychange` (document) or `focus` (window) listener and returns its remover. */
function addBrowserListener(type: EffectsListenerType, listener: () => void): () => void {
  const target: Document | Window = type === 'visibilitychange' ? document : window;
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
}

/**
 * Creates the effects store and the effects runtime once, over the stack store of this app, and
 * provides them. It attaches the runtime to the stack store, so a button press reaches it, and
 * starts it. It must live inside `StackStoreProvider` and, to refresh the demo counter, inside
 * `AiProvider`. Without the AI context the runtime still runs; it only skips the counter.
 *
 * StrictMode runs an effect, its cleanup and the effect again. The cleanup detaches the runtime at
 * once but stops it one microtask later, and only if the effect did not run again by then. So the
 * runtime is started once under StrictMode, and a real unmount still stops it.
 */
export function EffectsRoot({
  parts,
  clock,
  children,
}: {
  readonly parts: EffectsParts;
  readonly clock: () => number;
  readonly children: ReactNode;
}): JSX.Element {
  const stackStore = useStackStoreApi();
  const ai = useAi();
  // Always the newest controller, so the runtime is created once and never sees a stale one.
  const aiRef = useRef(ai);
  aiRef.current = ai;

  const [effectsStore] = useState<EffectsStoreApi>(createEffectsStore);
  const [runtime] = useState<EffectsRuntime>(() => {
    const notification = browserNotification();
    return createEffectsRuntime({
      stackStore,
      effectsStore,
      aiStore: parts.aiStore,
      keyHolder: parts.keyHolder,
      scenarios: parts.scenarios,
      fetch: parts.fetch,
      reminderRepo: parts.reminderRepo,
      now: clock,
      setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
      // The handle is whatever `setTimeout` above returned.
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...(notification === undefined ? {} : { notification }),
      refreshQuota: () => aiRef.current?.controller.refreshQuota() ?? Promise.resolve(),
      addListener: addBrowserListener,
      makeId: nextCounter,
    });
  });

  const lifecycle = useRef({ running: false, token: 0 });
  useEffect(() => {
    const state = lifecycle.current;
    state.token += 1;
    const mine = state.token;
    const detach = stackStore.getState().attachEffects(runtime.handle);
    if (!state.running) {
      state.running = true;
      void runtime.init();
    }
    return () => {
      detach();
      void Promise.resolve().then(() => {
        // The effect ran again (StrictMode): the runtime stays up.
        if (state.token !== mine) return;
        state.running = false;
        runtime.dispose();
      });
    };
  }, [runtime, stackStore]);

  return (
    <EffectsProvider store={effectsStore} runtime={runtime}>
      {children}
    </EffectsProvider>
  );
}
