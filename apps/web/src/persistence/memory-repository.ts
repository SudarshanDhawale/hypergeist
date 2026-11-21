import { createValidationError, parseStack, validateStack } from '@hypergeist/shared/format';
import type { Stack, ValidationError } from '@hypergeist/shared/format';
import { remixStack } from '@hypergeist/shared/engine';

import type {
  ListResult,
  MetaKey,
  MetaValue,
  PersistenceError,
  PersistenceErrorCode,
  QuarantineProblem,
  Repository,
  RestoreDemoOutcome,
  Result,
  SaveOutcome,
  SeedOutcome,
  SeedStack,
  StackOrigin,
  StackRecord,
  StackSummary,
  TrashRecord,
  TrashSummary,
} from './types.ts';

/** Most trash records kept. When a move would exceed it, the oldest records are deleted. */
export const DEFAULT_TRASH_CAP = 50;

/** Name of the meta key that marks a database as seeded. */
const SEEDED_KEY = 'seeded';

/** A record moved to the quarantine, unchanged, with the errors that put it there. */
export type QuarantineEntry = {
  readonly key: number;
  readonly record: unknown;
  readonly errors: readonly ValidationError[];
  readonly quarantinedAt: number;
};

/**
 * Test-only hooks. Production code must not use them: they bypass validation on purpose so a
 * test can place bad data in the store, and they hand out copies of internals.
 */
export type MemoryRepositoryTesting = {
  /**
   * Stores `record` in the `stacks` store exactly as given, with no validation and no clone
   * of the caller's reference beyond `structuredClone`. The key is `key` when given, else
   * `record.stack.id` when that is a string, else `raw-<n>`. Replaces a record with that key.
   */
  putRawStack(record: unknown, key?: string): string;
  /** Returns a copy of the raw record stored under `key`, or `undefined`. */
  rawStack(key: string): unknown;
  /** Adds a trash record as given (no validation). Returns its trash key. */
  putTrashRecord(record: TrashRecord): number;
  /** Returns copies of every quarantine entry, oldest first. */
  quarantine(): readonly QuarantineEntry[];
};

export type MemoryRepositoryOptions = {
  /** Records present from the start. They are copied, and are not validated until read. */
  readonly initial?: {
    readonly stacks?: readonly StackRecord[];
    readonly trash?: readonly TrashRecord[];
    readonly meta?: Readonly<Record<MetaKey, MetaValue>>;
  };
  /** Trash cap. Defaults to 50. Mostly for tests. */
  readonly trashCap?: number;
  /**
   * Test hook. Called with the key of every stack about to be written to the `stacks` store
   * (save, create, seeding, restore demo, restore from trash). If it returns true the write
   * fails with `STORAGE_FAILED` and the whole operation is rolled back.
   */
  readonly failOnPut?: (id: string) => boolean;
};

export type MemoryRepository = Repository & { readonly testing: MemoryRepositoryTesting };

type QuarantineValue = Omit<QuarantineEntry, 'key'>;

/** The whole store. Records inside are never modified in place, only replaced. */
type State = {
  stacks: Map<string, unknown>;
  trash: Map<number, TrashRecord>;
  quarantine: Map<number, QuarantineValue>;
  meta: Map<string, MetaValue>;
  nextTrashKey: number;
  nextQuarantineKey: number;
};

type Inspection =
  | { readonly ok: true; readonly record: StackRecord }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail(
  code: PersistenceErrorCode,
  message: string,
  validationErrors?: readonly ValidationError[],
): { readonly ok: false; readonly errors: readonly PersistenceError[] } {
  const error: PersistenceError =
    validationErrors === undefined ? { code, message } : { code, message, validationErrors };
  return { ok: false, errors: [error] };
}

function storageFailed(): { readonly ok: false; readonly errors: readonly PersistenceError[] } {
  return fail('STORAGE_FAILED', 'Your stacks could not be stored in this browser.');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrigin(value: unknown): value is StackOrigin {
  return value === 'seed' || value === 'user';
}

function copyState(state: State): State {
  return {
    stacks: new Map(state.stacks),
    trash: new Map(state.trash),
    quarantine: new Map(state.quarantine),
    meta: new Map(state.meta),
    nextTrashKey: state.nextTrashKey,
    nextQuarantineKey: state.nextQuarantineKey,
  };
}

function envelopeError(
  path: string,
  code: 'MISSING_PROPERTY' | 'WRONG_TYPE' | 'INVALID_VALUE',
  what: string,
) {
  return createValidationError({
    code,
    path,
    message: `The stored record has a problem with ${what}.`,
    expected: what,
    hint: 'This record was set aside. Export is not possible for it, but it is kept unchanged.',
  });
}

/**
 * Checks one stored record: the record shape, then the stack with `parseStack`, then that the
 * store key equals the stack id. The result holds fresh copies, never the stored objects.
 */
function inspect(key: string, raw: unknown): Inspection {
  if (!isObject(raw)) {
    return { ok: false, errors: [envelopeError('', 'WRONG_TYPE', 'a record object')] };
  }
  if (!('stack' in raw)) {
    return { ok: false, errors: [envelopeError('/stack', 'MISSING_PROPERTY', 'a stack')] };
  }
  const { savedAt, origin } = raw;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) {
    return { ok: false, errors: [envelopeError('/savedAt', 'WRONG_TYPE', 'a saved time')] };
  }
  if (!isOrigin(origin)) {
    return { ok: false, errors: [envelopeError('/origin', 'INVALID_VALUE', 'an origin')] };
  }
  const parsed = parseStack(structuredClone(raw.stack));
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors };
  }
  if (parsed.value.id !== key) {
    return {
      ok: false,
      errors: [envelopeError('/stack/id', 'INVALID_VALUE', 'a stack id equal to the store key')],
    };
  }
  return { ok: true, record: { stack: structuredClone(parsed.value), savedAt, origin } };
}

function summaryOf(record: StackRecord): StackSummary {
  return {
    id: record.stack.id,
    name: record.stack.name,
    savedAt: record.savedAt,
    origin: record.origin,
  };
}

function trashSummaryOf(key: number, record: TrashRecord): TrashSummary {
  return { key, id: record.stack.id, name: record.stack.name, deletedAt: record.deletedAt };
}

/** Existing origin of a stored record, or `user` when the record has none that is valid. */
function originOf(raw: unknown): StackOrigin {
  return isObject(raw) && isOrigin(raw.origin) ? raw.origin : 'user';
}

function seedLabel(seed: SeedStack, index: number): string {
  const id: unknown = isObject(seed.stack) ? seed.stack.id : undefined;
  return typeof id === 'string' ? `"${id}"` : `number ${index + 1}`;
}

/** Validates every seed. Returns the failure to report, or `undefined` when all are fine. */
function checkSeeds(
  seeds: readonly SeedStack[],
): { readonly ok: false; readonly errors: readonly PersistenceError[] } | undefined {
  const seen = new Set<string>();
  const collected: ValidationError[] = [];
  let firstBad: string | undefined;
  for (const [index, seed] of seeds.entries()) {
    const result = validateStack(seed.stack);
    if (!result.valid) {
      firstBad ??= seedLabel(seed, index);
      collected.push(...result.errors);
    } else if (seen.has(seed.stack.id)) {
      return fail(
        'INVALID_STACK',
        `Two demo stacks use the id "${seed.stack.id}", so nothing was saved.`,
      );
    } else {
      seen.add(seed.stack.id);
    }
  }
  if (firstBad !== undefined) {
    return fail(
      'INVALID_STACK',
      `The demo stack ${firstBad} is not valid, so nothing was saved.`,
      collected,
    );
  }
  return undefined;
}

/**
 * Creates a repository that keeps everything in memory. It is the Memory_Mode store and the
 * reference for the contract tests that the IndexedDB repository must also pass.
 *
 * Every read and write goes through `structuredClone`, so callers can never change stored
 * data, and stored data can never change under a caller. Every method that changes data works
 * on a copy of the maps and swaps it in only when the whole operation succeeds, which gives
 * the same all-or-nothing behavior as one IndexedDB transaction.
 *
 * Time comes from the callers (`now`). Nothing here reads a clock or uses randomness.
 *
 * Decision on `load`: `load(id)` has no `now`, so it cannot stamp a quarantine entry. An
 * invalid record makes `load` return `INVALID_STACK` with the validation errors and leave the
 * record in place. The next `list(now)` moves it to the quarantine.
 */
export function createMemoryRepository(options: MemoryRepositoryOptions = {}): MemoryRepository {
  const trashCap = options.trashCap ?? DEFAULT_TRASH_CAP;
  const failOnPut = options.failOnPut;

  let state: State = {
    stacks: new Map(),
    trash: new Map(),
    quarantine: new Map(),
    meta: new Map(),
    nextTrashKey: 1,
    nextQuarantineKey: 1,
  };

  for (const record of options.initial?.stacks ?? []) {
    state.stacks.set(record.stack.id, structuredClone(record));
  }
  for (const record of options.initial?.trash ?? []) {
    state.trash.set(state.nextTrashKey, structuredClone(record));
    state.nextTrashKey += 1;
  }
  for (const [key, value] of Object.entries(options.initial?.meta ?? {})) {
    state.meta.set(key, value);
  }

  /** Runs `change` on a copy and keeps the copy only if it returns `ok`. Never throws. */
  function transact<T>(change: (working: State) => Result<T>): Promise<Result<T>> {
    try {
      const working = copyState(state);
      const result = change(working);
      if (result.ok) {
        state = working;
      }
      return Promise.resolve(result);
    } catch {
      return Promise.resolve(storageFailed());
    }
  }

  /** Reads without changing anything. Never throws. */
  function read<T>(look: (current: State) => Result<T>): Promise<Result<T>> {
    try {
      return Promise.resolve(look(state));
    } catch {
      return Promise.resolve(storageFailed());
    }
  }

  function putStack(working: State, key: string, record: StackRecord): void {
    if (failOnPut?.(key) === true) {
      throw new Error('The write was refused.');
    }
    working.stacks.set(key, structuredClone(record));
  }

  function quarantineRecord(
    working: State,
    key: string,
    errors: readonly ValidationError[],
    now: number,
  ): QuarantineProblem {
    const quarantineKey = working.nextQuarantineKey;
    working.nextQuarantineKey += 1;
    working.quarantine.set(quarantineKey, {
      record: working.stacks.get(key),
      errors: structuredClone(errors),
      quarantinedAt: now,
    });
    working.stacks.delete(key);
    return { recordKey: key, quarantineKey, errors: structuredClone(errors) };
  }

  function addToTrash(working: State, record: StackRecord, now: number): void {
    working.trash.set(working.nextTrashKey, { ...structuredClone(record), deletedAt: now });
    working.nextTrashKey += 1;
  }

  /** Deletes the oldest trash records beyond the cap. Oldest = lowest `deletedAt`, then lowest key. */
  function enforceTrashCap(working: State): readonly TrashSummary[] {
    const excess = working.trash.size - trashCap;
    if (excess <= 0) {
      return [];
    }
    const oldestFirst = [...working.trash.entries()].sort(
      (a, b) => a[1].deletedAt - b[1].deletedAt || a[0] - b[0],
    );
    const dropped: TrashSummary[] = [];
    for (const [key, record] of oldestFirst.slice(0, excess)) {
      dropped.push(trashSummaryOf(key, record));
      working.trash.delete(key);
    }
    return dropped;
  }

  function writeSeeds(working: State, seeds: readonly SeedStack[], now: number): void {
    for (const seed of seeds) {
      putStack(working, seed.stack.id, {
        stack: seed.stack,
        savedAt: now - (seed.position ?? 0),
        origin: 'seed',
      });
    }
  }

  const repository: Repository = {
    list(now: number): Promise<Result<ListResult>> {
      return transact((working) => {
        const stacks: StackSummary[] = [];
        const problems: QuarantineProblem[] = [];
        for (const [key, raw] of [...working.stacks.entries()]) {
          const inspection = inspect(key, raw);
          if (inspection.ok) {
            stacks.push(summaryOf(inspection.record));
          } else {
            problems.push(quarantineRecord(working, key, inspection.errors, now));
          }
        }
        stacks.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return ok({ stacks, problems });
      });
    },

    load(id: string): Promise<Result<Stack>> {
      return read((current) => {
        if (!current.stacks.has(id)) {
          return fail('NOT_FOUND', 'That stack was not found.');
        }
        const inspection = inspect(id, current.stacks.get(id));
        if (!inspection.ok) {
          return fail('INVALID_STACK', 'That stack could not be read.', inspection.errors);
        }
        return ok(inspection.record.stack);
      });
    },

    save(stack: Stack, now: number): Promise<Result<SaveOutcome>> {
      return transact((working) => {
        const checked = validateStack(stack);
        if (!checked.valid) {
          return fail(
            'INVALID_STACK',
            'This stack is not valid, so it was not saved.',
            checked.errors,
          );
        }
        const existing = working.stacks.get(stack.id);
        const origin = originOf(existing);
        if (working.stacks.has(stack.id)) {
          const inspection = inspect(stack.id, existing);
          if (!inspection.ok) {
            // The old record cannot be read. Set it aside unchanged before it is replaced, so
            // saving never destroys data. If the write below fails, the whole step is undone.
            quarantineRecord(working, stack.id, inspection.errors, now);
          }
        }
        const record: StackRecord = { stack, savedAt: now, origin };
        putStack(working, stack.id, record);
        return ok(summaryOf(record));
      });
    },

    create(stack: Stack, now: number): Promise<Result<SaveOutcome>> {
      return transact((working) => {
        const checked = validateStack(stack);
        if (!checked.valid) {
          return fail(
            'INVALID_STACK',
            'This stack is not valid, so it was not saved.',
            checked.errors,
          );
        }
        if (working.stacks.has(stack.id)) {
          return fail('ID_IN_USE', `A stack with the id "${stack.id}" already exists.`);
        }
        const record: StackRecord = { stack, savedAt: now, origin: 'user' };
        putStack(working, stack.id, record);
        return ok(summaryOf(record));
      });
    },

    moveToTrash(id: string, now: number): Promise<Result<readonly TrashSummary[]>> {
      return transact((working) => {
        if (!working.stacks.has(id)) {
          return fail('NOT_FOUND', 'That stack was not found.');
        }
        const inspection = inspect(id, working.stacks.get(id));
        if (!inspection.ok) {
          // The record stays where it is; the next list() moves it to the quarantine.
          return fail('INVALID_STACK', 'That stack could not be read.', inspection.errors);
        }
        working.stacks.delete(id);
        addToTrash(working, inspection.record, now);
        return ok(enforceTrashCap(working));
      });
    },

    listTrash(): Promise<Result<readonly TrashSummary[]>> {
      return read((current) => {
        const summaries = [...current.trash.entries()]
          .sort((a, b) => b[1].deletedAt - a[1].deletedAt || b[0] - a[0])
          .map(([key, record]) => trashSummaryOf(key, record));
        return ok(summaries);
      });
    },

    restoreFromTrash(key: number, now: number, newId?: string): Promise<Result<SaveOutcome>> {
      return transact((working) => {
        const trashed = working.trash.get(key);
        if (trashed === undefined) {
          return fail('NOT_FOUND', 'That item is not in the trash.');
        }
        // Trash records are parsed again before they come back. An invalid one stays in the trash.
        const parsed = parseStack(structuredClone(trashed.stack));
        if (!parsed.ok) {
          return fail('INVALID_STACK', 'That stack could not be read.', parsed.errors);
        }
        let record: StackRecord;
        if (!working.stacks.has(parsed.value.id)) {
          record = { stack: parsed.value, savedAt: now, origin: trashed.origin };
        } else if (newId === undefined) {
          return fail('ID_IN_USE', `A stack with the id "${parsed.value.id}" already exists.`);
        } else {
          const remixed = remixStack(parsed.value, newId);
          if (!remixed.ok) {
            return fail('INVALID_STACK', 'The new id is not valid.', remixed.errors);
          }
          if (working.stacks.has(newId)) {
            return fail('ID_IN_USE', `A stack with the id "${newId}" already exists.`);
          }
          // A copy under a new id is a new stack of the user, not a bundled demo stack.
          record = { stack: remixed.stack, savedAt: now, origin: 'user' };
        }
        putStack(working, record.stack.id, record);
        working.trash.delete(key);
        return ok(summaryOf(record));
      });
    },

    deleteForever(key: number): Promise<Result<void>> {
      // Deleting a key that is not there is not an error: the record is gone either way.
      return transact((working) => {
        working.trash.delete(key);
        return ok(undefined);
      });
    },

    emptyTrash(): Promise<Result<void>> {
      return transact((working) => {
        working.trash.clear();
        return ok(undefined);
      });
    },

    seedIfNeeded(seeds: readonly SeedStack[], now: number): Promise<Result<SeedOutcome>> {
      return transact<SeedOutcome>((working) => {
        if (working.meta.get(SEEDED_KEY) === true || working.stacks.size > 0) {
          return ok({ seeded: false });
        }
        const rejected = checkSeeds(seeds);
        if (rejected !== undefined) {
          return rejected;
        }
        writeSeeds(working, seeds, now);
        working.meta.set(SEEDED_KEY, true);
        return ok({ seeded: true });
      });
    },

    restoreDemo(seeds: readonly SeedStack[], now: number): Promise<Result<RestoreDemoOutcome>> {
      return transact((working) => {
        const rejected = checkSeeds(seeds);
        if (rejected !== undefined) {
          return rejected;
        }
        const replacedIds: string[] = [];
        const addedIds: string[] = [];
        for (const seed of seeds) {
          const id = seed.stack.id;
          if (working.stacks.has(id)) {
            const inspection = inspect(id, working.stacks.get(id));
            if (inspection.ok) {
              addToTrash(working, inspection.record, now);
              working.stacks.delete(id);
            } else {
              // An unreadable old copy cannot go to the trash. It is kept in the quarantine.
              quarantineRecord(working, id, inspection.errors, now);
            }
            replacedIds.push(id);
          } else {
            addedIds.push(id);
          }
          putStack(working, id, {
            stack: seed.stack,
            savedAt: now - (seed.position ?? 0),
            origin: 'seed',
          });
        }
        const dropped = enforceTrashCap(working);
        working.meta.set(SEEDED_KEY, true);
        return ok({ replacedIds, addedIds, dropped });
      });
    },

    getMeta(key: MetaKey): Promise<Result<MetaValue | undefined>> {
      return read((current) => ok(current.meta.get(key)));
    },

    setMeta(key: MetaKey, value: MetaValue): Promise<Result<void>> {
      return transact((working) => {
        working.meta.set(key, value);
        return ok(undefined);
      });
    },

    close(): Promise<Result<void>> {
      return Promise.resolve(ok(undefined));
    },
  };

  const testing: MemoryRepositoryTesting = {
    putRawStack(record: unknown, key?: string): string {
      const stack = isObject(record) ? record.stack : undefined;
      const derived = isObject(stack) && typeof stack.id === 'string' ? stack.id : undefined;
      const storeKey = key ?? derived ?? `raw-${state.stacks.size + 1}`;
      state.stacks.set(storeKey, structuredClone(record));
      return storeKey;
    },
    rawStack(key: string): unknown {
      return structuredClone(state.stacks.get(key));
    },
    putTrashRecord(record: TrashRecord): number {
      const key = state.nextTrashKey;
      state.nextTrashKey += 1;
      state.trash.set(key, structuredClone(record));
      return key;
    },
    quarantine(): readonly QuarantineEntry[] {
      return [...state.quarantine.entries()].map(([key, value]) => ({
        key,
        record: structuredClone(value.record),
        errors: structuredClone(value.errors),
        quarantinedAt: value.quarantinedAt,
      }));
    },
  };

  return { ...repository, testing };
}
