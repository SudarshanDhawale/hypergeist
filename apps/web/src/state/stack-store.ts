import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import { executeHandler } from '@hypergeist/shared/engine';
import type { EffectRequest, ExecutionResult } from '@hypergeist/shared/engine';
import type { Card, Stack } from '@hypergeist/shared/format';

export type Mode = 'interact' | 'edit' | 'ai-edit';

/** A message shown in the Hint_Line. `seq` is unique per message, so a stale timer can be told apart. */
export type StatusMessage = { readonly text: string; readonly seq: number };

export type StackState = {
  readonly stack: Stack;
  readonly currentCardId: string;
  readonly mode: Mode;
  readonly selectedObjectId: string | null;
  /** `null` shows the hint of the current Mode. */
  readonly status: StatusMessage | null;
  /** Counter behind `status.seq`. It only grows, so a seq is never reused after a clear. */
  readonly statusSeq: number;
};

export type StackActions = {
  /** Sets the Mode and clears Selection and status. */
  setMode(mode: Mode): void;
  /** Alt+M. Cycles Interact, Edit, AI edit, Interact. */
  toggleMode(): void;
  /** Edit and AI edit modes. No-op for an id that is not an Object on the current Card. */
  selectObject(id: string): void;
  /** Escape in Edit and AI edit modes. */
  clearSelection(): void;
  /** Interact mode only. Runs the `onClick` Handler of the Button. */
  activateButton(id: string): void;
  /** Interact mode only, Fields that are not read-only. One `set_value` through the executor. */
  typeInField(id: string, text: string): void;
  /** Interact mode only. Goes to the target Card of the Link. */
  followLink(id: string): void;
  /** Clears the status only when `seq` is still the current one. */
  expireStatus(seq: number): void;
  /**
   * Swaps in another Stack (opened, imported or reloaded from storage) and starts it fresh:
   * start Card, Interact mode, no Selection, no status. `statusSeq` keeps growing, so a timer of
   * an earlier message cannot clear a later one.
   */
  replaceStack(stack: Stack): void;
  /**
   * Swaps in a changed version of the open Stack (an AI Turn or Undo). Keeps the Mode and the
   * current Card (the start Card when that Card is gone) and keeps the Selection only while that
   * Object is still on the current Card. Clears the status; `statusSeq` is not touched.
   */
  applyStack(stack: Stack): void;
};

export type StackStore = StackState & StackActions;
export type StackStoreApi = StoreApi<StackStore>;

const NEXT_MODE: Readonly<Record<Mode, Mode>> = {
  interact: 'edit',
  edit: 'ai-edit',
  'ai-edit': 'interact',
};

function currentCard(state: StackState): Card | undefined {
  return state.stack.cards.find((card) => card.id === state.currentCardId);
}

/** Fixed label per Effect_Request kind. The effects runtime is a later release. */
const EFFECT_LABELS: Readonly<Record<EffectRequest['kind'], string>> = {
  run_ai_field: 'AI fields',
  fetch_news: 'News',
  transcribe_audio: 'Voice transcription',
  schedule_notification: 'Reminders',
};

/** One status message for an Effect_Request this release cannot carry out. */
function effectMessage(effect: EffectRequest): string {
  return `Skipped action ${effect.actionIndex + 1} (${effect.kind}): ${EFFECT_LABELS[effect.kind]} arrives in a later release.`;
}

/**
 * Applies an Execution_Result to the state: stores the returned Stack, handles
 * `navigateTo`, then the messages (the executor's own, then one per effect, in effect
 * order). No messages leave the status unchanged.
 */
function applyResult(state: StackState, result: ExecutionResult): StackState {
  let next: StackState = { ...state, stack: result.stack };
  if (result.navigateTo !== undefined) {
    next = { ...next, currentCardId: result.navigateTo, selectedObjectId: null, status: null };
  }
  const messages = [...result.messages, ...result.effects.map(effectMessage)];
  if (messages.length === 0) {
    return next;
  }
  const seq = next.statusSeq + 1;
  return { ...next, status: { text: messages.join(' '), seq }, statusSeq: seq };
}

/** Creates the one store of the running Stack. It holds no timers; the 4 second expiry lives in the UI. */
export function createStackStore(stack: Stack): StackStoreApi {
  return createStore<StackStore>()((set, get) => ({
    stack,
    currentCardId: stack.startCardId,
    mode: 'interact',
    selectedObjectId: null,
    status: null,
    statusSeq: 0,

    setMode(mode) {
      set({ mode, selectedObjectId: null, status: null });
    },

    toggleMode() {
      get().setMode(NEXT_MODE[get().mode]);
    },

    selectObject(id) {
      const state = get();
      if (state.mode === 'interact') return;
      const card = currentCard(state);
      if (card === undefined || !card.objects.some((object) => object.id === id)) return;
      set({ selectedObjectId: id });
    },

    clearSelection() {
      if (get().mode === 'interact') return;
      set({ selectedObjectId: null });
    },

    activateButton(id) {
      const state = get();
      if (state.mode !== 'interact') return;
      const object = currentCard(state)?.objects.find((candidate) => candidate.id === id);
      if (object === undefined || object.type !== 'button') return;
      set(applyResult(state, executeHandler(state.stack, object.onClick)));
    },

    typeInField(id, text) {
      const state = get();
      if (state.mode !== 'interact') return;
      const object = currentCard(state)?.objects.find((candidate) => candidate.id === id);
      if (object === undefined || object.type !== 'field' || object.readOnly) return;
      const result = executeHandler(state.stack, [
        { type: 'set_value', targetObjectId: id, value: text },
      ]);
      set(applyResult(state, result));
    },

    followLink(id) {
      const state = get();
      if (state.mode !== 'interact') return;
      const link = currentCard(state)?.links.find((candidate) => candidate.id === id);
      if (link === undefined) return;
      if (!state.stack.cards.some((card) => card.id === link.targetCardId)) return;
      set({ currentCardId: link.targetCardId, selectedObjectId: null, status: null });
    },

    expireStatus(seq) {
      if (get().status?.seq !== seq) return;
      set({ status: null });
    },

    replaceStack(stack) {
      set({
        stack,
        currentCardId: stack.startCardId,
        mode: 'interact',
        selectedObjectId: null,
        status: null,
      });
    },

    applyStack(stack) {
      const state = get();
      const keepCard = stack.cards.some((card) => card.id === state.currentCardId);
      const currentCardId = keepCard ? state.currentCardId : stack.startCardId;
      const card = stack.cards.find((candidate) => candidate.id === currentCardId);
      const keepSelection =
        state.selectedObjectId !== null &&
        card !== undefined &&
        card.objects.some((object) => object.id === state.selectedObjectId);
      set({
        stack,
        currentCardId,
        selectedObjectId: keepSelection ? state.selectedObjectId : null,
        status: null,
      });
    },
  }));
}
