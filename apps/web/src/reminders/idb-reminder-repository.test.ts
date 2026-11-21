import 'fake-indexeddb/auto';

import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REMINDER_DB_NAME,
  REMINDER_DB_VERSION,
  openIdbReminderRepository,
} from './idb-reminder-repository.ts';
import { makeReminder, runReminderRepositoryContract } from './reminder-repository.contract.ts';
import type { ReminderContractHarness } from './reminder-repository.contract.ts';

let nextDatabase = 0;

/** Module counter: every database in this file gets its own name, so tests cannot see each other. */
function uniqueName(): string {
  nextDatabase += 1;
  return `idb-reminder-repository-test-${String(nextDatabase)}`;
}

/** Deletes a database. Every connection to it must be closed first, or this waits for them. */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(new Error(`Could not delete the test database "${name}".`));
    };
  });
}

runReminderRepositoryContract('idb repository', async (): Promise<ReminderContractHarness> => {
  const name = uniqueName();
  const repository = await openIdbReminderRepository({ name });
  return {
    repository,
    testing: repository.testing,
    close: () => deleteDatabase(name),
  };
});

describe('openIdbReminderRepository', () => {
  it('uses the database name hypergeist-reminders at version 1 with a reminders store keyed by id', async () => {
    expect(DEFAULT_REMINDER_DB_NAME).toBe('hypergeist-reminders');
    expect(REMINDER_DB_VERSION).toBe(1);

    const repository = await openIdbReminderRepository();
    await repository.put(makeReminder('a'));
    await repository.close();

    const db = await openDB(DEFAULT_REMINDER_DB_NAME);
    try {
      expect(db.version).toBe(1);
      expect([...db.objectStoreNames]).toEqual(['reminders']);
      const store = db.transaction('reminders').store;
      expect(store.keyPath).toBe('id');
      expect(store.autoIncrement).toBe(false);
      expect(await store.getAllKeys()).toEqual(['a']);
    } finally {
      db.close();
    }
    await deleteDatabase(DEFAULT_REMINDER_DB_NAME);
  });

  it('keeps reminders across a close and a new open of the same database', async () => {
    const name = uniqueName();
    const first = await openIdbReminderRepository({ name });
    await first.put(makeReminder('a', { dueAt: 9 }));
    await first.close();

    const second = await openIdbReminderRepository({ name });
    expect(await second.list()).toEqual({ ok: true, value: [makeReminder('a', { dueAt: 9 })] });
    await second.close();
    await deleteDatabase(name);
  });

  it('rejects when there is no IndexedDB factory', async () => {
    const saved = globalThis.indexedDB;
    // @ts-expect-error The test removes the global on purpose to see the missing-factory error.
    delete globalThis.indexedDB;
    try {
      await expect(openIdbReminderRepository({ name: uniqueName() })).rejects.toThrow();
    } finally {
      globalThis.indexedDB = saved;
    }
  });

  it('closes its connection when another tab upgrades, then fails later calls without throwing', async () => {
    const name = uniqueName();
    const repository = await openIdbReminderRepository({ name });
    await repository.put(makeReminder('a'));

    // A newer version from "another tab": the repository must close so the upgrade can go on.
    const upgraded = await openDB(name, 2);
    upgraded.close();

    const result = await repository.list();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toEqual(['STORAGE_FAILED']);
    }
    await deleteDatabase(name);
  });

  it('rejects the open when the stored database is newer than this code', async () => {
    const name = uniqueName();
    const newer = await openDB(name, 2, {
      upgrade(upgradeDb) {
        upgradeDb.createObjectStore('reminders', { keyPath: 'id' });
      },
    });
    newer.close();
    await expect(openIdbReminderRepository({ name })).rejects.toThrow();
    await deleteDatabase(name);
  });
});
