import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { describe, expect, it } from 'vitest';
import demoText from '../stacks/thin-slice-todo.json?raw';

import { createMemoryRepository } from './memory-repository.ts';
import type { MemoryRepositoryOptions } from './memory-repository.ts';
import { runRepositoryContract } from './repository.contract.ts';
import type { ContractHarness } from './repository.contract.ts';
import type { Result, SeedStack } from './types.ts';

/** Fails the second write of its first batch, once. Later writes succeed. */
function failSecondPutOnce(): (id: string) => boolean {
  let count = 0;
  let spent = false;
  return () => {
    if (spent) {
      return false;
    }
    count += 1;
    if (count === 2) {
      spent = true;
      return true;
    }
    return false;
  };
}

function memoryHarness(options: MemoryRepositoryOptions = {}): ContractHarness {
  const repository = createMemoryRepository(options);
  return {
    repository,
    putRawStack: (record) => {
      repository.testing.putRawStack(record);
    },
    quarantined: () => repository.testing.quarantine().map((entry) => entry.record),
    seedFailureSetup: () => memoryHarness({ failOnPut: failSecondPutOnce() }),
    close: async () => {
      await repository.close();
    },
  };
}

runRepositoryContract('memory repository', () => memoryHarness());

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

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`Expected ok, got ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function codeOf<T>(result: Result<T>): string | undefined {
  return result.ok ? undefined : result.errors[0]?.code;
}

function seedsOf(...ids: string[]): SeedStack[] {
  return ids.map((id) => ({ stack: makeStack(id, `Original ${id}`) }));
}

describe('memory repository: trashCap option', () => {
  it('keeps at most the given number of trash records and reports the dropped one', async () => {
    const repo = createMemoryRepository({ trashCap: 2 });
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      valueOf(await repo.save(makeStack(id), index + 1));
    }
    expect(valueOf(await repo.moveToTrash('a', 10))).toEqual([]);
    expect(valueOf(await repo.moveToTrash('b', 20))).toEqual([]);
    const dropped = valueOf(await repo.moveToTrash('c', 30));
    expect(dropped.map((item) => item.id)).toEqual(['a']);
    expect(valueOf(await repo.listTrash()).map((item) => item.id)).toEqual(['c', 'b']);
  });

  it('applies the cap to restoreDemo and reports what it dropped', async () => {
    const repo = createMemoryRepository({ trashCap: 1 });
    const seeds = seedsOf('seed-a', 'seed-b');
    valueOf(await repo.seedIfNeeded(seeds, 100));
    const outcome = valueOf(await repo.restoreDemo(seeds, 200));
    expect(outcome.replacedIds).toHaveLength(2);
    expect(outcome.dropped).toHaveLength(1);
    expect(valueOf(await repo.listTrash())).toHaveLength(1);
  });

  it('defaults to 50', async () => {
    const repo = createMemoryRepository();
    for (let index = 0; index < 51; index += 1) {
      valueOf(await repo.save(makeStack(`s-${index}`), index));
      valueOf(await repo.moveToTrash(`s-${index}`, 100 + index));
    }
    expect(valueOf(await repo.listTrash())).toHaveLength(50);
  });
});

describe('memory repository: failOnPut option', () => {
  it('turns a refused write into STORAGE_FAILED and keeps the earlier record', async () => {
    const original = makeStack('a', 'Original');
    const repo = createMemoryRepository({ failOnPut: (id) => id === 'a' });
    const result = await repo.save(original, 10);
    expect(codeOf(result)).toBe('STORAGE_FAILED');

    const kept = createMemoryRepository({
      initial: { stacks: [{ stack: original, savedAt: 5, origin: 'user' }] },
      failOnPut: (id) => id === 'a',
    });
    expect(codeOf(await kept.save(makeStack('a', 'Changed'), 10))).toBe('STORAGE_FAILED');
    expect(valueOf(await kept.load('a'))).toEqual(original);
    expect(valueOf(await kept.list(20)).stacks[0]?.savedAt).toBe(5);
  });

  it('fails create the same way and stores nothing', async () => {
    const repo = createMemoryRepository({ failOnPut: () => true });
    expect(codeOf(await repo.create(makeStack('a'), 10))).toBe('STORAGE_FAILED');
    expect(valueOf(await repo.list(20)).stacks).toEqual([]);
  });

  it('does not quarantine the old record when the write over it is refused', async () => {
    const repo = createMemoryRepository({ failOnPut: () => true });
    const corrupt = { stack: { ...makeStack('a'), cards: 'broken' }, savedAt: 1, origin: 'user' };
    repo.testing.putRawStack(corrupt);
    expect(codeOf(await repo.save(makeStack('a'), 10))).toBe('STORAGE_FAILED');
    expect(repo.testing.quarantine()).toEqual([]);
    expect(repo.testing.rawStack('a')).toEqual(corrupt);
  });

  it('rolls back restoreDemo completely when one write fails', async () => {
    const seeds = seedsOf('seed-a', 'seed-b');
    let armed = false;
    const repo = createMemoryRepository({ failOnPut: (id) => armed && id === 'seed-b' });
    valueOf(await repo.seedIfNeeded(seeds, 100));
    valueOf(await repo.save(makeStack('seed-a', 'Edited'), 150));

    armed = true;
    expect(codeOf(await repo.restoreDemo(seeds, 200))).toBe('STORAGE_FAILED');

    expect(valueOf(await repo.load('seed-a')).name).toBe('Edited');
    expect(valueOf(await repo.listTrash())).toEqual([]);
  });

  it('keeps the trash record when restoreFromTrash fails to write', async () => {
    let armed = false;
    const repo = createMemoryRepository({ failOnPut: () => armed });
    valueOf(await repo.save(makeStack('a'), 10));
    valueOf(await repo.moveToTrash('a', 20));
    armed = true;
    const key = valueOf(await repo.listTrash())[0]?.key ?? -1;
    expect(codeOf(await repo.restoreFromTrash(key, 30))).toBe('STORAGE_FAILED');
    expect(valueOf(await repo.listTrash())).toHaveLength(1);
    expect(valueOf(await repo.list(40)).stacks).toEqual([]);
  });
});

describe('memory repository: quarantine and options', () => {
  it('stamps a quarantined record with the time the caller gave to list', async () => {
    const repo = createMemoryRepository();
    const corrupt = { stack: { ...makeStack('bad'), cards: 'broken' }, savedAt: 1, origin: 'user' };
    repo.testing.putRawStack(corrupt);
    valueOf(await repo.list(777));
    const entries = repo.testing.quarantine();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.quarantinedAt).toBe(777);
    expect(entries[0]?.record).toEqual(corrupt);
    expect(entries[0]?.errors.length ?? 0).toBeGreaterThan(0);
  });

  it('stamps the old record with the time the caller gave to save', async () => {
    const repo = createMemoryRepository();
    const corrupt = { stack: { ...makeStack('a'), cards: 'broken' }, savedAt: 1, origin: 'user' };
    repo.testing.putRawStack(corrupt);
    valueOf(await repo.save(makeStack('a', 'Fresh'), 888));
    const entries = repo.testing.quarantine();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.quarantinedAt).toBe(888);
    expect(entries[0]?.record).toEqual(corrupt);
  });

  it('keeps the origin of an unreadable record that is saved over', async () => {
    const repo = createMemoryRepository();
    repo.testing.putRawStack({
      stack: { ...makeStack('a'), cards: 'broken' },
      savedAt: 1,
      origin: 'seed',
    });
    const saved = valueOf(await repo.save(makeStack('a'), 10));
    expect(saved.origin).toBe('seed');
  });

  it('starts with the records given in initial', async () => {
    const repo = createMemoryRepository({
      initial: {
        stacks: [{ stack: makeStack('a', 'A'), savedAt: 5, origin: 'seed' }],
        trash: [{ stack: makeStack('t', 'T'), savedAt: 1, origin: 'user', deletedAt: 9 }],
        meta: { seeded: true },
      },
    });
    expect(valueOf(await repo.list(10)).stacks).toEqual([
      { id: 'a', name: 'A', savedAt: 5, origin: 'seed' },
    ]);
    expect(valueOf(await repo.listTrash()).map((item) => item.id)).toEqual(['t']);
    expect(valueOf(await repo.getMeta('seeded'))).toBe(true);
    expect(valueOf(await repo.seedIfNeeded(seedsOf('x'), 20))).toEqual({ seeded: false });
  });

  it('does not let the caller change the initial records afterwards', async () => {
    const stack = makeStack('a', 'A') as { name: string } & Stack;
    const repo = createMemoryRepository({
      initial: { stacks: [{ stack, savedAt: 5, origin: 'user' }] },
    });
    stack.name = 'Changed';
    expect(valueOf(await repo.load('a')).name).toBe('A');
  });
});
