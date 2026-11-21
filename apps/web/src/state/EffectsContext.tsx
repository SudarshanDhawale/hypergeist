import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { EffectsStore, EffectsStoreApi } from './effects-store.ts';

/** What components may ask the effects runtime to do. Satisfied by the runtime object. */
export type EffectsActions = {
  cancelReminder(id: string): void;
  dismissReminder(id: string): void;
};

type EffectsContextValue = {
  readonly store: EffectsStoreApi;
  readonly runtime: EffectsActions | null;
};

const EffectsContext = createContext<EffectsContextValue | null>(null);

/** Provides the effects store and, optionally, the runtime handle. Without it, `useEffects` returns `null`. */
export function EffectsProvider({
  store,
  runtime = null,
  children,
}: {
  readonly store: EffectsStoreApi;
  readonly runtime?: EffectsActions | null;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => ({ store, runtime }), [store, runtime]);
  return <EffectsContext.Provider value={value}>{children}</EffectsContext.Provider>;
}

/** The store and runtime handle, or `null` when no provider is present (bare component tests). */
export function useEffects(): EffectsContextValue | null {
  return useContext(EffectsContext);
}

/** Reads from the effects store. Call it only in a component that is rendered inside `EffectsProvider`. */
export function useEffectsStore<T>(selector: (state: EffectsStore) => T): T {
  const effects = useContext(EffectsContext);
  if (effects === null) {
    throw new Error('useEffectsStore must be used inside EffectsProvider.');
  }
  return useStore(effects.store, selector);
}
