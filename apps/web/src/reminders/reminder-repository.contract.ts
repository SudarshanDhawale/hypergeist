import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_STORED_REMINDERS } from './memory-reminder-repository.ts';
import type {
  ClosableReminderRepository,
  ReminderRepositoryTesting,
} from './memory-reminder-repository.ts';
import type { Reminder, ReminderError, ReminderResult } from './types.ts';

/**
 * What the contract needs from an implementation under test. One harness is one empty,
 * independent store: the contract calls `makeHarness()` before every example and `close()` after it.
 */
export type ReminderContractHarness = {
  readonly repository: ClosableReminderRepository;
  readonly testing: ReminderRepositoryTesting;
  /** Releases the store. Called once per harness, after the repository was closed. */
  close(): Promise<void> | void;
};

export type MakeReminderHarness = () => Promise<ReminderContractHarness> | ReminderContractHarness;

/** A valid reminder. Every call returns a fresh object. */
export function makeReminder(id: string, overrides: Partial<Reminder> = {}): Reminder {
  return {
    id,
    stackId: 'smart-todo',
    message: `Message ${id}`,
    dueAt: 1_000,
    createdAt: 500,
    state: 'pending',
    ...overrides,
  };
}

function valueOf<T>(result: ReminderResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected a value but got: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function errorsOf(
  result: { readonly ok: true } | { readonly ok: false; readonly errors: readonly ReminderError[] },
): readonly ReminderError[] {
  if (result.ok) {
    throw new Error('Expected a failure but the call succeeded.');
  }
  return result.errors;
}

async function idsOf(repository: ClosableReminderRepository): Promise<string[]> {
  return valueOf(await repository.list()).map((reminder) => reminder.id);
}

/** Behavior every reminder repository must have. Run it once per implementation. */
export function runReminderRepositoryContract(
  label: string,
  makeHarness: MakeReminderHarness,
): void {
  describe(`reminder repository contract: ${label}`, () => {
    let harness: ReminderContractHarness;
    let repo: ClosableReminderRepository;

    beforeEach(async () => {
      harness = await makeHarness();
      repo = harness.repository;
    });

    afterEach(async () => {
      await repo.close();
      await harness.close();
    });

    describe('list', () => {
      it('is empty on a new store', async () => {
        expect(valueOf(await repo.list())).toEqual([]);
      });

      it('returns what was put, unchanged', async () => {
        const reminder = makeReminder('a', { state: 'fired', dueAt: 42 });
        valueOf(await repo.put(reminder));
        expect(valueOf(await repo.list())).toEqual([reminder]);
      });

      it('sorts by due time, then by id', async () => {
        valueOf(await repo.put(makeReminder('b', { dueAt: 300 })));
        valueOf(await repo.put(makeReminder('z', { dueAt: 100 })));
        valueOf(await repo.put(makeReminder('c', { dueAt: 200 })));
        valueOf(await repo.put(makeReminder('a', { dueAt: 200 })));
        valueOf(await repo.put(makeReminder('a2', { dueAt: 200 })));
        expect(await idsOf(repo)).toEqual(['z', 'a', 'a2', 'c', 'b']);
      });

      it('orders by number, not by text, when due times differ in length', async () => {
        valueOf(await repo.put(makeReminder('late', { dueAt: 1_000_000 })));
        valueOf(await repo.put(makeReminder('early', { dueAt: 999 })));
        expect(await idsOf(repo)).toEqual(['early', 'late']);
      });

      it('returns copies: changing a result does not change the store', async () => {
        valueOf(await repo.put(makeReminder('a')));
        const first = valueOf(await repo.list()) as Reminder[];
        const firstItem = first[0];
        if (firstItem === undefined) {
          throw new Error('Expected one reminder.');
        }
        (firstItem as { message: string }).message = 'Changed after the read';
        expect(valueOf(await repo.list())[0]?.message).toBe('Message a');
      });

      it('drops and deletes a corrupt record, and keeps the valid ones', async () => {
        valueOf(await repo.put(makeReminder('good', { dueAt: 5 })));
        await harness.testing.putRaw({ id: 'bad-type', message: 'x' });
        await harness.testing.putRaw({ ...makeReminder('bad-state'), state: 'done' });
        await harness.testing.putRaw({ ...makeReminder('bad-extra'), extra: true });
        await harness.testing.putRaw({ ...makeReminder('bad-empty'), message: '' });
        expect(await harness.testing.rawIds()).toHaveLength(5);

        expect(await idsOf(repo)).toEqual(['good']);
        expect(await harness.testing.rawIds()).toEqual(['good']);
        expect(await idsOf(repo)).toEqual(['good']);
      });

      it('does not throw when every record is corrupt', async () => {
        await harness.testing.putRaw({ id: 'one' });
        await harness.testing.putRaw({ id: 'two', dueAt: 'soon' });
        expect(valueOf(await repo.list())).toEqual([]);
        expect(await harness.testing.rawIds()).toEqual([]);
      });
    });

    describe('put', () => {
      it('replaces the reminder with the same id', async () => {
        valueOf(await repo.put(makeReminder('a', { message: 'Old', dueAt: 10 })));
        valueOf(await repo.put(makeReminder('a', { message: 'New', dueAt: 20, state: 'fired' })));
        const all = valueOf(await repo.list());
        expect(all).toEqual([makeReminder('a', { message: 'New', dueAt: 20, state: 'fired' })]);
      });

      it('replaces a corrupt record stored under the same id', async () => {
        await harness.testing.putRaw({ id: 'a', junk: 1 });
        valueOf(await repo.put(makeReminder('a')));
        expect(valueOf(await repo.list())).toEqual([makeReminder('a')]);
      });

      it('rejects an invalid reminder with INVALID_REMINDER and stores nothing', async () => {
        const bad: unknown[] = [
          { ...makeReminder('a'), message: '' },
          { ...makeReminder('a'), message: 'x'.repeat(501) },
          { ...makeReminder('a'), dueAt: -1 },
          { ...makeReminder('a'), dueAt: 1.5 },
          { ...makeReminder('a'), state: 'done' },
          { ...makeReminder('a'), id: 'Not A Valid Id' },
          { ...makeReminder('a'), extra: true },
          { id: 'a' },
          null,
          'text',
        ];
        for (const value of bad) {
          const errors = errorsOf(await repo.put(value as Reminder));
          expect(errors.map((error) => error.code)).toEqual(['INVALID_REMINDER']);
          expect(errors[0]?.message.length).toBeGreaterThan(0);
        }
        expect(await harness.testing.rawIds()).toEqual([]);
      });

      it('stores a copy: changing the object afterwards does not change the store', async () => {
        const reminder = makeReminder('a');
        valueOf(await repo.put(reminder));
        reminder.message = 'Changed after the put';
        expect(valueOf(await repo.list())[0]?.message).toBe('Message a');
      });

      it(`accepts ${String(MAX_STORED_REMINDERS)} reminders and rejects a new id after that`, async () => {
        for (let index = 0; index < MAX_STORED_REMINDERS; index += 1) {
          valueOf(await repo.put(makeReminder(`r${String(index)}`, { dueAt: index })));
        }
        const errors = errorsOf(await repo.put(makeReminder('one-too-many')));
        expect(errors.map((error) => error.code)).toEqual(['QUOTA_EXCEEDED']);
        expect(errors[0]?.message.length).toBeGreaterThan(0);
        expect(valueOf(await repo.list())).toHaveLength(MAX_STORED_REMINDERS);
        expect(await idsOf(repo)).not.toContain('one-too-many');
      });

      it('still replaces an existing id when the store is full', async () => {
        for (let index = 0; index < MAX_STORED_REMINDERS; index += 1) {
          valueOf(await repo.put(makeReminder(`r${String(index)}`, { dueAt: index })));
        }
        valueOf(await repo.put(makeReminder('r7', { message: 'Replaced', dueAt: 7 })));
        const all = valueOf(await repo.list());
        expect(all).toHaveLength(MAX_STORED_REMINDERS);
        expect(all.find((reminder) => reminder.id === 'r7')?.message).toBe('Replaced');
      });

      it('accepts a new id again after a removal frees room', async () => {
        for (let index = 0; index < MAX_STORED_REMINDERS; index += 1) {
          valueOf(await repo.put(makeReminder(`r${String(index)}`)));
        }
        valueOf(await repo.remove('r0'));
        valueOf(await repo.put(makeReminder('fresh')));
        expect(await idsOf(repo)).toContain('fresh');
      });
    });

    describe('remove', () => {
      it('removes the reminder with that id and keeps the others', async () => {
        valueOf(await repo.put(makeReminder('a', { dueAt: 1 })));
        valueOf(await repo.put(makeReminder('b', { dueAt: 2 })));
        valueOf(await repo.remove('a'));
        expect(await idsOf(repo)).toEqual(['b']);
      });

      it('is ok for an unknown id, and for a repeat', async () => {
        valueOf(await repo.remove('never-stored'));
        valueOf(await repo.put(makeReminder('a')));
        valueOf(await repo.remove('a'));
        valueOf(await repo.remove('a'));
        expect(valueOf(await repo.list())).toEqual([]);
      });
    });

    describe('after close', () => {
      it('returns STORAGE_FAILED from every method and never throws', async () => {
        valueOf(await repo.put(makeReminder('a')));
        await repo.close();
        const results = [
          await repo.list(),
          await repo.put(makeReminder('b')),
          await repo.remove('a'),
        ];
        for (const result of results) {
          expect(errorsOf(result).map((error) => error.code)).toEqual(['STORAGE_FAILED']);
          expect(errorsOf(result)[0]?.message.length).toBeGreaterThan(0);
        }
      });

      it('can be closed twice', async () => {
        await repo.close();
        await expect(repo.close()).resolves.toBeUndefined();
      });
    });
  });
}
