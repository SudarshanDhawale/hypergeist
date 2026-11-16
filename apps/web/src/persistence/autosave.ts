import type { Stack } from '@hypergeist/shared/format';
import type { Result } from './types';

export type AutosaveState = {
  readonly status: 'saved' | 'saving' | 'not-saved';
  /** Plain-words reason while `status` is `not-saved`. `null` otherwise. */
  readonly reason: string | null;
  /** `true` when the browser's storage is full and the UI should offer Export. */
  readonly canExport: boolean;
};

export type AutosaveOptions = {
  /** Writes one stack. Expected failures come back as `{ ok: false }`. */
  readonly write: (stack: Stack) => Promise<Result<unknown>>;
  readonly onState: (state: AutosaveState) => void;
  /** Quiet time after the last change before a write starts. Default 1000. */
  readonly debounceMs?: number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
};

export type Autosave = {
  /** Remembers the newest stack, reports `saving` and restarts the debounce timer. */
  notify(stack: Stack): void;
  /** Cancels the timer and writes the pending stack now. Resolves when that write has finished. */
  flush(): Promise<void>;
  /** Cancels the timer. Later `notify` and `flush` calls do nothing. */
  dispose(): void;
};

const DEFAULT_DEBOUNCE_MS = 1000;
const QUOTA_REASON = "The browser's storage is full.";
const FALLBACK_REASON = 'The stack could not be saved.';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/**
 * Debounced, serialized saving of the open stack. It holds no store and no React:
 * the caller wires `notify` to stack changes and `onState` to the save state store.
 */
export function createAutosave(options: AutosaveOptions): Autosave {
  const { write, onState } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  // Resolved at call time so fake timers installed after creation still apply.
  const startTimer = (callback: () => void, ms: number): TimerHandle =>
    (options.setTimeout ?? globalThis.setTimeout)(callback, ms);
  const stopTimer = (handle: TimerHandle): void => {
    (options.clearTimeout ?? globalThis.clearTimeout)(handle);
  };

  let pending: Stack | undefined;
  let timer: TimerHandle | undefined;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  function clearPendingTimer(): void {
    if (timer !== undefined) {
      stopTimer(timer);
      timer = undefined;
    }
  }

  async function runWrite(): Promise<void> {
    if (disposed || pending === undefined) return;
    const stack = pending;
    pending = undefined;

    let failure: { readonly reason: string; readonly canExport: boolean } | undefined;
    try {
      const result = await write(stack);
      if (!result.ok) {
        const first = result.errors[0];
        failure =
          first?.code === 'QUOTA_EXCEEDED'
            ? { reason: QUOTA_REASON, canExport: true }
            : { reason: first?.message ?? FALLBACK_REASON, canExport: false };
      }
    } catch {
      // A rejecting write must not become an unhandled rejection or stop the chain.
      failure = { reason: FALLBACK_REASON, canExport: false };
    }

    if (disposed) return;
    const newerPending = pending !== undefined;
    if (failure === undefined) {
      if (!newerPending) onState({ status: 'saved', reason: null, canExport: false });
      return;
    }
    // Keep the failed stack in memory unless a newer one replaced it. No retry here.
    if (!newerPending) {
      pending = stack;
      onState({ status: 'not-saved', reason: failure.reason, canExport: failure.canExport });
    }
    // With a newer change waiting, its own write reports the outcome.
  }

  function enqueueWrite(): Promise<void> {
    chain = chain.then(runWrite);
    return chain;
  }

  return {
    notify(stack) {
      if (disposed) return;
      pending = stack;
      onState({ status: 'saving', reason: null, canExport: false });
      clearPendingTimer();
      timer = startTimer(() => {
        timer = undefined;
        void enqueueWrite();
      }, debounceMs);
    },

    flush() {
      if (disposed) return Promise.resolve();
      clearPendingTimer();
      if (pending === undefined) return chain;
      return enqueueWrite();
    },

    dispose() {
      disposed = true;
      clearPendingTimer();
      pending = undefined;
    },
  };
}
