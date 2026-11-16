import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Stack } from '@hypergeist/shared/format';

import demoText from '../stacks/thin-slice-todo.json?raw';
import { createAutosave } from './autosave.ts';
import type { AutosaveState } from './autosave.ts';
import { parseImport } from './import-stack.ts';
import type { PersistenceError, Result } from './types.ts';

function baseStack(): Stack {
  const result = parseImport(demoText);
  if (!result.ok) throw new Error('bundled demo stack must parse');
  return result.stack;
}

/** A stack that differs from the others by its name only. */
function stackNamed(name: string): Stack {
  return { ...baseStack(), name };
}

type Deferred = {
  readonly stack: Stack;
  resolve(result: Result<unknown>): void;
  reject(error: unknown): void;
};

const OK: Result<unknown> = { ok: true, value: undefined };

function failure(code: PersistenceError['code'], message: string): Result<unknown> {
  return { ok: false, errors: [{ code, message }] };
}

/** A write whose calls stay open until the test resolves them. */
function controlledWrite(): {
  readonly write: (stack: Stack) => Promise<Result<unknown>>;
  readonly calls: Deferred[];
} {
  const calls: Deferred[] = [];
  const write = (stack: Stack): Promise<Result<unknown>> =>
    new Promise<Result<unknown>>((resolve, reject) => {
      calls.push({ stack, resolve, reject });
    });
  return { write, calls };
}

function recorder(): {
  readonly states: AutosaveState[];
  readonly onState: (s: AutosaveState) => void;
} {
  const states: AutosaveState[] = [];
  return { states, onState: (s) => states.push(s) };
}

function names(stacks: readonly Stack[]): string[] {
  return stacks.map((s) => s.name);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAutosave', () => {
  it('gives one write of the last value for several changes within the window', async () => {
    const written: Stack[] = [];
    const { onState } = recorder();
    const autosave = createAutosave({
      write: (stack) => {
        written.push(stack);
        return Promise.resolve(OK);
      },
      onState,
    });

    autosave.notify(stackNamed('a'));
    await vi.advanceTimersByTimeAsync(400);
    autosave.notify(stackNamed('b'));
    await vi.advanceTimersByTimeAsync(400);
    autosave.notify(stackNamed('c'));
    await vi.advanceTimersByTimeAsync(999);
    expect(written).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(names(written)).toEqual(['c']);
    autosave.dispose();
  });

  it('reports saving, then saved after a successful write', async () => {
    const { states, onState } = recorder();
    const autosave = createAutosave({ write: () => Promise.resolve(OK), onState });

    autosave.notify(stackNamed('a'));
    expect(states.map((s) => s.status)).toEqual(['saving']);

    await vi.advanceTimersByTimeAsync(1000);
    expect(states.map((s) => s.status)).toEqual(['saving', 'saved']);
    expect(states[1]).toEqual({ status: 'saved', reason: null, canExport: false });
    autosave.dispose();
  });

  it('honours a custom debounce time', async () => {
    const write = vi.fn(() => Promise.resolve(OK));
    const autosave = createAutosave({ write, onState: () => undefined, debounceMs: 50 });

    autosave.notify(stackNamed('a'));
    await vi.advanceTimersByTimeAsync(49);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    autosave.dispose();
  });

  it('writes a change made during a write after it, never before, and stays saving until then', async () => {
    const { write, calls } = controlledWrite();
    const { states, onState } = recorder();
    const autosave = createAutosave({ write, onState });

    autosave.notify(stackNamed('first'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(names(calls.map((c) => c.stack))).toEqual(['first']);

    // The first write is still running. A newer change arrives and its timer expires.
    autosave.notify(stackNamed('second'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);

    calls[0]?.resolve(OK);
    await vi.advanceTimersByTimeAsync(0);
    expect(names(calls.map((c) => c.stack))).toEqual(['first', 'second']);
    // Not "saved" while the newer change is still being written.
    expect(states.map((s) => s.status)).not.toContain('saved');

    calls[1]?.resolve(OK);
    await vi.advanceTimersByTimeAsync(0);
    expect(states[states.length - 1]?.status).toBe('saved');
    autosave.dispose();
  });

  it('keeps saving after a write when a newer change is still waiting for its timer', async () => {
    const { write, calls } = controlledWrite();
    const { states, onState } = recorder();
    const autosave = createAutosave({ write, onState });

    autosave.notify(stackNamed('first'));
    await vi.advanceTimersByTimeAsync(1000);
    autosave.notify(stackNamed('second'));
    calls[0]?.resolve(OK);
    await vi.advanceTimersByTimeAsync(0);

    expect(states.map((s) => s.status)).toEqual(['saving', 'saving']);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(names(calls.map((c) => c.stack))).toEqual(['first', 'second']);
    autosave.dispose();
  });

  it('flush writes at once and resolves after the write finished', async () => {
    const { write, calls } = controlledWrite();
    const { states, onState } = recorder();
    const autosave = createAutosave({ write, onState });

    autosave.notify(stackNamed('a'));
    autosave.notify(stackNamed('b'));
    let flushed = false;
    const flushing = autosave.flush().then(() => {
      flushed = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(names(calls.map((c) => c.stack))).toEqual(['b']);
    expect(flushed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    calls[0]?.resolve(OK);
    await flushing;
    expect(flushed).toBe(true);
    expect(states[states.length - 1]?.status).toBe('saved');

    // The cancelled timer does not write a second time.
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);
    autosave.dispose();
  });

  it('flush with nothing pending does not write', async () => {
    const write = vi.fn(() => Promise.resolve(OK));
    const { states, onState } = recorder();
    const autosave = createAutosave({ write, onState });

    await autosave.flush();
    expect(write).not.toHaveBeenCalled();
    expect(states).toEqual([]);

    autosave.notify(stackNamed('a'));
    await vi.advanceTimersByTimeAsync(1000);
    await autosave.flush();
    expect(write).toHaveBeenCalledTimes(1);
    autosave.dispose();
  });

  it('reports not-saved with the first error message, keeps the stack, and retries on the next change', async () => {
    const results: Result<unknown>[] = [failure('STORAGE_FAILED', 'Saving failed.'), OK];
    const written: Stack[] = [];
    const { states, onState } = recorder();
    const autosave = createAutosave({
      write: (stack) => {
        written.push(stack);
        return Promise.resolve(results.shift() ?? OK);
      },
      onState,
    });

    autosave.notify(stackNamed('a'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states[states.length - 1]).toEqual({
      status: 'not-saved',
      reason: 'Saving failed.',
      canExport: false,
    });

    // No retry by itself.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(written).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    autosave.notify(stackNamed('b'));
    expect(states[states.length - 1]?.status).toBe('saving');
    await vi.advanceTimersByTimeAsync(1000);
    expect(names(written)).toEqual(['a', 'b']);
    expect(states[states.length - 1]).toEqual({ status: 'saved', reason: null, canExport: false });
    autosave.dispose();
  });

  it('retries the same value when notify is called again with it after a failure', async () => {
    const results: Result<unknown>[] = [failure('STORAGE_FAILED', 'Saving failed.'), OK];
    const written: Stack[] = [];
    const { states, onState } = recorder();
    const autosave = createAutosave({
      write: (stack) => {
        written.push(stack);
        return Promise.resolve(results.shift() ?? OK);
      },
      onState,
    });
    const stack = stackNamed('same');

    autosave.notify(stack);
    await vi.advanceTimersByTimeAsync(1000);
    autosave.notify(stack);
    await vi.advanceTimersByTimeAsync(1000);

    expect(written).toEqual([stack, stack]);
    expect(states[states.length - 1]?.status).toBe('saved');
    autosave.dispose();
  });

  it('flush after a failure writes the kept stack again', async () => {
    const results: Result<unknown>[] = [failure('STORAGE_FAILED', 'Saving failed.'), OK];
    const written: Stack[] = [];
    const { states, onState } = recorder();
    const autosave = createAutosave({
      write: (stack) => {
        written.push(stack);
        return Promise.resolve(results.shift() ?? OK);
      },
      onState,
    });

    autosave.notify(stackNamed('kept'));
    await vi.advanceTimersByTimeAsync(1000);
    await autosave.flush();

    expect(names(written)).toEqual(['kept', 'kept']);
    expect(states[states.length - 1]?.status).toBe('saved');
    autosave.dispose();
  });

  it('handles a write that rejects, and keeps working afterwards', async () => {
    // Vitest fails the run on an unhandled rejection, so reaching the end proves there was none.
    let calls = 0;
    const { states, onState } = recorder();
    const autosave = createAutosave({
      write: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('IDB exploded')) : Promise.resolve(OK);
      },
      onState,
    });

    autosave.notify(stackNamed('a'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states[states.length - 1]).toEqual({
      status: 'not-saved',
      reason: 'The stack could not be saved.',
      canExport: false,
    });
    // The technical message does not reach the user.
    expect(JSON.stringify(states)).not.toContain('IDB exploded');

    autosave.notify(stackNamed('b'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states[states.length - 1]?.status).toBe('saved');
    autosave.dispose();
  });

  it('handles a write that throws before returning a promise', async () => {
    const { states, onState } = recorder();
    const autosave = createAutosave({
      write: () => {
        throw new Error('sync failure');
      },
      onState,
    });

    autosave.notify(stackNamed('a'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states[states.length - 1]?.status).toBe('not-saved');
    autosave.dispose();
  });

  it('sets canExport and the storage-full reason for QUOTA_EXCEEDED', async () => {
    const { states, onState } = recorder();
    const autosave = createAutosave({
      write: () => Promise.resolve(failure('QUOTA_EXCEEDED', 'Some technical quota text.')),
      onState,
    });

    autosave.notify(stackNamed('a'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states[states.length - 1]).toEqual({
      status: 'not-saved',
      reason: "The browser's storage is full.",
      canExport: true,
    });
    autosave.dispose();
  });

  it('clears canExport again after a later successful write', async () => {
    const results: Result<unknown>[] = [failure('QUOTA_EXCEEDED', 'full'), OK];
    const { states, onState } = recorder();
    const autosave = createAutosave({
      write: () => Promise.resolve(results.shift() ?? OK),
      onState,
    });

    autosave.notify(stackNamed('a'));
    await vi.advanceTimersByTimeAsync(1000);
    autosave.notify(stackNamed('b'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states[states.length - 1]).toEqual({ status: 'saved', reason: null, canExport: false });
    autosave.dispose();
  });

  it('dispose cancels the timer and leaves no timers behind', async () => {
    const write = vi.fn(() => Promise.resolve(OK));
    const autosave = createAutosave({ write, onState: () => undefined });

    autosave.notify(stackNamed('a'));
    expect(vi.getTimerCount()).toBe(1);
    autosave.dispose();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(write).not.toHaveBeenCalled();
  });

  it('ignores notify and flush after dispose', async () => {
    const write = vi.fn(() => Promise.resolve(OK));
    const { states, onState } = recorder();
    const autosave = createAutosave({ write, onState });

    autosave.dispose();
    autosave.notify(stackNamed('a'));
    await autosave.flush();
    await vi.advanceTimersByTimeAsync(5000);

    expect(write).not.toHaveBeenCalled();
    expect(states).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports nothing for a write that finishes after dispose', async () => {
    const { write, calls } = controlledWrite();
    const { states, onState } = recorder();
    const autosave = createAutosave({ write, onState });

    autosave.notify(stackNamed('a'));
    await vi.advanceTimersByTimeAsync(1000);
    autosave.dispose();
    calls[0]?.resolve(OK);
    await vi.advanceTimersByTimeAsync(0);

    expect(states.map((s) => s.status)).toEqual(['saving']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the injected timer functions', () => {
    const setTimer = vi.fn(() => 7 as unknown as ReturnType<typeof setTimeout>);
    const clearTimer = vi.fn();
    const autosave = createAutosave({
      write: () => Promise.resolve(OK),
      onState: () => undefined,
      debounceMs: 250,
      setTimeout: setTimer as unknown as typeof globalThis.setTimeout,
      clearTimeout: clearTimer as unknown as typeof globalThis.clearTimeout,
    });

    autosave.notify(stackNamed('a'));
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 250);
    autosave.notify(stackNamed('b'));
    expect(clearTimer).toHaveBeenCalledWith(7);
    autosave.dispose();
    expect(clearTimer).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
