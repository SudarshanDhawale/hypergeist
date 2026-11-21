import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { AiController } from './ai-controller.ts';
import type { AiStore, AiStoreApi } from './ai-store.ts';

type AiContextValue = {
  readonly controller: AiController;
  readonly store: AiStoreApi;
};

const AiContext = createContext<AiContextValue | null>(null);

/** Provides the AI controller and its store. Without it, `useAi` returns `null`. */
export function AiProvider({
  controller,
  store,
  children,
}: {
  readonly controller: AiController;
  readonly store: AiStoreApi;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => ({ controller, store }), [controller, store]);
  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}

/** The controller and store, or `null` when no provider is present (bare component tests). */
export function useAi(): AiContextValue | null {
  return useContext(AiContext);
}

/** Reads from the AI store. Call it only in a component that is rendered inside `AiProvider`. */
export function useAiStore<T>(selector: (state: AiStore) => T): T {
  const ai = useContext(AiContext);
  if (ai === null) {
    throw new Error('useAiStore must be used inside AiProvider.');
  }
  return useStore(ai.store, selector);
}
