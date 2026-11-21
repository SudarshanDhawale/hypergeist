import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REMINDER_DB_NAME } from './idb-reminder-repository.ts';
import { openReminderRepository } from './open-reminder-repository.ts';
import { makeReminder } from './reminder-repository.contract.ts';

describe('openReminderRepository', () => {
  it('returns the IndexedDB repository when it opens', async () => {
    const opened = await openReminderRepository({ indexedDB: new IDBFactory() });
    expect(opened.memoryMode).toBe(false);
    expect((await opened.repository.put(makeReminder('a'))).ok).toBe(true);
  });

  it('uses the global indexedDB when no factory is given', async () => {
    const opened = await openReminderRepository({ name: 'open-reminder-global-test' });
    expect(opened.memoryMode).toBe(false);
    expect((await opened.repository.put(makeReminder('a'))).ok).toBe(true);
  });

  it('keeps reminders between two opens of the same factory', async () => {
    const factory = new IDBFactory();
    const first = await openReminderRepository({ indexedDB: factory });
    await first.repository.put(makeReminder('a'));
    const second = await openReminderRepository({ indexedDB: factory });
    // The first connection is still open; a second open of the same version is allowed.
    expect(second.memoryMode).toBe(false);
    expect(await second.repository.list()).toEqual({ ok: true, value: [makeReminder('a')] });
  });

  it('falls back to memory when indexedDB is null', async () => {
    const opened = await openReminderRepository({ indexedDB: null });
    expect(opened.memoryMode).toBe(true);
    expect((await opened.repository.put(makeReminder('a'))).ok).toBe(true);
    expect(await opened.repository.list()).toEqual({ ok: true, value: [makeReminder('a')] });
  });

  it('falls back to memory when the global indexedDB is missing', async () => {
    const saved = globalThis.indexedDB;
    // @ts-expect-error The test removes the global on purpose to simulate a browser without it.
    delete globalThis.indexedDB;
    try {
      const opened = await openReminderRepository();
      expect(opened.memoryMode).toBe(true);
    } finally {
      globalThis.indexedDB = saved;
    }
  });

  it('falls back to memory when the open throws', async () => {
    const throwing = {
      open() {
        throw new Error('open failed');
      },
    } as unknown as IDBFactory;
    const opened = await openReminderRepository({ indexedDB: throwing });
    expect(opened.memoryMode).toBe(true);
    expect((await opened.repository.list()).ok).toBe(true);
  });

  it('falls back to memory when the open request fails', async () => {
    const name = DEFAULT_REMINDER_DB_NAME;
    const factory = new IDBFactory();
    // A database that is already at version 2 makes an open at version 1 fail with VersionError.
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(name, 2);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => {
        reject(new Error('Could not prepare the test database.'));
      };
    });
    const opened = await openReminderRepository({ indexedDB: factory });
    expect(opened.memoryMode).toBe(true);
  });
});
