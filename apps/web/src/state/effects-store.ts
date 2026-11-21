import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';

import type { Reminder } from '../reminders/types.ts';

export type { Reminder };

/** An in-app "reminder due" notice. */
export type EffectsNotice = { readonly id: string; readonly text: string };

export type EffectsState = {
  /** Ai-field objects being filled. Key: `stackId + '/' + objectId`. A new set on every change. */
  readonly running: ReadonlySet<string>;
  readonly reminders: readonly Reminder[];
  readonly notices: readonly EffectsNotice[];
};

export type EffectsActions = {
  /** Marks a key as running or not. No change, no new state. */
  setRunning(key: string, on: boolean): void;
  /** Replaces the whole reminder list. */
  setReminders(list: readonly Reminder[]): void;
  /** Appends a notice. A notice whose id is already shown is ignored. */
  addNotice(notice: EffectsNotice): void;
  dismissNotice(id: string): void;
};

export type EffectsStore = EffectsState & EffectsActions;
export type EffectsStoreApi = StoreApi<EffectsStore>;

/** Creates the store behind the ai-field "Thinking..." text, the Reminders window and the notices. */
export function createEffectsStore(): EffectsStoreApi {
  return createStore<EffectsStore>()((set) => ({
    running: new Set<string>(),
    reminders: [],
    notices: [],

    setRunning(key, on) {
      set((state) => {
        if (state.running.has(key) === on) return state;
        const running = new Set(state.running);
        if (on) running.add(key);
        else running.delete(key);
        return { running };
      });
    },

    setReminders(list) {
      set({ reminders: [...list] });
    },

    addNotice(notice) {
      set((state) => {
        if (state.notices.some((existing) => existing.id === notice.id)) return state;
        return { notices: [...state.notices, { id: notice.id, text: notice.text }] };
      });
    },

    dismissNotice(id) {
      set((state) => {
        if (!state.notices.some((notice) => notice.id === id)) return state;
        return { notices: state.notices.filter((notice) => notice.id !== id) };
      });
    },
  }));
}
