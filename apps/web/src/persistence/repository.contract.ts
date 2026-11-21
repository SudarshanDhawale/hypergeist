import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import demoText from '../stacks/thin-slice-todo.json?raw';

import type { PersistenceError, Repository, Result, SeedStack } from './types.ts';

/**
 * What the contract needs from an implementation under test. One harness is one empty,
 * independent store: the contract calls `setup()` before every example and `close()` after it.
 */
export type ContractHarness = {
  /** The repository under test. */
  readonly repository: Repository;
  /**
   * Puts `record` into the `stacks` store exactly as given, with no validation. It is keyed by
   * `record.stack.id`. The IndexedDB harness writes straight into the object store.
   */
  putRawStack(record: unknown): Promise<void> | void;
  /**
   * The quarantined records, oldest first, each exactly as it was stored in `stacks`. The
   * wrapper the store adds (errors, `quarantinedAt`) is left out.
   */
  quarantined(): Promise<readonly unknown[]> | readonly unknown[];
  /**
   * Optional. Returns a NEW, empty harness (its own store, not this one) whose next seed write
   * of several records fails part way, exactly once: with three seeds, the first is written,
   * the second fails, and every later write works. The contract closes both harnesses.
   * When this is missing, the "seeding fails part way" example is skipped.
   */
  seedFailureSetup?: () => Promise<ContractHarness> | ContractHarness;
  /** Releases the store. Called once per harness. */
  close(): Promise<void> | void;
};

export type MakeHarness = () => Promise<ContractHarness> | ContractHarness;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const baseStack: Stack = (() => {
  const parsed = parseStack(demoText);
  if (!parsed.ok) {
    throw new Error('The bundled demo stack used by the contract tests is not valid.');
  }
  return parsed.value;
})();

/** A valid stack with the given `id` and `name`. Every call returns a fresh copy. */
function makeStack(id: string, name: string = `Stack ${id}`): Stack {
  return { ...structuredClone(baseStack), id, name };
}

/** A stack that parses as JSON but fails validation (the start card does not exist). */
function makeInvalidStack(id: string): Stack {
  return { ...makeStack(id), startCardId: 'no-such-card' };
}

/** A stored record that fails `parseStack` (its `cards` is not a list). */
function makeCorruptRecord(id: string, origin: 'seed' | 'user' = 'user'): unknown {
  return { stack: { ...makeStack(id), cards: 'not a list' }, savedAt: 5, origin };
}

function seedsOf(...ids: string[]): SeedStack[] {
  return ids.map((id) => ({ stack: makeStack(id, `Original ${id}`) }));
}

/** Unwraps a result that the example expects to be ok. */
function valueOf<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`Expected ok, got ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/** Unwraps the first error of a result that the example expects to fail. */
function errorOf<T>(result: Result<T>): PersistenceError {
  if (result.ok) {
    throw new Error('Expected a failure, got ok.');
  }
  const first = result.errors[0];
  if (first === undefined) {
    throw new Error('A failure must carry at least one error.');
  }
  return first;
}

async function listIds(repository: Repository, now = 0): Promise<string[]> {
  return valueOf(await repository.list(now)).stacks.map((stack) => stack.id);
}

async function trashIds(repository: Repository): Promise<string[]> {
  return valueOf(await repository.listTrash()).map((item) => item.id);
}

async function trashKeyOf(repository: Repository, id: string): Promise<number> {
  const found = valueOf(await repository.listTrash()).find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`"${id}" is not in the trash.`);
  }
  return found.key;
}

/**
 * Registers the example tests every `Repository` must pass. `setup` runs before each example
 * and must give a fresh, empty store each time.
 *
 * Ordering rule shared by all implementations: `list` returns the most recently saved stack
 * first, and breaks ties by `id` in ascending order.
 */
export function runRepositoryContract(name: string, setup: MakeHarness): void {
  describe(`${name}: repository contract`, () => {
    let harness: ContractHarness;
    let extra: ContractHarness[];
    let repo: Repository;

    beforeEach(async () => {
      harness = await setup();
      repo = harness.repository;
      extra = [];
    });

    afterEach(async () => {
      for (const other of extra) {
        await other.close();
      }
      await harness.close();
    });

    describe('save, load and list', () => {
      it('loads exactly what was saved', async () => {
        const stack = makeStack('alpha', 'Alpha');
        const saved = valueOf(await repo.save(stack, 10));
        expect(saved).toEqual({ id: 'alpha', name: 'Alpha', savedAt: 10, origin: 'user' });
        expect(valueOf(await repo.load('alpha'))).toEqual(stack);
      });

      it('lists summaries with id, name, savedAt and origin, newest first, ties by id', async () => {
        valueOf(await repo.save(makeStack('a', 'A'), 10));
        valueOf(await repo.save(makeStack('b', 'B'), 30));
        valueOf(await repo.save(makeStack('c', 'C'), 20));
        valueOf(await repo.save(makeStack('d', 'D'), 30));
        const listed = valueOf(await repo.list(99));
        expect(listed.problems).toEqual([]);
        expect(listed.stacks).toEqual([
          { id: 'b', name: 'B', savedAt: 30, origin: 'user' },
          { id: 'd', name: 'D', savedAt: 30, origin: 'user' },
          { id: 'c', name: 'C', savedAt: 20, origin: 'user' },
          { id: 'a', name: 'A', savedAt: 10, origin: 'user' },
        ]);
      });

      it('replaces a stack with the same id and keeps one record', async () => {
        valueOf(await repo.save(makeStack('a', 'First'), 10));
        valueOf(await repo.save(makeStack('a', 'Second'), 20));
        expect(valueOf(await repo.list(30)).stacks).toEqual([
          { id: 'a', name: 'Second', savedAt: 20, origin: 'user' },
        ]);
      });

      it('rejects an invalid stack with INVALID_STACK and leaves the earlier record intact', async () => {
        const original = makeStack('a', 'Original');
        valueOf(await repo.save(original, 10));

        const rejected = await repo.save({ ...makeInvalidStack('a'), name: 'Changed' }, 20);
        const error = errorOf(rejected);
        expect(error.code).toBe('INVALID_STACK');
        expect(error.validationErrors?.length ?? 0).toBeGreaterThan(0);

        expect(valueOf(await repo.load('a'))).toEqual(original);
        expect(valueOf(await repo.list(30)).stacks).toEqual([
          { id: 'a', name: 'Original', savedAt: 10, origin: 'user' },
        ]);
      });

      it('writes nothing when an invalid stack has a new id', async () => {
        expect(errorOf(await repo.save(makeInvalidStack('fresh'), 10)).code).toBe('INVALID_STACK');
        expect(errorOf(await repo.create(makeInvalidStack('fresh'), 10)).code).toBe(
          'INVALID_STACK',
        );
        expect(await listIds(repo)).toEqual([]);
      });

      it('gives NOT_FOUND when loading an id that is not stored', async () => {
        expect(errorOf(await repo.load('missing')).code).toBe('NOT_FOUND');
      });
    });

    describe('create', () => {
      it('adds a new stack with origin user', async () => {
        const saved = valueOf(await repo.create(makeStack('a', 'A'), 10));
        expect(saved).toEqual({ id: 'a', name: 'A', savedAt: 10, origin: 'user' });
        expect(valueOf(await repo.load('a'))).toEqual(makeStack('a', 'A'));
      });

      it('gives ID_IN_USE when the id exists and leaves the existing stack untouched', async () => {
        const existing = makeStack('a', 'Existing');
        valueOf(await repo.create(existing, 10));

        const error = errorOf(await repo.create(makeStack('a', 'Newcomer'), 20));
        expect(error.code).toBe('ID_IN_USE');

        expect(valueOf(await repo.load('a'))).toEqual(existing);
        expect(valueOf(await repo.list(30)).stacks).toEqual([
          { id: 'a', name: 'Existing', savedAt: 10, origin: 'user' },
        ]);
      });
    });

    describe('unreadable stored records', () => {
      it('omits an invalid record from list, reports it, and keeps it unchanged in the quarantine', async () => {
        const corrupt = makeCorruptRecord('bad');
        await harness.putRawStack(corrupt);
        valueOf(await repo.save(makeStack('good', 'Good'), 10));

        const listed = valueOf(await repo.list(50));
        expect(listed.stacks.map((stack) => stack.id)).toEqual(['good']);
        expect(listed.problems).toHaveLength(1);
        const problem = listed.problems[0];
        expect(problem?.recordKey).toBe('bad');
        expect(problem?.errors.length ?? 0).toBeGreaterThan(0);

        expect(await harness.quarantined()).toEqual([corrupt]);
        expect(errorOf(await repo.load('bad')).code).toBe('NOT_FOUND');
      });

      it('reports a problem once: the next list no longer shows it', async () => {
        await harness.putRawStack(makeCorruptRecord('bad'));
        expect(valueOf(await repo.list(50)).problems).toHaveLength(1);
        const second = valueOf(await repo.list(60));
        expect(second.problems).toEqual([]);
        expect(await harness.quarantined()).toHaveLength(1);
      });

      it('quarantines a record whose shape is wrong, not only a wrong stack', async () => {
        const shapeless = { stack: makeStack('odd'), savedAt: 'yesterday', origin: 'user' };
        await harness.putRawStack(shapeless);
        const listed = valueOf(await repo.list(50));
        expect(listed.stacks).toEqual([]);
        expect(listed.problems).toHaveLength(1);
        expect(await harness.quarantined()).toEqual([shapeless]);
      });

      it('gives INVALID_STACK when loading an invalid record', async () => {
        await harness.putRawStack(makeCorruptRecord('bad'));
        expect(errorOf(await repo.load('bad')).code).toBe('INVALID_STACK');
      });

      it('quarantines the old unreadable record before saving over it, so no data is lost', async () => {
        const corrupt = makeCorruptRecord('a');
        await harness.putRawStack(corrupt);

        const replacement = makeStack('a', 'Replacement');
        const saved = valueOf(await repo.save(replacement, 70));
        expect(saved.id).toBe('a');
        expect(saved.savedAt).toBe(70);

        expect(await harness.quarantined()).toEqual([corrupt]);
        expect(valueOf(await repo.load('a'))).toEqual(replacement);
        const listed = valueOf(await repo.list(80));
        expect(listed.stacks.map((stack) => stack.id)).toEqual(['a']);
        expect(listed.problems).toEqual([]);
      });

      it('keeps the unreadable record in place when the save itself is rejected', async () => {
        const corrupt = makeCorruptRecord('a');
        await harness.putRawStack(corrupt);
        expect(errorOf(await repo.save(makeInvalidStack('a'), 70)).code).toBe('INVALID_STACK');
        expect(await harness.quarantined()).toEqual([]);
        expect(errorOf(await repo.load('a')).code).toBe('INVALID_STACK');
      });
    });

    describe('seeding', () => {
      it('writes every seed with origin seed once, and the second call does nothing', async () => {
        const seeds = seedsOf('seed-a', 'seed-b', 'seed-c');
        expect(valueOf(await repo.seedIfNeeded(seeds, 100))).toEqual({ seeded: true });

        const listed = valueOf(await repo.list(110));
        expect(listed.stacks).toEqual([
          { id: 'seed-a', name: 'Original seed-a', savedAt: 100, origin: 'seed' },
          { id: 'seed-b', name: 'Original seed-b', savedAt: 100, origin: 'seed' },
          { id: 'seed-c', name: 'Original seed-c', savedAt: 100, origin: 'seed' },
        ]);
        expect(valueOf(await repo.getMeta('seeded'))).toBe(true);
        expect(valueOf(await repo.load('seed-b'))).toEqual(seeds[1]?.stack);

        expect(valueOf(await repo.seedIfNeeded(seeds, 200))).toEqual({ seeded: false });
        expect(valueOf(await repo.list(210)).stacks.map((stack) => stack.savedAt)).toEqual([
          100, 100, 100,
        ]);
      });

      it('stores savedAt as now minus the seed position, so the list follows the positions', async () => {
        const seeds: SeedStack[] = [
          { stack: makeStack('seed-z', 'Z'), position: 0 },
          { stack: makeStack('seed-m', 'M'), position: 1 },
          { stack: makeStack('seed-a', 'A'), position: 2 },
        ];
        valueOf(await repo.seedIfNeeded(seeds, 100));

        expect(valueOf(await repo.list(110)).stacks).toEqual([
          { id: 'seed-z', name: 'Z', savedAt: 100, origin: 'seed' },
          { id: 'seed-m', name: 'M', savedAt: 99, origin: 'seed' },
          { id: 'seed-a', name: 'A', savedAt: 98, origin: 'seed' },
        ]);
      });

      it('does not bring a deleted seed stack back', async () => {
        const seeds = seedsOf('seed-a', 'seed-b');
        valueOf(await repo.seedIfNeeded(seeds, 100));
        valueOf(await repo.moveToTrash('seed-a', 150));

        expect(valueOf(await repo.seedIfNeeded(seeds, 200))).toEqual({ seeded: false });
        expect(await listIds(repo)).toEqual(['seed-b']);
      });

      it('does not seed over the stacks of a database that already has some', async () => {
        valueOf(await repo.save(makeStack('mine', 'Mine'), 10));
        expect(valueOf(await repo.seedIfNeeded(seedsOf('seed-a'), 100))).toEqual({
          seeded: false,
        });
        expect(await listIds(repo)).toEqual(['mine']);
      });

      it('writes nothing and sets no marker when a seed is invalid', async () => {
        const seeds: SeedStack[] = [
          { stack: makeStack('seed-a') },
          { stack: makeInvalidStack('seed-b') },
        ];
        expect(errorOf(await repo.seedIfNeeded(seeds, 100)).code).toBe('INVALID_STACK');

        expect(await listIds(repo)).toEqual([]);
        expect(valueOf(await repo.getMeta('seeded'))).toBeUndefined();

        // A later start with good seeds still works.
        expect(valueOf(await repo.seedIfNeeded(seedsOf('seed-a'), 200))).toEqual({ seeded: true });
      });

      it('leaves no stacks and no marker when seeding fails part way, and a retry succeeds', async (context) => {
        if (harness.seedFailureSetup === undefined) {
          context.skip();
        }
        const failing = await harness.seedFailureSetup?.();
        if (failing === undefined) {
          return;
        }
        extra.push(failing);
        const seeds = seedsOf('seed-a', 'seed-b', 'seed-c');

        const failed = await failing.repository.seedIfNeeded(seeds, 100);
        expect(failed.ok).toBe(false);
        expect(errorOf(failed).code).toBe('STORAGE_FAILED');
        expect(await listIds(failing.repository)).toEqual([]);
        expect(valueOf(await failing.repository.getMeta('seeded'))).toBeUndefined();

        const retried = await failing.repository.seedIfNeeded(seeds, 200);
        expect(valueOf(retried)).toEqual({ seeded: true });
        expect(await listIds(failing.repository)).toEqual(['seed-a', 'seed-b', 'seed-c']);
        expect(valueOf(await failing.repository.getMeta('seeded'))).toBe(true);
      });
    });

    describe('trash', () => {
      it('moves a stack to the trash in one step, never in both places and never in neither', async () => {
        const stack = makeStack('a', 'Alpha');
        valueOf(await repo.save(stack, 10));
        expect([await listIds(repo), await trashIds(repo)]).toEqual([['a'], []]);

        const dropped = valueOf(await repo.moveToTrash('a', 50));
        expect(dropped).toEqual([]);
        expect([await listIds(repo), await trashIds(repo)]).toEqual([[], ['a']]);

        const trash = valueOf(await repo.listTrash());
        expect(trash).toHaveLength(1);
        expect(trash[0]).toMatchObject({ id: 'a', name: 'Alpha', deletedAt: 50 });
        expect(errorOf(await repo.load('a')).code).toBe('NOT_FOUND');
      });

      it('gives NOT_FOUND for a stack that is not stored and changes nothing', async () => {
        valueOf(await repo.save(makeStack('a'), 10));
        expect(errorOf(await repo.moveToTrash('missing', 50)).code).toBe('NOT_FOUND');
        expect([await listIds(repo), await trashIds(repo)]).toEqual([['a'], []]);
      });

      it('keeps the same stack twice in the trash under two keys', async () => {
        valueOf(await repo.save(makeStack('a', 'First'), 10));
        valueOf(await repo.moveToTrash('a', 20));
        valueOf(await repo.save(makeStack('a', 'Second'), 30));
        valueOf(await repo.moveToTrash('a', 40));

        const trash = valueOf(await repo.listTrash());
        expect(trash.map((item) => item.name)).toEqual(['Second', 'First']);
        expect(new Set(trash.map((item) => item.key)).size).toBe(2);
      });

      it('lists the trash newest first', async () => {
        for (const [id, savedAt] of [
          ['a', 1],
          ['b', 2],
          ['c', 3],
        ] as const) {
          valueOf(await repo.save(makeStack(id), savedAt));
        }
        valueOf(await repo.moveToTrash('a', 10));
        valueOf(await repo.moveToTrash('b', 30));
        valueOf(await repo.moveToTrash('c', 20));
        const trash = valueOf(await repo.listTrash());
        expect(trash.map((item) => [item.id, item.deletedAt])).toEqual([
          ['b', 30],
          ['c', 20],
          ['a', 10],
        ]);
      });

      it('keeps 50 records when 51 are moved, drops the oldest and reports it', async () => {
        const ids = Array.from(
          { length: 51 },
          (_, index) => `s-${String(index + 1).padStart(2, '0')}`,
        );
        for (const [index, id] of ids.entries()) {
          valueOf(await repo.save(makeStack(id), index + 1));
        }

        for (const [index, id] of ids.entries()) {
          const dropped = valueOf(await repo.moveToTrash(id, 1000 + index));
          if (index < 50) {
            expect(dropped).toEqual([]);
          } else {
            expect(dropped).toHaveLength(1);
            expect(dropped[0]).toMatchObject({ id: 's-01', deletedAt: 1000 });
          }
        }

        const trash = valueOf(await repo.listTrash());
        expect(trash).toHaveLength(50);
        expect(trash.map((item) => item.id)).not.toContain('s-01');
        expect(trash[0]?.id).toBe('s-51');
        expect(trash[49]?.id).toBe('s-02');
        expect(await listIds(repo)).toEqual([]);
      });

      it('restores a trash record into a free id, keeping its content and origin', async () => {
        const stack = makeStack('a', 'Alpha');
        valueOf(await repo.save(stack, 10));
        valueOf(await repo.moveToTrash('a', 20));

        const key = await trashKeyOf(repo, 'a');
        const restored = valueOf(await repo.restoreFromTrash(key, 70));
        expect(restored).toEqual({ id: 'a', name: 'Alpha', savedAt: 70, origin: 'user' });
        expect([await listIds(repo), await trashIds(repo)]).toEqual([['a'], []]);
        expect(valueOf(await repo.load('a'))).toEqual(stack);
      });

      it('keeps origin seed when a trashed seed stack is restored', async () => {
        valueOf(await repo.seedIfNeeded(seedsOf('seed-a'), 100));
        valueOf(await repo.moveToTrash('seed-a', 150));
        const restored = valueOf(
          await repo.restoreFromTrash(await trashKeyOf(repo, 'seed-a'), 200),
        );
        expect(restored.origin).toBe('seed');
      });

      it('gives NOT_FOUND for a trash key that does not exist', async () => {
        expect(errorOf(await repo.restoreFromTrash(987654, 10)).code).toBe('NOT_FOUND');
      });

      it('gives ID_IN_USE without newId when the id is taken, and keeps the trash record', async () => {
        valueOf(await repo.save(makeStack('a', 'Old'), 10));
        valueOf(await repo.moveToTrash('a', 20));
        const current = makeStack('a', 'Current');
        valueOf(await repo.save(current, 30));

        const key = await trashKeyOf(repo, 'a');
        expect(errorOf(await repo.restoreFromTrash(key, 70)).code).toBe('ID_IN_USE');

        expect(await trashIds(repo)).toEqual(['a']);
        expect(valueOf(await repo.load('a'))).toEqual(current);
      });

      it('stores a remix with remixedFrom when newId is given for a taken id', async () => {
        const old = makeStack('a', 'Old');
        valueOf(await repo.save(old, 10));
        valueOf(await repo.moveToTrash('a', 20));
        const current = makeStack('a', 'Current');
        valueOf(await repo.save(current, 30));

        const key = await trashKeyOf(repo, 'a');
        const restored = valueOf(await repo.restoreFromTrash(key, 70, 'a-copy'));
        expect(restored).toMatchObject({ id: 'a-copy', savedAt: 70, origin: 'user' });

        const copy = valueOf(await repo.load('a-copy'));
        expect(copy.id).toBe('a-copy');
        expect(copy.remixedFrom).toBe('a');
        expect(copy.cards).toEqual(old.cards);
        expect(valueOf(await repo.load('a'))).toEqual(current);
        expect(await trashIds(repo)).toEqual([]);
      });

      it('gives ID_IN_USE when newId is also taken, and keeps the trash record', async () => {
        valueOf(await repo.save(makeStack('a'), 10));
        valueOf(await repo.moveToTrash('a', 20));
        valueOf(await repo.save(makeStack('a'), 30));
        valueOf(await repo.save(makeStack('b'), 40));

        const key = await trashKeyOf(repo, 'a');
        expect(errorOf(await repo.restoreFromTrash(key, 70, 'b')).code).toBe('ID_IN_USE');
        expect(await trashIds(repo)).toEqual(['a']);
      });

      it('deletes one trash record forever and leaves the others', async () => {
        valueOf(await repo.save(makeStack('a'), 1));
        valueOf(await repo.save(makeStack('b'), 2));
        valueOf(await repo.moveToTrash('a', 10));
        valueOf(await repo.moveToTrash('b', 20));

        valueOf(await repo.deleteForever(await trashKeyOf(repo, 'a')));
        expect(await trashIds(repo)).toEqual(['b']);
      });

      it('empties the trash and leaves the stacks', async () => {
        valueOf(await repo.save(makeStack('a'), 1));
        valueOf(await repo.save(makeStack('b'), 2));
        valueOf(await repo.save(makeStack('keep'), 3));
        valueOf(await repo.moveToTrash('a', 10));
        valueOf(await repo.moveToTrash('b', 20));

        valueOf(await repo.emptyTrash());
        expect(await trashIds(repo)).toEqual([]);
        expect(await listIds(repo)).toEqual(['keep']);
      });
    });

    describe('restore demo stacks', () => {
      it('stores savedAt as now minus the seed position when restoring', async () => {
        const seeds: SeedStack[] = [
          { stack: makeStack('seed-z', 'Z'), position: 0 },
          { stack: makeStack('seed-a', 'A'), position: 1 },
        ];
        valueOf(await repo.seedIfNeeded(seeds, 100));
        valueOf(await repo.restoreDemo(seeds, 300));

        expect(valueOf(await repo.list(310)).stacks).toEqual([
          { id: 'seed-z', name: 'Z', savedAt: 300, origin: 'seed' },
          { id: 'seed-a', name: 'A', savedAt: 299, origin: 'seed' },
        ]);
      });

      it('replaces seed stacks, moves edited copies to the trash, leaves other ids alone and adds missing seeds', async () => {
        const seeds = seedsOf('seed-a', 'seed-b', 'seed-c');
        valueOf(await repo.seedIfNeeded(seeds, 100));
        valueOf(await repo.save(makeStack('seed-a', 'Edited seed-a'), 200));
        const mine = makeStack('mine', 'Mine');
        valueOf(await repo.save(mine, 210));
        valueOf(await repo.moveToTrash('seed-b', 250));

        const outcome = valueOf(await repo.restoreDemo(seeds, 300));
        expect([...outcome.replacedIds].sort()).toEqual(['seed-a', 'seed-c']);
        expect(outcome.addedIds).toEqual(['seed-b']);
        expect(outcome.dropped).toEqual([]);

        const listed = valueOf(await repo.list(310));
        expect(listed.problems).toEqual([]);
        expect(listed.stacks).toEqual([
          { id: 'seed-a', name: 'Original seed-a', savedAt: 300, origin: 'seed' },
          { id: 'seed-b', name: 'Original seed-b', savedAt: 300, origin: 'seed' },
          { id: 'seed-c', name: 'Original seed-c', savedAt: 300, origin: 'seed' },
          { id: 'mine', name: 'Mine', savedAt: 210, origin: 'user' },
        ]);
        expect(valueOf(await repo.load('mine'))).toEqual(mine);
        expect(valueOf(await repo.load('seed-a'))).toEqual(seeds[0]?.stack);

        const trash = valueOf(await repo.listTrash());
        const edited = trash.find((item) => item.name === 'Edited seed-a');
        expect(edited).toMatchObject({ id: 'seed-a', deletedAt: 300 });
        expect(trash.filter((item) => item.id === 'seed-c')).toHaveLength(1);
        expect(trash.filter((item) => item.id === 'seed-b')).toHaveLength(1);
        expect(trash.some((item) => item.id === 'mine')).toBe(false);
        expect(trash).toHaveLength(3);
      });

      it('lets the user get the edited copy back from the trash', async () => {
        const seeds = seedsOf('seed-a');
        valueOf(await repo.seedIfNeeded(seeds, 100));
        const edited = makeStack('seed-a', 'Edited seed-a');
        valueOf(await repo.save(edited, 200));
        valueOf(await repo.restoreDemo(seeds, 300));

        const key = await trashKeyOf(repo, 'seed-a');
        const restored = valueOf(await repo.restoreFromTrash(key, 400, 'seed-a-mine'));
        expect(restored.id).toBe('seed-a-mine');
        expect(valueOf(await repo.load('seed-a-mine')).cards).toEqual(edited.cards);
      });

      it('changes nothing when a seed is invalid', async () => {
        const seeds = seedsOf('seed-a');
        valueOf(await repo.seedIfNeeded(seeds, 100));
        const edited = makeStack('seed-a', 'Edited seed-a');
        valueOf(await repo.save(edited, 200));

        const bad: SeedStack[] = [{ stack: makeInvalidStack('seed-a') }];
        expect(errorOf(await repo.restoreDemo(bad, 300)).code).toBe('INVALID_STACK');
        expect(valueOf(await repo.load('seed-a'))).toEqual(edited);
        expect(await trashIds(repo)).toEqual([]);
      });
    });

    describe('meta', () => {
      it('gives ok undefined for a key that was never set', async () => {
        expect(valueOf(await repo.getMeta('lastOpenedId'))).toBeUndefined();
      });

      it('returns what was set, strings and booleans, and the last value wins', async () => {
        valueOf(await repo.setMeta('lastOpenedId', 'a'));
        expect(valueOf(await repo.getMeta('lastOpenedId'))).toBe('a');
        valueOf(await repo.setMeta('lastOpenedId', 'b'));
        expect(valueOf(await repo.getMeta('lastOpenedId'))).toBe('b');
        valueOf(await repo.setMeta('flag', false));
        expect(valueOf(await repo.getMeta('flag'))).toBe(false);
      });
    });

    describe('result values', () => {
      it('returns ok or not-ok as a value from every method and never throws', async () => {
        await harness.putRawStack(makeCorruptRecord('bad'));
        valueOf(await repo.save(makeStack('a'), 10));

        const calls: ReadonlyArray<() => Promise<Result<unknown>>> = [
          () => repo.list(1),
          () => repo.load('a'),
          () => repo.load('missing'),
          () => repo.load('bad'),
          () => repo.save(makeStack('a', 'Again'), 2),
          () => repo.save(makeInvalidStack('a'), 3),
          () => repo.create(makeStack('a'), 4),
          () => repo.create(makeStack('new'), 5),
          () => repo.create(makeInvalidStack('other'), 5),
          () => repo.moveToTrash('missing', 6),
          () => repo.moveToTrash('new', 7),
          () => repo.listTrash(),
          () => repo.restoreFromTrash(424242, 8),
          () => repo.restoreFromTrash(1, 8, 'Not A Valid Id'),
          () => repo.deleteForever(424242),
          () => repo.seedIfNeeded([{ stack: makeInvalidStack('s') }], 9),
          () => repo.restoreDemo([{ stack: makeInvalidStack('s') }], 9),
          () => repo.getMeta('nothing'),
          () => repo.setMeta('k', 'v'),
          () => repo.emptyTrash(),
        ];

        for (const call of calls) {
          const result = await call();
          expect(typeof result.ok).toBe('boolean');
          if (result.ok) {
            expect(result).toHaveProperty('value');
          } else {
            expect(result.errors.length).toBeGreaterThan(0);
            for (const error of result.errors) {
              expect(typeof error.code).toBe('string');
              expect(error.message.length).toBeGreaterThan(0);
            }
          }
        }
      });

      it('does not alias: changing a loaded stack or a saved input leaves the stored stack alone', async () => {
        const input = makeStack('a', 'Stored') as Mutable<Stack>;
        valueOf(await repo.save(input, 10));

        input.name = 'Changed after save';

        const loaded = valueOf(await repo.load('a')) as Mutable<Stack>;
        expect(loaded.name).toBe('Stored');
        loaded.name = 'Changed after load';
        const firstCard = loaded.cards[0];
        if (firstCard !== undefined) {
          (firstCard as { name: string }).name = 'Changed card';
        }

        const again = valueOf(await repo.load('a'));
        expect(again).toEqual(makeStack('a', 'Stored'));
        expect(valueOf(await repo.list(20)).stacks[0]?.name).toBe('Stored');
      });
    });
  });
}
