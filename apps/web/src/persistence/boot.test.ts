import 'fake-indexeddb/auto';

import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import demoText from '../stacks/thin-slice-todo.json?raw';

import {
  DEFAULT_NEW_STACK_ID,
  LAST_OPENED_KEY,
  STORAGE_FAILED_REASON,
  bootPersistence,
} from './boot.ts';
import type { BootResult } from './boot.ts';
import { createMemoryRepository } from './memory-repository.ts';
import type { MemoryRepository } from './memory-repository.ts';
import { openRepository } from './open-repository.ts';
import type { OpenedRepository } from './open-repository.ts';
import { loadSeedSet } from './seed-set.ts';
import type { SeedSet } from './seed-set.ts';
import type { Repository, Result } from './types.ts';

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

function seedSetOf(...ids: string[]): SeedSet {
  return { stacks: ids.map((id) => ({ stack: makeStack(id) })), problems: [] };
}

function memoryOpener(repository: Repository = createMemoryRepository()) {
  return (): Promise<OpenedRepository> => Promise.resolve({ repository, mode: 'indexeddb' });
}

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`Expected ok, got ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

let nextDatabase = 0;

function uniqueName(): string {
  nextDatabase += 1;
  return `boot-test-${nextDatabase}`;
}

function idsOf(result: BootResult): string[] {
  return result.summaries.map((summary) => summary.id);
}

describe('bootPersistence', () => {
  it('first run seeds every stack and opens the first seed', async () => {
    const result = await bootPersistence({
      now: 100,
      openRepository: memoryOpener(),
      seedSet: seedSetOf('alpha', 'beta'),
    });

    expect(result.mode).toBe('indexeddb');
    expect(result.reason).toBeUndefined();
    expect(idsOf(result).sort()).toEqual(['alpha', 'beta']);
    expect(result.problems).toEqual([]);
    expect(result.seedProblems).toEqual([]);
    // Seeds share one savedAt, so the list order decides: the opened stack is the first listed.
    expect(result.initial.id).toBe(result.summaries[0]?.id);
    expect(result.initial).toEqual(makeStack(result.initial.id));
  });

  it('second run on the same repository does not seed again and reopens lastOpenedId', async () => {
    const repository = createMemoryRepository();
    const seedSet = seedSetOf('alpha', 'beta');
    await bootPersistence({ now: 100, openRepository: memoryOpener(repository), seedSet });
    valueOf(await repository.setMeta(LAST_OPENED_KEY, 'beta'));
    // A change made between runs: a seeding that ran again would bring "alpha" back.
    const alpha = valueOf(await repository.list(150)).stacks.find((s) => s.id === 'alpha');
    expect(alpha).toBeDefined();
    const movedToTrash = await repository.moveToTrash('alpha', 150);
    expect(movedToTrash.ok).toBe(true);

    const second = await bootPersistence({
      now: 200,
      openRepository: memoryOpener(repository),
      seedSet,
    });

    expect(idsOf(second)).toEqual(['beta']);
    expect(second.initial.id).toBe('beta');
  });

  it('opens the stack saved most recently when lastOpenedId is not set', async () => {
    const repository = createMemoryRepository();
    valueOf(await repository.save(makeStack('old'), 10));
    valueOf(await repository.save(makeStack('new'), 20));

    const result = await bootPersistence({
      now: 100,
      openRepository: memoryOpener(repository),
      seedSet: seedSetOf('seed'),
    });

    // The database already holds stacks, so nothing is seeded.
    expect(idsOf(result)).toEqual(['new', 'old']);
    expect(result.initial.id).toBe('new');
  });

  it('opens the stack named by lastOpenedId even when it is not the newest', async () => {
    const repository = createMemoryRepository();
    valueOf(await repository.save(makeStack('old'), 10));
    valueOf(await repository.save(makeStack('new'), 20));
    valueOf(await repository.setMeta(LAST_OPENED_KEY, 'old'));

    const result = await bootPersistence({
      now: 100,
      openRepository: memoryOpener(repository),
      seedSet: seedSetOf(),
    });

    expect(result.initial.id).toBe('old');
  });

  it('falls back to the first listed stack when lastOpenedId points at a deleted id', async () => {
    const repository = createMemoryRepository();
    valueOf(await repository.save(makeStack('old'), 10));
    valueOf(await repository.save(makeStack('new'), 20));
    valueOf(await repository.setMeta(LAST_OPENED_KEY, 'gone'));

    const result = await bootPersistence({
      now: 100,
      openRepository: memoryOpener(repository),
      seedSet: seedSetOf(),
    });

    expect(result.initial.id).toBe('new');
  });

  it('ignores a lastOpenedId that is not a string', async () => {
    const repository = createMemoryRepository();
    valueOf(await repository.save(makeStack('only'), 10));
    valueOf(await repository.setMeta(LAST_OPENED_KEY, true));

    const result = await bootPersistence({
      now: 100,
      openRepository: memoryOpener(repository),
      seedSet: seedSetOf(),
    });

    expect(result.initial.id).toBe('only');
  });

  it('memory mode seeds the memory repository and passes the reason on', async () => {
    const result = await bootPersistence({
      now: 100,
      openRepository: () =>
        Promise.resolve({
          repository: createMemoryRepository(),
          mode: 'memory',
          reason: 'Private window.',
        }),
      seedSet: seedSetOf('alpha', 'beta'),
    });

    expect(result.mode).toBe('memory');
    expect(result.reason).toBe('Private window.');
    expect(idsOf(result).sort()).toEqual(['alpha', 'beta']);
    // The repository is usable and holds what boot reported.
    expect(valueOf(await result.repository.load(result.initial.id))).toEqual(result.initial);
    valueOf(await result.repository.save({ ...result.initial, name: 'Renamed' }, 300));
    expect(valueOf(await result.repository.load(result.initial.id)).name).toBe('Renamed');
  });

  it('memory mode from the real openRepository when IndexedDB is unavailable', async () => {
    const result = await bootPersistence({
      now: 100,
      openRepository: () => openRepository({ indexedDB: null }),
      seedSet: seedSetOf('alpha'),
    });

    expect(result.mode).toBe('memory');
    expect(result.reason).toEqual(expect.any(String));
    expect(result.initial.id).toBe('alpha');
  });

  it('a quarantined record still gives a usable app and is reported in problems', async () => {
    const repository: MemoryRepository = createMemoryRepository();
    repository.testing.putRawStack({
      stack: { ...makeStack('broken'), cards: 'not a list' },
      savedAt: 50,
      origin: 'user',
    });
    valueOf(await repository.save(makeStack('fine'), 10));

    const result = await bootPersistence({
      now: 100,
      openRepository: memoryOpener(repository),
      seedSet: seedSetOf('seed'),
    });

    expect(idsOf(result)).toEqual(['fine']);
    expect(result.initial.id).toBe('fine');
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.recordKey).toBe('broken');
    expect(result.problems[0]?.errors.length).toBeGreaterThan(0);
  });

  it('creates a fresh stack when every record was quarantined', async () => {
    const repository: MemoryRepository = createMemoryRepository();
    repository.testing.putRawStack({
      stack: { ...makeStack('broken'), cards: 'not a list' },
      savedAt: 50,
      origin: 'user',
    });

    const result = await bootPersistence({
      now: 100,
      openRepository: memoryOpener(repository),
      seedSet: seedSetOf('seed'),
    });

    expect(result.problems).toHaveLength(1);
    expect(result.initial.id).toBe(DEFAULT_NEW_STACK_ID);
    expect(idsOf(result)).toEqual([DEFAULT_NEW_STACK_ID]);
    expect(valueOf(await repository.load(DEFAULT_NEW_STACK_ID))).toEqual(result.initial);
  });

  it('skips a stack that fails to load and refreshes the lists', async () => {
    const repository: MemoryRepository = createMemoryRepository();
    valueOf(await repository.save(makeStack('first'), 20));
    valueOf(await repository.save(makeStack('second'), 10));
    const wrapped: Repository = {
      ...repository,
      load: async (id) =>
        id === 'first'
          ? {
              ok: false,
              errors: [{ code: 'INVALID_STACK', message: 'The stack is not valid.' }],
            }
          : repository.load(id),
    };

    const result = await bootPersistence({
      now: 100,
      openRepository: memoryOpener(wrapped),
      seedSet: seedSetOf(),
    });

    expect(result.initial.id).toBe('second');
    expect(result.mode).toBe('indexeddb');
  });

  it('after everything was deleted it creates a fresh stack and does not seed again', async () => {
    const repository = createMemoryRepository();
    const seedSet = seedSetOf('alpha', 'beta');
    await bootPersistence({ now: 100, openRepository: memoryOpener(repository), seedSet });
    for (const id of ['alpha', 'beta']) {
      valueOf(await repository.moveToTrash(id, 150));
    }

    const result = await bootPersistence({
      now: 200,
      openRepository: memoryOpener(repository),
      seedSet,
      newStackId: 'start-here',
    });

    expect(result.initial.id).toBe('start-here');
    expect(result.initial.name).toBe('My stack');
    expect(idsOf(result)).toEqual(['start-here']);
    expect(valueOf(await repository.load('start-here'))).toEqual(result.initial);
  });

  it('uses my-stack when no newStackId is given', async () => {
    const result = await bootPersistence({
      now: 100,
      openRepository: memoryOpener(),
      seedSet: seedSetOf(),
    });

    expect(result.initial.id).toBe('my-stack');
    expect(idsOf(result)).toEqual(['my-stack']);
  });

  it('reports seed problems and still seeds the valid stacks', async () => {
    const good = JSON.stringify(makeStack('good'));
    const seedSet = loadSeedSet({ 'a-bad.json': '{ not json', 'b-good.json': good });
    expect(seedSet.problems).toHaveLength(1);

    const result = await bootPersistence({
      now: 100,
      openRepository: memoryOpener(),
      seedSet,
    });

    expect(result.seedProblems).toEqual(seedSet.problems);
    expect(result.seedProblems[0]?.file).toBe('a-bad.json');
    expect(idsOf(result)).toEqual(['good']);
    expect(result.initial.id).toBe('good');
  });

  it('uses the bundled seed set by default', async () => {
    const result = await bootPersistence({ now: 100, openRepository: memoryOpener() });

    expect(result.seedProblems).toEqual([]);
    expect(idsOf(result)).toContain('thin-slice-todo');
  });

  describe('storage that fails after it opened', () => {
    const failed: Result<never> = {
      ok: false,
      errors: [{ code: 'STORAGE_FAILED', message: 'secret-internal-detail-4711' }],
    };

    it('falls back to memory mode when list fails', async () => {
      const broken: Repository = {
        ...createMemoryRepository(),
        list: () => Promise.resolve(failed),
      };

      const result = await bootPersistence({
        now: 100,
        openRepository: memoryOpener(broken),
        seedSet: seedSetOf('alpha'),
      });

      expect(result.mode).toBe('memory');
      expect(result.reason).toBe(STORAGE_FAILED_REASON);
      expect(result.reason).not.toContain('secret-internal-detail-4711');
      expect(result.repository).not.toBe(broken);
      expect(idsOf(result)).toEqual(['alpha']);
      expect(result.initial.id).toBe('alpha');
      expect(valueOf(await result.repository.load('alpha'))).toEqual(result.initial);
    });

    it('falls back to memory mode when seeding fails', async () => {
      const broken: Repository = {
        ...createMemoryRepository(),
        seedIfNeeded: () => Promise.resolve(failed),
      };

      const result = await bootPersistence({
        now: 100,
        openRepository: memoryOpener(broken),
        seedSet: seedSetOf('alpha'),
      });

      expect(result.mode).toBe('memory');
      expect(result.reason).toBe(STORAGE_FAILED_REASON);
      expect(result.initial.id).toBe('alpha');
    });

    it('falls back to memory mode when the fresh stack cannot be stored', async () => {
      const broken: Repository = {
        ...createMemoryRepository(),
        create: () => Promise.resolve(failed),
      };

      const result = await bootPersistence({
        now: 100,
        openRepository: memoryOpener(broken),
        seedSet: seedSetOf(),
      });

      expect(result.mode).toBe('memory');
      expect(result.initial.id).toBe('my-stack');
      expect(valueOf(await result.repository.load('my-stack'))).toEqual(result.initial);
    });

    it('keeps the reason of the open when it was already memory mode', async () => {
      const broken: Repository = {
        ...createMemoryRepository(),
        list: () => Promise.resolve(failed),
      };

      const result = await bootPersistence({
        now: 100,
        openRepository: () =>
          Promise.resolve({ repository: broken, mode: 'memory', reason: 'Private window.' }),
        seedSet: seedSetOf('alpha'),
      });

      expect(result.mode).toBe('memory');
      expect(result.reason).toBe('Private window.');
    });

    it('does not throw when the repository throws or the open rejects', async () => {
      const throwing: Repository = {
        ...createMemoryRepository(),
        list: () => {
          throw new Error('secret-internal-detail-4711');
        },
      };
      const fromThrow = await bootPersistence({
        now: 100,
        openRepository: memoryOpener(throwing),
        seedSet: seedSetOf('alpha'),
      });
      expect(fromThrow.mode).toBe('memory');
      expect(fromThrow.initial.id).toBe('alpha');

      const fromReject = await bootPersistence({
        now: 100,
        openRepository: () => Promise.reject(new Error('secret-internal-detail-4711')),
        seedSet: seedSetOf('alpha'),
      });
      expect(fromReject.mode).toBe('memory');
      expect(fromReject.reason).not.toContain('secret-internal-detail-4711');
      expect(fromReject.initial.id).toBe('alpha');
    });
  });

  describe('with fake-indexeddb', () => {
    it('seeds on the first run and reopens lastOpenedId on the second', async () => {
      const factory = new IDBFactory();
      const name = uniqueName();
      const seedSet = seedSetOf('alpha', 'beta');
      const open = () => openRepository({ indexedDB: factory, name });

      const first = await bootPersistence({ now: 100, openRepository: open, seedSet });
      expect(first.mode).toBe('indexeddb');
      expect(first.reason).toBeUndefined();
      expect(idsOf(first).sort()).toEqual(['alpha', 'beta']);
      valueOf(await first.repository.setMeta(LAST_OPENED_KEY, 'beta'));
      const trashed = await first.repository.moveToTrash('alpha', 150);
      expect(trashed.ok).toBe(true);
      valueOf(await first.repository.close());

      const second = await bootPersistence({ now: 200, openRepository: open, seedSet });
      expect(second.mode).toBe('indexeddb');
      expect(idsOf(second)).toEqual(['beta']);
      expect(second.initial.id).toBe('beta');
      valueOf(await second.repository.close());
    });
  });
});
