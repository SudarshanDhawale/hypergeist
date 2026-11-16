import { openIdbRepository } from './idb-repository.ts';
import { createMemoryRepository } from './memory-repository.ts';
import type { Repository } from './types.ts';

/** How long a blocked database upgrade is waited for before the app falls back to Memory_Mode. */
export const BLOCKED_TIMEOUT_MS = 3000;

/** Reason when the browser has no IndexedDB at all (or it was passed as `null`). */
export const UNAVAILABLE_REASON = 'This browser does not allow stacks to be stored here.';

/** Reason when IndexedDB exists but the database could not be opened. */
export const OPEN_FAILED_REASON = 'This browser would not open its storage for your stacks.';

/** Reason when another tab keeps an older connection open and the upgrade stays blocked. */
export const BLOCKED_REASON = 'Another tab has this app open. Close it and reload this page.';

export type OpenRepositoryOptions = {
  /**
   * `undefined` (or leaving it out): use the global `indexedDB`, if there is one.
   * `null`: IndexedDB is explicitly unavailable, so go straight to Memory_Mode.
   * An `IDBFactory`: use it. Tests pass one from `fake-indexeddb`.
   */
  readonly indexedDB?: IDBFactory | null;
  /** Database name. Defaults to the name `openIdbRepository` uses. */
  readonly name?: string;
  /** Called when another tab blocks the upgrade. The open keeps waiting until the timeout. */
  readonly onBlocked?: () => void;
  /** Called when this connection is closed so another tab can upgrade. */
  readonly onBlocking?: () => void;
  /** Timer used for the blocked timeout. Defaults to the global `setTimeout`. */
  readonly setTimeout?: typeof globalThis.setTimeout;
  /** Pairs with `setTimeout`. Defaults to the global `clearTimeout`. */
  readonly clearTimeout?: typeof globalThis.clearTimeout;
};

export type OpenedRepository = {
  readonly repository: Repository;
  readonly mode: 'indexeddb' | 'memory';
  /** Plain-words explanation. Only set when `mode` is `memory`. Never contains exception text. */
  readonly reason?: string;
};

function memoryResult(reason: string): OpenedRepository {
  return { repository: createMemoryRepository(), mode: 'memory', reason };
}

function resolveFactory(option: IDBFactory | null | undefined): IDBFactory | null {
  if (option === null) {
    return null;
  }
  if (option !== undefined) {
    return option;
  }
  return typeof globalThis.indexedDB === 'undefined' ? null : globalThis.indexedDB;
}

/**
 * Opens the IndexedDB repository, or falls back to a memory repository (Memory_Mode) with a
 * plain-words reason. Never rejects.
 *
 * Fallback cases:
 * - no IndexedDB, or `indexedDB: null`: `UNAVAILABLE_REASON`;
 * - the open rejects or throws: `OPEN_FAILED_REASON`;
 * - the upgrade is blocked by another tab and still pending `BLOCKED_TIMEOUT_MS` after the
 *   `blocked` event: `BLOCKED_REASON`.
 *
 * The timeout starts at the `blocked` event, so a slow but unblocked open is never cut off.
 * If a blocked open completes after the fallback, its connection is closed at once so it does
 * not keep blocking other tabs.
 */
export function openRepository(options: OpenRepositoryOptions = {}): Promise<OpenedRepository> {
  const factory = resolveFactory(options.indexedDB);
  if (factory === null) {
    return Promise.resolve(memoryResult(UNAVAILABLE_REASON));
  }
  const schedule = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const cancel = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);

  return new Promise<OpenedRepository>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

    function finish(value: OpenedRepository): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      resolve(value);
    }

    openIdbRepository({
      ...(options.name === undefined ? {} : { name: options.name }),
      indexedDB: factory,
      onBlocked: () => {
        options.onBlocked?.();
        if (!settled && timer === undefined) {
          timer = schedule(() => {
            timer = undefined;
            finish(memoryResult(BLOCKED_REASON));
          }, BLOCKED_TIMEOUT_MS);
        }
      },
      ...(options.onBlocking === undefined ? {} : { onBlocking: options.onBlocking }),
    }).then(
      (repository) => {
        if (settled) {
          void repository.close();
          return;
        }
        finish({ repository, mode: 'indexeddb' });
      },
      () => {
        finish(memoryResult(OPEN_FAILED_REASON));
      },
    );
  });
}
