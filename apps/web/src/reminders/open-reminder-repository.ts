import { openIdbReminderRepository } from './idb-reminder-repository.ts';
import { createMemoryReminderRepository } from './memory-reminder-repository.ts';
import type { ReminderRepository } from './types.ts';

export type OpenReminderRepositoryOptions = {
  /**
   * `undefined` (or leaving it out): use the global `indexedDB`, if there is one.
   * `null`: IndexedDB is explicitly unavailable, so go straight to memory.
   * An `IDBFactory`: use it. Tests pass one from `fake-indexeddb`.
   */
  readonly indexedDB?: IDBFactory | null;
  /** Database name. Defaults to the name `openIdbReminderRepository` uses. */
  readonly name?: string;
};

export type OpenedReminderRepository = {
  readonly repository: ReminderRepository;
  /** True when IndexedDB could not be used: reminders then last only until the page closes. */
  readonly memoryMode: boolean;
};

function memoryResult(): OpenedReminderRepository {
  return { repository: createMemoryReminderRepository(), memoryMode: true };
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
 * Opens the IndexedDB reminder repository, or falls back to a memory repository. Never rejects.
 * The fallback applies when there is no IndexedDB, or when opening it rejects or throws.
 */
export async function openReminderRepository(
  options: OpenReminderRepositoryOptions = {},
): Promise<OpenedReminderRepository> {
  const factory = resolveFactory(options.indexedDB);
  if (factory === null) {
    return memoryResult();
  }
  try {
    const repository = await openIdbReminderRepository({
      ...(options.name === undefined ? {} : { name: options.name }),
      indexedDB: factory,
    });
    return { repository, memoryMode: false };
  } catch {
    return memoryResult();
  }
}
