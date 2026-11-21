import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import { applyOperation, executeHandler } from '@hypergeist/shared/engine';
import type { EffectRequest, ExecutionResult } from '@hypergeist/shared/engine';
import type { Card, Stack } from '@hypergeist/shared/format';

export type Mode = 'interact' | 'edit' | 'ai-edit';

/** Who made an edit: the person at the keyboard or an AI Turn. */
export type EditSource = 'user' | 'ai';

/** One step of history: the whole Stack as it was before (or, in `future`, after) an edit. */
export type HistoryEntry = { readonly stack: Stack; readonly source: EditSource };

/** The most entries kept in each of `past` and `future`. */
export const MAX_HISTORY = 50;

/** Object types the Add object row can create. */
export type AddableObjectType = 'button' | 'field' | 'list' | 'image';

const NEW_OBJECT_START = 16;
const NEW_OBJECT_STEP = 8;

/** A 1 by 1 PNG, the placeholder `src` of a new image (the format requires a source). */
const PLACEHOLDER_IMAGE_SRC =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const NEW_OBJECT_SIZE: Readonly<Record<AddableObjectType, { width: number; height: number }>> = {
  button: { width: 96, height: 28 },
  field: { width: 160, height: 28 },
  list: { width: 160, height: 96 },
  image: { width: 96, height: 96 },
};

const NEW_OBJECT_EXTRAS: Readonly<Record<AddableObjectType, Readonly<Record<string, unknown>>>> = {
  button: { label: 'Button' },
  field: {},
  list: {},
  image: { src: PLACEHOLDER_IMAGE_SRC, alt: 'Image' },
};

const LAST_CARD_MESSAGE = 'The last card cannot be deleted.';

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
  /** Stacks before each edit, oldest first, at most `MAX_HISTORY`. */
  readonly past: readonly HistoryEntry[];
  /** Stacks undone and not yet redone, the next redo last, at most `MAX_HISTORY`. */
  readonly future: readonly HistoryEntry[];
};

/** Source of the newest `past` entry, or `null` when there is none. */
export function lastEntrySource(state: Pick<StackState, 'past'>): EditSource | null {
  return state.past[state.past.length - 1]?.source ?? null;
}

/**
 * Carries out the effect requests the store cannot: AI fields and reminders. Called
 * synchronously inside `activateButton`, so browser permission prompts stay inside the click.
 * `snapshot` is the Stack that ran the Handler. Return values and errors are ignored.
 */
export type EffectsHandler = (effects: readonly EffectRequest[], snapshot: Stack) => void;

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
   * Records the change in `past` with `source` and clears `future`. The same Stack is a no-op.
   */
  applyStack(stack: Stack, source?: EditSource): void;
  /** Records `next` as the new Stack (same keep rules as `applyStack`). */
  commitStack(next: Stack, options: { readonly source: EditSource }): void;
  /** One `update_object`. A rejection sets the status to its first message and changes nothing. */
  editObject(id: string, changes: Readonly<Record<string, unknown>>): void;
  /** One `add_object` with the defaults of `type` on the current Card; selects the new Object. */
  addObjectToCard(type: AddableObjectType): void;
  /** Removes the selected Object. No-op without a Selection. */
  removeSelected(): void;
  /** Adds a Card named "Card N" at the end and opens it. */
  addCard(): void;
  /** Deletes the current Card and opens a neighbor. The last Card cannot be deleted. */
  deleteCurrentCard(): void;
  /** Steps back one edit. No-op without history. */
  undoEdit(): void;
  /** Steps forward one undone edit. No-op without any. */
  redoEdit(): void;
  /** Opens a Card of the Stack and clears the Selection. No-op for an unknown id. */
  goToCard(id: string): void;
  /**
   * Attaches (or with `null` removes) the handler for `run_ai_field` and `schedule_notification`
   * effects. Only one handler is kept; the returned function detaches it, and does nothing when
   * another handler has been attached since.
   */
  attachEffects(handler: EffectsHandler | null): () => void;
  /** Shows a status message with a new `seq`, like the end of a button press. */
  setStatus(text: string): void;
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

/** `stack` with the current Card kept (the start Card when gone) and the Selection kept while valid. */
function keepView(
  state: StackState,
  stack: Stack,
): Pick<StackState, 'stack' | 'currentCardId' | 'selectedObjectId'> {
  const keepCard = stack.cards.some((card) => card.id === state.currentCardId);
  const currentCardId = keepCard ? state.currentCardId : stack.startCardId;
  const card = stack.cards.find((candidate) => candidate.id === currentCardId);
  const keepSelection =
    state.selectedObjectId !== null &&
    card !== undefined &&
    card.objects.some((object) => object.id === state.selectedObjectId);
  return { stack, currentCardId, selectedObjectId: keepSelection ? state.selectedObjectId : null };
}

function capped(entries: readonly HistoryEntry[]): readonly HistoryEntry[] {
  return entries.length > MAX_HISTORY ? entries.slice(entries.length - MAX_HISTORY) : entries;
}

/** Position of a new object: 16, 16 shifted by 8 per existing object, kept inside the Card. */
function newObjectPosition(
  stack: Stack,
  count: number,
  size: { width: number; height: number },
): { x: number; y: number } {
  const offset = NEW_OBJECT_START + NEW_OBJECT_STEP * count;
  return {
    x: Math.max(0, Math.min(offset, stack.cardWidth - size.width)),
    y: Math.max(0, Math.min(offset, stack.cardHeight - size.height)),
  };
}

/**
 * Fixed label per Effect_Request kind, for the "arrives in a later release" message. With an
 * effects handler attached only `fetch_news` and `transcribe_audio` get that message; with none
 * attached all four do.
 */
const EFFECT_LABELS: Readonly<Record<EffectRequest['kind'], string>> = {
  run_ai_field: 'AI fields',
  fetch_news: 'News',
  transcribe_audio: 'Voice transcription',
  schedule_notification: 'Reminders',
};

/** The kinds an attached effects handler receives. */
const HANDLED_KINDS: ReadonlySet<EffectRequest['kind']> = new Set([
  'run_ai_field',
  'schedule_notification',
]);

function isHandledKind(effect: EffectRequest): boolean {
  return HANDLED_KINDS.has(effect.kind);
}

/** One status message for an Effect_Request this release cannot carry out. */
function effectMessage(effect: EffectRequest): string {
  return `Skipped action ${effect.actionIndex + 1} (${effect.kind}): ${EFFECT_LABELS[effect.kind]} arrives in a later release.`;
}

/**
 * Applies an Execution_Result to the state: stores the returned Stack, handles
 * `navigateTo`, then the messages (the executor's own, then one per effect, in effect
 * order). Effects the attached handler takes (`handlerAttached`) get no message. No messages
 * leave the status unchanged.
 */
function applyResult(
  state: StackState,
  result: ExecutionResult,
  handlerAttached: boolean,
): StackState {
  let next: StackState = { ...state, stack: result.stack };
  if (result.navigateTo !== undefined) {
    next = { ...next, currentCardId: result.navigateTo, selectedObjectId: null, status: null };
  }
  const skipped = handlerAttached
    ? result.effects.filter((effect) => !isHandledKind(effect))
    : result.effects;
  const messages = [...result.messages, ...skipped.map(effectMessage)];
  if (messages.length === 0) {
    return next;
  }
  const seq = next.statusSeq + 1;
  return { ...next, status: { text: messages.join(' '), seq }, statusSeq: seq };
}

/** Creates the one store of the running Stack. It holds no timers; the 4 second expiry lives in the UI. */
export function createStackStore(stack: Stack): StackStoreApi {
  // Kept outside the state: it is not data, and changing it must not re-render anything.
  let effectsHandler: EffectsHandler | null = null;

  type OkResult = Extract<ReturnType<typeof applyOperation>, { ok: true }>;

  /** Runs one Operation on the open Stack; commits it as a user edit, or reports the first error. */
  function runOperation(
    name: string,
    params: unknown,
    after?: (result: OkResult) => Partial<StackState>,
  ): void {
    const state = api.getState();
    const result = applyOperation(state.stack, name, params);
    if (!result.ok) {
      state.setStatus(result.errors[0]?.message ?? 'That change is not allowed.');
      return;
    }
    api.setState({
      ...keepView(state, result.stack),
      ...(after === undefined ? {} : after(result)),
      status: null,
      past: capped([...state.past, { stack: state.stack, source: 'user' }]),
      future: [],
    });
  }

  const api = createStore<StackStore>()((set, get) => ({
    stack,
    currentCardId: stack.startCardId,
    mode: 'interact',
    selectedObjectId: null,
    status: null,
    statusSeq: 0,
    past: [],
    future: [],

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
      const result = executeHandler(state.stack, object.onClick);
      const handler = effectsHandler;
      set(applyResult(state, result, handler !== null));
      if (handler === null) return;
      const handled = result.effects.filter(isHandledKind);
      if (handled.length === 0) return;
      try {
        handler(handled, state.stack);
      } catch {
        // A handler must never break the store or the press.
      }
    },

    typeInField(id, text) {
      const state = get();
      if (state.mode !== 'interact') return;
      const object = currentCard(state)?.objects.find((candidate) => candidate.id === id);
      if (object === undefined || object.type !== 'field' || object.readOnly) return;
      const result = executeHandler(state.stack, [
        { type: 'set_value', targetObjectId: id, value: text },
      ]);
      set(applyResult(state, result, effectsHandler !== null));
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
        past: [],
        future: [],
      });
    },

    applyStack(stack, source = 'ai') {
      get().commitStack(stack, { source });
    },

    commitStack(next, { source }) {
      const state = get();
      if (next === state.stack) return;
      set({
        ...keepView(state, next),
        status: null,
        past: capped([...state.past, { stack: state.stack, source }]),
        future: [],
      });
    },

    editObject(id, changes) {
      runOperation('update_object', { objectId: id, changes });
    },

    addObjectToCard(type) {
      const state = get();
      const card = currentCard(state);
      if (card === undefined) return;
      const size = NEW_OBJECT_SIZE[type];
      const position = newObjectPosition(state.stack, card.objects.length, size);
      runOperation(
        'add_object',
        { cardId: card.id, type, ...position, ...size, ...NEW_OBJECT_EXTRAS[type] },
        (result) => ({ selectedObjectId: result.summary.created[0] ?? null }),
      );
    },

    removeSelected() {
      const id = get().selectedObjectId;
      if (id === null) return;
      runOperation('remove_object', { objectId: id }, () => ({ selectedObjectId: null }));
    },

    addCard() {
      const { stack } = get();
      const names = new Set(stack.cards.map((card) => card.name));
      let number = stack.cards.length + 1;
      while (names.has(`Card ${String(number)}`)) number += 1;
      runOperation('create_card', { name: `Card ${String(number)}` }, (result) => {
        const created = result.summary.created[0];
        return created === undefined
          ? {}
          : { currentCardId: created, selectedObjectId: null as string | null };
      });
    },

    deleteCurrentCard() {
      const state = get();
      const { cards } = state.stack;
      if (cards.length < 2) {
        get().setStatus(LAST_CARD_MESSAGE);
        return;
      }
      const index = cards.findIndex((card) => card.id === state.currentCardId);
      const neighbor = cards[index + 1] ?? cards[index - 1];
      if (index < 0 || neighbor === undefined) return;
      runOperation('delete_card', { cardId: state.currentCardId }, () => ({
        currentCardId: neighbor.id,
        selectedObjectId: null,
      }));
    },

    undoEdit() {
      const state = get();
      const entry = state.past[state.past.length - 1];
      if (entry === undefined) return;
      set({
        ...keepView(state, entry.stack),
        status: null,
        past: state.past.slice(0, -1),
        future: capped([...state.future, { stack: state.stack, source: entry.source }]),
      });
    },

    redoEdit() {
      const state = get();
      const entry = state.future[state.future.length - 1];
      if (entry === undefined) return;
      set({
        ...keepView(state, entry.stack),
        status: null,
        past: capped([...state.past, { stack: state.stack, source: entry.source }]),
        future: state.future.slice(0, -1),
      });
    },

    goToCard(id) {
      const state = get();
      if (!state.stack.cards.some((card) => card.id === id)) return;
      set({ currentCardId: id, selectedObjectId: null, status: null });
    },

    attachEffects(handler) {
      effectsHandler = handler;
      return () => {
        if (handler !== null && effectsHandler === handler) effectsHandler = null;
      };
    },

    setStatus(text) {
      const seq = get().statusSeq + 1;
      set({ status: { text, seq }, statusSeq: seq });
    },
  }));
  return api;
}
