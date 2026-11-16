import 'fake-indexeddb/auto';

import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import demoText from '../stacks/thin-slice-todo.json?raw';

import { DEFAULT_DB_NAME } from './idb-repository.ts';
import {
  BLOCKED_REASON,
  BLOCKED_TIMEOUT_MS,
  OPEN_FAILED_REASON,
  UNAVAILABLE_REASON,
  openRepository,
} from './open-repository.ts';
import type { OpenedRepository } from './open-repository.ts';

const demoStack: Stack = (() => {
  const parsed = parseStack(demoText);
  if (!parsed.ok) {
    throw new Error('The bundled demo stack is not valid.');
  }
  return parsed.value;
})();

const SECRET = 'secret-internal-detail-4711';

/** Saves and loads one stack, proving the repository works. */
async function expectWorking(opened: OpenedRepository): Promise<void> {
  const saved = await opened.repository.save(demoStack, 1000);
  expect(saved.ok).toBe(true);
  const loaded = await opened.repository.load(demoStack.id);
  expect(loaded.ok).toBe(true);
  if (loaded.ok) {
    expect(loaded.value).toEqual(demoStack);
  }
}

function expectNoLeak(opened: OpenedRepository): void {
  expect(opened.reason).toBeDefined();
  expect(opened.reason).not.toContain(SECRET);
  expect(opened.reason).not.toMatch(/Error|\bat \w+|\.ts:\d+/);
}

/** A fake timer: `fire()` runs the scheduled callback once. */
function fakeTimer(): {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  delays: number[];
  cleared: number;
  fire: () => void;
} {
  let callback: (() => void) | undefined;
  const state = {
    delays: [] as number[],
    cleared: 0,
    fire: () => {
      const run = callback;
      callback = undefined;
      run?.();
    },
  };
  const setFake = (handler: () => void, delay?: number): number => {
    callback = handler;
    state.delays.push(delay ?? 0);
    return 1;
  };
  const clearFake = (): void => {
    callback = undefined;
    state.cleared += 1;
  };
  return {
    setTimeout: setFake as unknown as typeof globalThis.setTimeout,
    clearTimeout: clearFake as unknown as typeof globalThis.clearTimeout,
    get delays() {
      return state.delays;
    },
    get cleared() {
      return state.cleared;
    },
    fire: state.fire,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openRepository', () => {
  it('uses memory mode with a reason when indexedDB is null', async () => {
    const opened = await openRepository({ indexedDB: null });
    expect(opened.mode).toBe('memory');
    expect(opened.reason).toBe(UNAVAILABLE_REASON);
    await expectWorking(opened);
  });

  it('uses memory mode when the global indexedDB is undefined and none is passed', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const opened = await openRepository();
    expect(opened.mode).toBe('memory');
    expect(opened.reason).toBe(UNAVAILABLE_REASON);
  });

  it('uses the global indexedDB when none is passed', async () => {
    const opened = await openRepository({ name: 'global-db' });
    expect(opened.mode).toBe('indexeddb');
    expect(opened.reason).toBeUndefined();
    await opened.repository.close();
  });

  it('opens IndexedDB and returns a working repository', async () => {
    const opened = await openRepository({ indexedDB: new IDBFactory() });
    expect(opened.mode).toBe('indexeddb');
    expect(opened.reason).toBeUndefined();
    await expectWorking(opened);
    await opened.repository.close();
  });

  it('keeps data between two opens of the same database', async () => {
    const factory = new IDBFactory();
    const first = await openRepository({ indexedDB: factory });
    await first.repository.save(demoStack, 1000);
    await first.repository.close();
    const second = await openRepository({ indexedDB: factory });
    expect(second.mode).toBe('indexeddb');
    const loaded = await second.repository.load(demoStack.id);
    expect(loaded.ok).toBe(true);
    await second.repository.close();
  });

  it('uses memory mode when open throws, without leaking the error text', async () => {
    const factory = {
      open: () => {
        throw new Error(SECRET);
      },
    } as unknown as IDBFactory;
    const opened = await openRepository({ indexedDB: factory });
    expect(opened.mode).toBe('memory');
    expect(opened.reason).toBe(OPEN_FAILED_REASON);
    expectNoLeak(opened);
    await expectWorking(opened);
  });

  it('uses memory mode when the open request fails (stored version is newer)', async () => {
    const factory = new IDBFactory();
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DEFAULT_DB_NAME, 5);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error(SECRET));
      };
    });
    const opened = await openRepository({ indexedDB: factory });
    newer.close();
    expect(opened.mode).toBe('memory');
    expect(opened.reason).toBe(OPEN_FAILED_REASON);
    expectNoLeak(opened);
    await expectWorking(opened);
  });

  it('keeps waiting while blocked and falls back after the timeout', async () => {
    const real = new IDBFactory();
    // Another tab: holds version 1 and ignores `versionchange`, so it never lets go.
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = real.open(DEFAULT_DB_NAME, 1);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error('could not open the holder'));
      };
    });
    // The repository asks for version 1; the proxy asks for 2, which a held version 1 blocks.
    const upgrading = {
      open: (name: string, version?: number) => real.open(name, (version ?? 1) + 1),
    } as unknown as IDBFactory;

    const timer = fakeTimer();
    let blockedCalls = 0;
    let onBlockedSeen: () => void = () => undefined;
    const blockedSeen = new Promise<void>((resolve) => {
      onBlockedSeen = resolve;
    });
    let settled = false;
    const pending = openRepository({
      indexedDB: upgrading,
      onBlocked: () => {
        blockedCalls += 1;
        onBlockedSeen();
      },
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    }).then((value) => {
      settled = true;
      return value;
    });

    await blockedSeen;
    expect(blockedCalls).toBe(1);
    expect(timer.delays).toEqual([BLOCKED_TIMEOUT_MS]);
    expect(settled).toBe(false);

    timer.fire();
    const opened = await pending;
    expect(opened.mode).toBe('memory');
    expect(opened.reason).toBe(BLOCKED_REASON);
    expectNoLeak(opened);
    await expectWorking(opened);

    // Letting go afterwards must not change the result or throw.
    holder.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened.mode).toBe('memory');
  });

  it('opens normally when the block clears before the timeout', async () => {
    const real = new IDBFactory();
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = real.open(DEFAULT_DB_NAME, 1);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error('could not open the holder'));
      };
    });
    const upgrading = {
      open: (name: string, version?: number) => real.open(name, (version ?? 1) + 1),
    } as unknown as IDBFactory;

    const timer = fakeTimer();
    let onBlockedSeen: () => void = () => undefined;
    const blockedSeen = new Promise<void>((resolve) => {
      onBlockedSeen = resolve;
    });
    const pending = openRepository({
      indexedDB: upgrading,
      onBlocked: () => {
        onBlockedSeen();
      },
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    await blockedSeen;
    holder.close();
    const opened = await pending;
    expect(opened.mode).toBe('indexeddb');
    expect(opened.reason).toBeUndefined();
    expect(timer.cleared).toBe(1);
    await opened.repository.close();
  });
});
