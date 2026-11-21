import { wrap } from 'idb';
import type { DBSchema, IDBPDatabase, IDBPObjectStore } from 'idb';

import {
  MAX_STORED_REMINDERS,
  REMINDER_CLOSED_MESSAGE,
  REMINDER_FAILED_MESSAGE,
  REMINDER_INVALID_MESSAGE,
  REMINDER_QUOTA_MESSAGE,
  compareReminders,
  reminderFail,
  reminderOk,
} from './memory-reminder-repository.ts';
import type {
  ClosableReminderRepository,
  ReminderRepositoryTesting,
} from './memory-reminder-repository.ts';
import { ReminderSchema } from './types.ts';
import type { Reminder, ReminderResult } from './types.ts';

/** Schema version of the database. Raise it and add a step to `upgrade` to change the record shape. */
export const REMINDER_DB_VERSION = 1;

/** Name used when `openIdbReminderRepository` is called without a `name`. */
export const DEFAULT_REMINDER_DB_NAME = 'hypergeist-reminders';

const STORE = 'reminders';

type Store = IDBPObjectStore<ReminderDB, [typeof STORE], typeof STORE, 'readwrite'>;

/**
 * Object stores of the database. Values are `unknown` on purpose: whatever is stored can be
 * damaged, so every read goes through `ReminderSchema` before it is trusted.
 */
export interface ReminderDB extends DBSchema {
  /** Key path `id`. */
  reminders: { key: string; value: unknown };
}

export type IdbReminderRepository = ClosableReminderRepository & {
  readonly testing: ReminderRepositoryTesting;
};

export type OpenIdbReminderRepositoryOptions = {
  /** Database name. Defaults to `'hypergeist-reminders'`. */
  readonly name?: string;
  /** IndexedDB factory. Defaults to the global `indexedDB`. `idb` still needs the global IDB classes. */
  readonly indexedDB?: IDBFactory;
  /** Called when another tab keeps an older connection open and stops this one from upgrading. */
  readonly onBlocked?: () => void;
};

/**
 * Creates the object store. Runs inside the version change transaction.
 * Version 0 means the database did not exist. A later release adds an `if (oldVersion < 2)`
 * step below the first one.
 */
export function upgrade(db: IDBPDatabase<ReminderDB>, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore(STORE, { keyPath: 'id' });
  }
}

/** Opens the database with a given factory. Same steps as `openDB` from `idb`, which only uses the global. */
function openWith(
  factory: IDBFactory,
  name: string,
  callbacks: { onBlocked?: (() => void) | undefined },
): Promise<IDBPDatabase<ReminderDB>> {
  const request = factory.open(name, REMINDER_DB_VERSION);
  const opened = wrap(request) as Promise<IDBPDatabase<ReminderDB>>;
  request.addEventListener('upgradeneeded', (event) => {
    upgrade(wrap(request.result) as IDBPDatabase<ReminderDB>, event.oldVersion);
  });
  request.addEventListener('blocked', () => {
    callbacks.onBlocked?.();
  });
  return opened;
}

/** Aborts a transaction, ignoring the error when it has already finished. */
function abortQuietly(tx: { abort(): void }): void {
  try {
    tx.abort();
  } catch {
    // The transaction was already finished or aborted. Nothing is left to undo.
  }
}

/**
 * Opens (and if needed creates) the database and returns a reminder repository over it.
 * Rejects when the database cannot be opened; `openReminderRepository` then switches to memory.
 * After that, no method ever throws or rejects: failures come back as `STORAGE_FAILED`.
 */
export async function openIdbReminderRepository(
  options: OpenIdbReminderRepositoryOptions = {},
): Promise<IdbReminderRepository> {
  const name = options.name ?? DEFAULT_REMINDER_DB_NAME;
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (factory === undefined) {
    throw new Error('IndexedDB is not available in this browser.');
  }

  let closedMessage: string | undefined;
  const connection = await openWith(factory, name, { onBlocked: options.onBlocked });
  connection.addEventListener('versionchange', () => {
    // Another tab wants to upgrade. Close so it can, and say so on later calls.
    closedMessage = 'Reminder storage was closed so another tab can update it. Reload the page.';
    connection.close();
  });
  connection.addEventListener('close', () => {
    closedMessage ??= 'The browser closed the connection to reminder storage. Reload the page.';
  });

  /**
   * Runs `work` in one read-write transaction. The transaction commits when `work` returns `ok`
   * and is aborted (nothing written) when it returns a failure or throws. Never throws.
   * `work` may only await IndexedDB requests, or the transaction would close under it.
   */
  async function run<T>(
    work: (store: Store) => Promise<ReminderResult<T>>,
  ): Promise<ReminderResult<T>> {
    if (closedMessage !== undefined) {
      return reminderFail('STORAGE_FAILED', closedMessage);
    }
    try {
      const tx = connection.transaction(STORE, 'readwrite');
      // The done promise rejects on every abort. Mark it handled; the outcome is read below.
      tx.done.catch(() => undefined);
      try {
        const result = await work(tx.objectStore(STORE));
        if (!result.ok) {
          abortQuietly(tx);
          return result;
        }
        await tx.done;
        return result;
      } catch {
        abortQuietly(tx);
        return reminderFail('STORAGE_FAILED', REMINDER_FAILED_MESSAGE);
      }
    } catch {
      // `transaction()` throws when the connection is closed or the store is missing.
      return reminderFail('STORAGE_FAILED', REMINDER_FAILED_MESSAGE);
    }
  }

  return {
    list() {
      return run<readonly Reminder[]>(async (store) => {
        const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()]);
        const valid: Reminder[] = [];
        const deletions: Promise<void>[] = [];
        for (const [index, key] of keys.entries()) {
          const parsed = ReminderSchema.safeParse(values[index]);
          if (parsed.success && parsed.data.id === key) {
            valid.push(parsed.data);
          } else {
            deletions.push(store.delete(key));
          }
        }
        await Promise.all(deletions);
        valid.sort(compareReminders);
        return reminderOk<readonly Reminder[]>(valid);
      });
    },

    put(reminder) {
      const parsed = ReminderSchema.safeParse(reminder);
      if (!parsed.success) {
        return Promise.resolve(reminderFail('INVALID_REMINDER', REMINDER_INVALID_MESSAGE));
      }
      const valid = parsed.data;
      return run<void>(async (store) => {
        const existing = await store.getKey(valid.id);
        if (existing === undefined && (await store.count()) >= MAX_STORED_REMINDERS) {
          return reminderFail('QUOTA_EXCEEDED', REMINDER_QUOTA_MESSAGE);
        }
        await store.put(valid);
        return reminderOk(undefined);
      });
    },

    remove(id) {
      return run<void>(async (store) => {
        await store.delete(id);
        return reminderOk(undefined);
      });
    },

    close() {
      closedMessage ??= REMINDER_CLOSED_MESSAGE;
      connection.close();
      return Promise.resolve();
    },

    testing: {
      async putRaw(record) {
        const result = await run<void>(async (store) => {
          await store.put(record);
          return reminderOk(undefined);
        });
        if (!result.ok) {
          throw new Error('The raw reminder could not be stored.');
        }
      },
      async rawIds() {
        const result = await run<readonly string[]>(async (store) => {
          const keys = await store.getAllKeys();
          return reminderOk(keys.filter((key) => typeof key === 'string').sort());
        });
        if (!result.ok) {
          throw new Error('The stored reminder ids could not be read.');
        }
        return result.value;
      },
    },
  };
}
