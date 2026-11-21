import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import { DEFAULT_AI_SETTINGS } from '../ai/index.ts';
import type { AiSettings, CapabilityReport } from '../ai/index.ts';

export type ChatLineKind = 'user' | 'ghost' | 'step' | 'note' | 'error';

export type ChatLine = {
  readonly id: number;
  readonly kind: ChatLineKind;
  readonly text: string;
};

/** A line before it gets an id. */
export type NewChatLine = { readonly kind: ChatLineKind; readonly text: string };

export type AiQuota = { readonly remaining: number };

export type AiState = {
  readonly lines: readonly ChatLine[];
  /** A chat Turn is running. */
  readonly busy: boolean;
  /** A new-stack Turn (Stacks window) is running. Separate from `busy`. */
  readonly busyNewStack: boolean;
  /** Grows each time a Turn starts, so the UI can restart a thinking effect. */
  readonly thinkingSeq: number;
  readonly settings: AiSettings;
  /** Whether the memory-only key holder holds a key. Never the key. */
  readonly hasKey: boolean;
  readonly capability: CapabilityReport | null;
  readonly jsonMode: boolean;
  /** `null` hides the demo counter. */
  readonly quota: AiQuota | null;
  /** The id the next line gets. */
  readonly nextLineId: number;
};

export type AiActions = {
  addLines(lines: readonly NewChatLine[]): void;
  setBusy(busy: boolean): void;
  setBusyNewStack(busy: boolean): void;
  setSettings(settings: AiSettings): void;
  setHasKey(hasKey: boolean): void;
  setCapability(report: CapabilityReport | null): void;
  setJsonMode(jsonMode: boolean): void;
  setQuota(quota: AiQuota | null): void;
};

export type AiStore = AiState & AiActions;
export type AiStoreApi = StoreApi<AiStore>;

/** Creates the store behind the Ghost chat, the settings dialog and the demo counter. */
export function createAiStore(): AiStoreApi {
  return createStore<AiStore>()((set) => ({
    lines: [],
    busy: false,
    busyNewStack: false,
    thinkingSeq: 0,
    settings: { ...DEFAULT_AI_SETTINGS },
    hasKey: false,
    capability: null,
    jsonMode: false,
    quota: null,
    nextLineId: 1,

    addLines(lines) {
      if (lines.length === 0) return;
      set((state) => ({
        lines: [
          ...state.lines,
          ...lines.map((line, index) => ({
            id: state.nextLineId + index,
            kind: line.kind,
            text: line.text,
          })),
        ],
        nextLineId: state.nextLineId + lines.length,
      }));
    },

    setBusy(busy) {
      set((state) => ({
        busy,
        thinkingSeq: busy ? state.thinkingSeq + 1 : state.thinkingSeq,
      }));
    },

    setBusyNewStack(busy) {
      set((state) => ({
        busyNewStack: busy,
        thinkingSeq: busy ? state.thinkingSeq + 1 : state.thinkingSeq,
      }));
    },

    setSettings(settings) {
      set({ settings });
    },

    setHasKey(hasKey) {
      set({ hasKey });
    },

    setCapability(report) {
      set({ capability: report });
    },

    setJsonMode(jsonMode) {
      set({ jsonMode });
    },

    setQuota(quota) {
      set({ quota });
    },
  }));
}
