import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { createSaveStateStore } from './save-state-store.ts';
import type { SaveState, SaveStateStoreApi } from './save-state-store.ts';

/** What the UI needs besides the live save state: the storage mode and the export action. */
export type PersistenceInfo = {
  readonly memoryMode: boolean;
  readonly onExport: () => void;
};

type SaveStateContextValue = {
  readonly store: SaveStateStoreApi;
  readonly info: PersistenceInfo;
};

const SaveStateContext = createContext<SaveStateContextValue | null>(null);

/**
 * Provides the save state store and the persistence info to the stack window.
 * Without this provider the hooks return `null` and the save UI renders nothing.
 */
export function SaveStateProvider({
  store,
  memoryMode,
  onExport,
  children,
}: {
  readonly store: SaveStateStoreApi;
  readonly memoryMode: boolean;
  readonly onExport: () => void;
  readonly children: ReactNode;
}) {
  const value = useMemo(
    () => ({ store, info: { memoryMode, onExport } }),
    [store, memoryMode, onExport],
  );
  return <SaveStateContext.Provider value={value}>{children}</SaveStateContext.Provider>;
}

/** Stands in for the store when there is no provider, so the hooks can always run `useStore`. */
const FALLBACK_STORE = createSaveStateStore();

/** The current save state, or `null` when there is no `SaveStateProvider`. */
export function useSaveState(): SaveState | null {
  const context = useContext(SaveStateContext);
  const store = context === null ? FALLBACK_STORE : context.store;
  const status = useStore(store, (state) => state.status);
  const reason = useStore(store, (state) => state.reason);
  const canExport = useStore(store, (state) => state.canExport);
  return useMemo(
    () => (context === null ? null : { status, reason, canExport }),
    [context, status, reason, canExport],
  );
}

/** `{ memoryMode, onExport }`, or `null` when there is no `SaveStateProvider`. */
export function usePersistenceInfo(): PersistenceInfo | null {
  return useContext(SaveStateContext)?.info ?? null;
}
