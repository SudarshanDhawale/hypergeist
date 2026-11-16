import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';

export type SaveStatus = 'saved' | 'saving' | 'not-saved';

export type SaveState = {
  readonly status: SaveStatus;
  /** Plain-words reason while `status` is `not-saved`. `null` otherwise. */
  readonly reason: string | null;
  /** `true` when the browser's storage is full and the UI should offer Export. */
  readonly canExport: boolean;
};

export type SaveStateActions = {
  /** A change is waiting or a write is running. Leaves `reason` and `canExport` as they are. */
  markSaving(): void;
  /** A write succeeded with nothing pending. Clears `reason` and `canExport`. */
  markSaved(): void;
  /** A write failed. The stack stays in memory and the next change retries. */
  markNotSaved(reason: string, canExport: boolean): void;
};

export type SaveStateStore = SaveState & SaveStateActions;
export type SaveStateStoreApi = StoreApi<SaveStateStore>;

/** Creates the store behind the Saved / Saving / Not saved indicator. It holds no timers. */
export function createSaveStateStore(): SaveStateStoreApi {
  return createStore<SaveStateStore>()((set) => ({
    status: 'saved',
    reason: null,
    canExport: false,

    markSaving() {
      set({ status: 'saving' });
    },

    markSaved() {
      set({ status: 'saved', reason: null, canExport: false });
    },

    markNotSaved(reason, canExport) {
      set({ status: 'not-saved', reason, canExport });
    },
  }));
}
