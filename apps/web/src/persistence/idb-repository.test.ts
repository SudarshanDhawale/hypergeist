import 'fake-indexeddb/auto';

import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { openDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import demoText from '../stacks/thin-slice-todo.json?raw';

import { DB_VERSION, DEFAULT_DB_NAME, openIdbRepository, upgrade } from './idb-repository.ts';
import type { HyperGeistDB, IdbRepository, OpenIdbRepositoryOptions } from './idb-repository.ts';
import { runRepositoryContract } from './repository.contract.ts';
import type { ContractHarness } from './repository.contract.ts';
import type { Result, SeedStack } from './types.ts';

const FILE_PREFIX = 'idb-repository-test';

/** Module counter: every database in this file gets its own name, so tests cannot see each other. */
let nextDatabase = 0;

function uniqueName(): string {
  nextDatabase += 1;
  return `${FILE_PREFIX}-${nextDatabase}`;
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

/** Opens a repository on a database that is deleted again by `close()` of the harness. */
async function idbHarness(
  options: { readonly afterPuts?: number } | undefined = undefined,
): Promise<ContractHarness> {
  const name = uniqueName();
  const repository = await openIdbRepository({ name });
  if (options?.afterPuts !== undefined) {
    repository.testing.failNextWrite({ afterPuts: options.afterPuts, kind: 'clone' });
  }
  return {
    repository,
    putRawStack: (record) => repository.testing.putRawStack(record),
    quarantined: async () => (await repository.testing.quarantine()).map((entry) => entry.record),
    // A new database whose next multi-record write lets one record through, then fails once.
    seedFailureSetup: () => idbHarness({ afterPuts: 1 }),
    close: async () => {
      await repository.close();
      await deleteDatabase(name);
    },
  };
}

runRepositoryContract('idb repository', () => idbHarness());

const baseStack: Stack = (() => {
  const parsed = parseStack(demoText);
  if (!parsed.ok) {
    throw new Error('The bundled demo stack is not valid.');
  }
  return parsed.value;
})();

function makeStack(id: string, name: string = `Stack ${id}`): Stack {
  return { ...structuredClone(baseStack), id, name };
}

function seedsOf(...ids: string[]): SeedStack[] {
  return ids.map((id) => ({ stack: makeStack(id, `Original ${id}`) }));
}

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`Expected ok, got ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function errorOf<T>(result: Result<T>): { code: string; message: string } {
  if (result.ok) {
    throw new Error('Expected a failure, got ok.');
  }
  const [first] = result.errors;
  if (first === undefined) {
    throw new Error('A failure result had no errors.');
  }
  return { code: first.code, message: first.message };
}

describe('idb repository: IndexedDB specifics', () => {
  const repositories: IdbRepository[] = [];
  const names: string[] = [];

  /** Opens a repository on `name` (a fresh name by default) and cleans it up after the test. */
  async function open(
    name: string = uniqueName(),
    options: Omit<OpenIdbRepositoryOptions, 'name'> = {},
  ): Promise<IdbRepository> {
    if (!names.includes(name)) {
      names.push(name);
    }
    const repository = await openIdbRepository({ ...options, name });
    repositories.push(repository);
    return repository;
  }

  /** A name that is deleted after the test, for tests that open the database themselves. */
  function trackedName(): string {
    const name = uniqueName();
    names.push(name);
    return name;
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const repository of repositories.splice(0)) {
      await repository.close();
    }
    for (const name of names.splice(0)) {
      await deleteDatabase(name);
    }
  });

  describe('upgrade from version 0', () => {
    async function describeStores(name: string) {
      const db = await openDB<HyperGeistDB>(name);
      try {
        const storeNames = Array.from(db.objectStoreNames).sort();
        const tx = db.transaction(storeNames);
        const stores = Object.fromEntries(
          storeNames.map((storeName) => {
            const store = tx.objectStore(storeName);
            return [storeName, { keyPath: store.keyPath, autoIncrement: store.autoIncrement }];
          }),
        );
        await tx.done;
        return { version: db.version, storeNames, stores };
      } finally {
        db.close();
      }
    }

    const expectedStores = {
      meta: { keyPath: null, autoIncrement: false },
      quarantine: { keyPath: null, autoIncrement: true },
      stacks: { keyPath: 'stack.id', autoIncrement: false },
      trash: { keyPath: null, autoIncrement: true },
    };

    it('creates the four stores with the right key paths when upgrade runs on a new database', async () => {
      const name = trackedName();
      const seenVersions: number[] = [];
      const db = await openDB<HyperGeistDB>(name, DB_VERSION, {
        upgrade(database, oldVersion) {
          seenVersions.push(oldVersion);
          upgrade(database, oldVersion);
        },
      });
      db.close();

      expect(seenVersions).toEqual([0]);
      const described = await describeStores(name);
      expect(described.version).toBe(DB_VERSION);
      expect(described.storeNames).toEqual(['meta', 'quarantine', 'stacks', 'trash']);
      expect(described.stores).toEqual(expectedStores);
    });

    it('creates the same stores when the database is opened through openIdbRepository', async () => {
      const name = trackedName();
      const repository = await open(name);
      expect(valueOf(await repository.list(1))).toEqual({ stacks: [], problems: [] });

      const described = await describeStores(name);
      expect(described.version).toBe(DB_VERSION);
      expect(described.stores).toEqual(expectedStores);
    });

    it('creates nothing when the old version is already current', async () => {
      const name = trackedName();
      const first = await openDB<HyperGeistDB>(name, DB_VERSION, { upgrade });
      first.close();

      // A later release would raise the version. The version 1 step must not run again.
      const second = await openDB<HyperGeistDB>(name, DB_VERSION + 1, {
        upgrade(database, oldVersion) {
          expect(oldVersion).toBe(DB_VERSION);
          upgrade(database, oldVersion);
        },
      });
      second.close();
      expect((await describeStores(name)).stores).toEqual(expectedStores);
    });

    it('uses the default database name when none is given', async () => {
      expect(DEFAULT_DB_NAME).toBe('hypergeist');
      names.push(DEFAULT_DB_NAME);
      const repository = await openIdbRepository();
      repositories.push(repository);
      valueOf(await repository.save(makeStack('a'), 1));

      const raw = await openDB(DEFAULT_DB_NAME);
      try {
        expect(Array.from(raw.objectStoreNames)).toContain('stacks');
      } finally {
        raw.close();
      }
    });
  });

  describe('quota errors', () => {
    it('maps a QuotaExceededError on save to QUOTA_EXCEEDED and keeps the earlier record', async () => {
      const repository = await open();
      const original = makeStack('a', 'Original');
      valueOf(await repository.save(original, 10));

      repository.testing.failNextWrite({ afterPuts: 0, kind: 'quota' });
      const failed = await repository.save(makeStack('a', 'Changed'), 20);
      expect(errorOf(failed)).toEqual({
        code: 'QUOTA_EXCEEDED',
        message: "The browser's storage is full.",
      });

      expect(valueOf(await repository.load('a'))).toEqual(original);
      expect(valueOf(await repository.list(30)).stacks).toEqual([
        { id: 'a', name: 'Original', savedAt: 10, origin: 'user' },
      ]);

      // The failure fires once. The next save works.
      expect(valueOf(await repository.save(makeStack('a', 'Changed'), 40)).savedAt).toBe(40);
    });

    it('maps a QuotaExceededError on create to QUOTA_EXCEEDED and stores nothing', async () => {
      const repository = await open();
      repository.testing.failNextWrite({ afterPuts: 0, kind: 'quota' });
      expect(errorOf(await repository.create(makeStack('a'), 10)).code).toBe('QUOTA_EXCEEDED');
      expect(valueOf(await repository.list(20)).stacks).toEqual([]);
    });

    it('maps a clone failure (a different storage error) to STORAGE_FAILED', async () => {
      const repository = await open();
      repository.testing.failNextWrite({ afterPuts: 0, kind: 'clone' });
      const failed = await repository.save(makeStack('a'), 10);
      expect(errorOf(failed).code).toBe('STORAGE_FAILED');
      expect(errorOf(failed).message).not.toMatch(/clone|DataCloneError/i);
      expect(valueOf(await repository.list(20)).stacks).toEqual([]);
    });
  });

  describe('two repositories on one database', () => {
    it('each sees the other committed writes', async () => {
      const name = uniqueName();
      const first = await open(name);
      const second = await open(name);

      valueOf(await first.save(makeStack('a', 'From first'), 10));
      expect(valueOf(await second.load('a')).name).toBe('From first');

      valueOf(await second.save(makeStack('b', 'From second'), 20));
      expect(valueOf(await first.list(30)).stacks.map((item) => item.id)).toEqual(['b', 'a']);

      valueOf(await second.moveToTrash('a', 40));
      expect(valueOf(await first.listTrash()).map((item) => item.id)).toEqual(['a']);
      expect(valueOf(await first.list(50)).stacks.map((item) => item.id)).toEqual(['b']);

      valueOf(await first.setMeta('lastOpenedId', 'b'));
      expect(valueOf(await second.getMeta('lastOpenedId'))).toBe('b');
    });

    it('seeds only once across two repositories', async () => {
      const name = uniqueName();
      const first = await open(name);
      const second = await open(name);
      expect(valueOf(await first.seedIfNeeded(seedsOf('seed-a'), 10))).toEqual({ seeded: true });
      expect(valueOf(await second.seedIfNeeded(seedsOf('seed-a'), 20))).toEqual({ seeded: false });
    });
  });

  describe('persistence across close and reopen', () => {
    it('keeps stacks, trash and meta when the same name is opened again', async () => {
      const name = uniqueName();
      const first = await open(name);
      const kept = makeStack('kept', 'Kept');
      valueOf(await first.seedIfNeeded(seedsOf('seed-a'), 5));
      valueOf(await first.save(kept, 10));
      valueOf(await first.save(makeStack('gone', 'Gone'), 11));
      valueOf(await first.moveToTrash('gone', 12));
      valueOf(await first.setMeta('lastOpenedId', 'kept'));
      expect(valueOf(await first.close())).toBeUndefined();

      const second = await open(name);
      expect(valueOf(await second.load('kept'))).toEqual(kept);
      expect(valueOf(await second.list(20)).stacks.map((item) => item.id)).toEqual([
        'kept',
        'seed-a',
      ]);
      expect(valueOf(await second.listTrash()).map((item) => item.id)).toEqual(['gone']);
      expect(valueOf(await second.getMeta('lastOpenedId'))).toBe('kept');
      expect(valueOf(await second.getMeta('seeded'))).toBe(true);
      // The seeding marker survived the restart, so seeding does not run again.
      expect(valueOf(await second.seedIfNeeded(seedsOf('other'), 30))).toEqual({ seeded: false });
    });

    it('does not bring back stacks of a deleted database', async () => {
      const name = uniqueName();
      const first = await open(name);
      valueOf(await first.save(makeStack('a'), 10));
      await first.close();
      await deleteDatabase(name);

      const second = await open(name);
      expect(valueOf(await second.list(20)).stacks).toEqual([]);
    });
  });

  describe('a failed multi-record restoreDemo', () => {
    it('leaves stacks, trash, the seeded marker and the quarantine unchanged', async () => {
      const repository = await open();
      const seeds = seedsOf('seed-a', 'seed-b', 'seed-c');
      valueOf(await repository.seedIfNeeded(seeds, 100));
      valueOf(await repository.save(makeStack('seed-a', 'Edited a'), 150));
      valueOf(await repository.save(makeStack('seed-b', 'Edited b'), 160));
      valueOf(await repository.save(makeStack('mine', 'Mine'), 170));
      valueOf(await repository.save(makeStack('old', 'Old'), 171));
      valueOf(await repository.moveToTrash('old', 180));

      const stacksBefore = valueOf(await repository.list(190)).stacks;
      const trashBefore = valueOf(await repository.listTrash());
      const quarantineBefore = await repository.testing.quarantine();

      // Writes of restoreDemo in order: trash a, put a, trash b, put b ... The fourth fails.
      repository.testing.failNextWrite({ afterPuts: 3, kind: 'clone' });
      const failed = await repository.restoreDemo(seeds, 200);
      expect(errorOf(failed).code).toBe('STORAGE_FAILED');

      expect(valueOf(await repository.list(210)).stacks).toEqual(stacksBefore);
      expect(valueOf(await repository.listTrash())).toEqual(trashBefore);
      expect(await repository.testing.quarantine()).toEqual(quarantineBefore);
      expect(valueOf(await repository.getMeta('seeded'))).toBe(true);
      expect(valueOf(await repository.load('seed-a')).name).toBe('Edited a');
      expect(valueOf(await repository.load('seed-b')).name).toBe('Edited b');

      // The failure fired once. A retry replaces the three seeds and trashes their three copies.
      const retried = valueOf(await repository.restoreDemo(seeds, 300));
      expect(retried.replacedIds).toEqual(['seed-a', 'seed-b', 'seed-c']);
      expect(valueOf(await repository.load('seed-a')).name).toBe('Original seed-a');
      expect(valueOf(await repository.listTrash())).toHaveLength(trashBefore.length + 3);
    });

    it('also rolls back when the failure is the very first write', async () => {
      const repository = await open();
      const seeds = seedsOf('seed-a');
      valueOf(await repository.seedIfNeeded(seeds, 100));
      valueOf(await repository.save(makeStack('seed-a', 'Edited'), 150));

      repository.testing.failNextWrite({ afterPuts: 0, kind: 'quota' });
      expect(errorOf(await repository.restoreDemo(seeds, 200)).code).toBe('QUOTA_EXCEEDED');

      expect(valueOf(await repository.load('seed-a')).name).toBe('Edited');
      expect(valueOf(await repository.listTrash())).toEqual([]);
    });
  });

  describe('another connection asks for a higher version', () => {
    it('closes this connection, calls onBlocking and answers later calls with STORAGE_FAILED', async () => {
      const name = uniqueName();
      const onBlocking = vi.fn();
      const repository = await open(name, { onBlocking });
      valueOf(await repository.save(makeStack('a'), 10));

      const upgraded = await openDB(name, DB_VERSION + 1);
      try {
        expect(onBlocking).toHaveBeenCalledTimes(1);

        const failed = await repository.list(20);
        expect(errorOf(failed).code).toBe('STORAGE_FAILED');
        expect(errorOf(failed).message).toMatch(/Reload the page/);
        expect(errorOf(await repository.save(makeStack('b'), 30)).code).toBe('STORAGE_FAILED');
        expect(errorOf(await repository.load('a')).code).toBe('STORAGE_FAILED');
        expect(errorOf(await repository.listTrash()).code).toBe('STORAGE_FAILED');
      } finally {
        upgraded.close();
      }
    });

    it('works without an onBlocking callback', async () => {
      const name = uniqueName();
      const repository = await open(name);
      const upgraded = await openDB(name, DB_VERSION + 1);
      try {
        expect(errorOf(await repository.list(20)).message).toMatch(/Reload the page/);
      } finally {
        upgraded.close();
      }
    });
  });

  describe('close', () => {
    it('is idempotent', async () => {
      const repository = await open();
      valueOf(await repository.save(makeStack('a'), 10));
      expect(valueOf(await repository.close())).toBeUndefined();
      expect(valueOf(await repository.close())).toBeUndefined();
      expect(valueOf(await repository.close())).toBeUndefined();
    });

    it('makes later calls return STORAGE_FAILED instead of throwing', async () => {
      const repository = await open();
      await repository.close();
      expect(errorOf(await repository.list(1)).code).toBe('STORAGE_FAILED');
      expect(errorOf(await repository.save(makeStack('a'), 1)).code).toBe('STORAGE_FAILED');
      expect(errorOf(await repository.getMeta('seeded')).code).toBe('STORAGE_FAILED');
    });

    it('does not stop a second repository on the same database', async () => {
      const name = uniqueName();
      const first = await open(name);
      const second = await open(name);
      valueOf(await first.save(makeStack('a'), 10));
      await first.close();
      expect(valueOf(await second.load('a')).id).toBe('a');
    });
  });

  describe('opening can fail', () => {
    it('falls back to the global indexedDB when the indexedDB option is undefined', async () => {
      // `undefined` is the same as not passing the option. With fake-indexeddb loaded, the
      // global exists, so this opens normally.
      const repository = await open(uniqueName(), { indexedDB: undefined });
      expect(valueOf(await repository.list(1)).stacks).toEqual([]);
    });

    it('rejects with an Error when there is no indexedDB option and no global', async () => {
      vi.stubGlobal('indexedDB', undefined);
      await expect(openIdbRepository({ name: uniqueName() })).rejects.toThrow(
        'IndexedDB is not available in this browser.',
      );
    });

    it('rejects when the indexedDB option is not a factory', async () => {
      const notAFactory = {} as unknown as IDBFactory;
      await expect(
        openIdbRepository({ name: uniqueName(), indexedDB: notAFactory }),
      ).rejects.toThrow(TypeError);
    });

    it('rejects when the stored database has a newer version than this code knows', async () => {
      const name = trackedName();
      const newer = await openDB(name, DB_VERSION + 1);
      newer.close();
      await expect(openIdbRepository({ name })).rejects.toMatchObject({ name: 'VersionError' });
    });
  });
});
