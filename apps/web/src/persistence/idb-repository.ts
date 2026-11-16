import { wrap } from 'idb';
import type { DBSchema, IDBPDatabase, IDBPObjectStore, IDBPTransaction, StoreNames } from 'idb';
import { createValidationError, parseStack, validateStack } from '@hypergeist/shared/format';
import type { Stack, ValidationError } from '@hypergeist/shared/format';
import { remixStack } from '@hypergeist/shared/engine';

import type { QuarantineEntry } from './memory-repository.ts';
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

/** Schema version of the database. Raise it and add a step to `upgrade` to change the record shape. */
export const DB_VERSION = 1;

/** Name used when `openIdbRepository` is called without a `name`. */
export const DEFAULT_DB_NAME = 'hypergeist';

/** Most trash records kept. Same value as `DEFAULT_TRASH_CAP` in `memory-repository.ts`. */
const TRASH_CAP = 50;

/** Name of the meta key that marks a database as seeded. Same as in `memory-repository.ts`. */
const SEEDED_KEY = 'seeded';

const QUOTA_MESSAGE = "The browser's storage is full.";
const FAILED_MESSAGE = 'Your stacks could not be stored in this browser.';

/** What is stored in the `quarantine` store: the unchanged record and why it was set aside. */
type QuarantineValue = Omit<QuarantineEntry, 'key'>;

/**
 * Object stores of the database. Values are `unknown` on purpose: whatever is stored can be
 * damaged, so every read goes through `inspect` or `parseStack` before it is trusted.
 */
export interface HyperGeistDB extends DBSchema {
  /** Key path `stack.id`. Value: `StackRecord`. */
  stacks: { key: string; value: unknown };
  /** Auto-increment key. Value: `TrashRecord`. */
  trash: { key: number; value: unknown };
  /** Auto-increment key. Value: `QuarantineValue`. */
  quarantine: { key: number; value: QuarantineValue };
  /** Out-of-line string keys. */
  meta: { key: string; value: MetaValue };
}

type ReadMode = 'readonly' | 'readwrite';
type StoreList = StoreNames<HyperGeistDB>[];
type Tx<Names extends StoreList, Mode extends ReadMode> = IDBPTransaction<
  HyperGeistDB,
  Names,
  Mode
>;
type Store<Name extends StoreNames<HyperGeistDB>> = IDBPObjectStore<
  HyperGeistDB,
  StoreList,
  Name,
  'readwrite'
>;

/**
 * Creates the object stores. Runs inside the version change transaction.
 * Version 0 means the database did not exist. A later release adds an `if (oldVersion < 2)`
 * step below the first one.
 */
export function upgrade(db: IDBPDatabase<HyperGeistDB>, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore('stacks', { keyPath: 'stack.id' });
    db.createObjectStore('trash', { autoIncrement: true });
    db.createObjectStore('quarantine', { autoIncrement: true });
    db.createObjectStore('meta');
  }
}

/** A way for a test to make the next write fail. See `IdbRepositoryTesting.failNextWrite`. */
export type FailNextWriteOptions = {
  /** Writes that succeed before the failing one. Default 1, so at least one record is written first. */
  readonly afterPuts?: number;
  /**
   * `clone` (default): the failing write receives a value holding a function, so IndexedDB
   * throws a real `DataCloneError`. `quota`: the failing write throws a `QuotaExceededError`.
   */
  readonly kind?: 'clone' | 'quota';
};

/**
 * Test-only hooks. Production code must not use them: they bypass validation on purpose so a
 * test can place bad data in the store. Unlike the memory twin's hooks, these are async.
 * They reject when the browser's storage refuses the call.
 */
export type IdbRepositoryTesting = {
  /**
   * Writes `record` into the `stacks` store exactly as given, with no validation. The key is
   * `record.stack.id` (the key path), so a record without a usable `stack.id` rejects.
   */
  putRawStack(record: unknown): Promise<void>;
  /** Returns the raw record stored under `key` in `stacks`, or `undefined`. */
  rawStack(key: string): Promise<unknown>;
  /** Adds a trash record as given (no validation). Returns its trash key. */
  putTrashRecord(record: TrashRecord): Promise<number>;
  /** Returns every quarantine entry, oldest first. */
  quarantine(): Promise<readonly QuarantineEntry[]>;
  /**
   * Arms one failure. The next method that writes (`put` or `add`) lets `afterPuts` writes
   * through, then fails the next one: the method returns a failure result and the whole
   * transaction is aborted, so nothing it wrote stays. Use it with `seedIfNeeded` or
   * `restoreDemo` to prove the rollback, and with `afterPuts: 0` and `kind: 'quota'` to
   * see `QUOTA_EXCEEDED`. A method that writes nothing does not use up the failure. The
   * failure is cleared after the first method that wrote something, even if it never fired.
   */
  failNextWrite(options?: FailNextWriteOptions): void;
};

export type IdbRepository = Repository & { readonly testing: IdbRepositoryTesting };

export type OpenIdbRepositoryOptions = {
  /** Database name. Defaults to `'hypergeist'`. */
  readonly name?: string;
  /** IndexedDB factory. Defaults to the global `indexedDB`. `idb` still needs the global IDB classes. */
  readonly indexedDB?: IDBFactory;
  /** Called when another tab keeps an older connection open and stops this one from upgrading. */
  readonly onBlocked?: () => void;
  /** Called when this connection stops another tab from upgrading. The connection is closed first. */
  readonly onBlocking?: () => void;
};

type Inspection =
  | { readonly ok: true; readonly record: StackRecord }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

type Failure = { readonly ok: false; readonly errors: readonly PersistenceError[] };

type Session = { writes: number };

type FailPlan = { remaining: number; readonly kind: 'clone' | 'quota' };

type RawEntry = { readonly key: number; readonly raw: unknown };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail(
  code: PersistenceErrorCode,
  message: string,
  validationErrors?: readonly ValidationError[],
): Failure {
  const error: PersistenceError =
    validationErrors === undefined ? { code, message } : { code, message, validationErrors };
  return { ok: false, errors: [error] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrigin(value: unknown): value is StackOrigin {
  return value === 'seed' || value === 'user';
}

function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }
  return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** Maps a storage error to a result. Never shows the error's own text, which may be technical. */
function failureOf(error: unknown, transactionError?: unknown): Failure {
  if (isQuotaError(error) || isQuotaError(transactionError)) {
    return fail('QUOTA_EXCEEDED', QUOTA_MESSAGE);
  }
  return fail('STORAGE_FAILED', FAILED_MESSAGE);
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
 * store key equals the stack id. Same rules as the memory repository. The result holds fresh
 * copies, never the stored objects.
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

/** Existing origin of a stored record, or `user` when the record has none that is valid. */
function originOf(raw: unknown): StackOrigin {
  return isObject(raw) && isOrigin(raw.origin) ? raw.origin : 'user';
}

/** Time a trash record was deleted. A damaged record counts as oldest (0), so the cap drops it first. */
function deletedAtOf(raw: unknown): number {
  return isObject(raw) && typeof raw.deletedAt === 'number' && Number.isFinite(raw.deletedAt)
    ? raw.deletedAt
    : 0;
}

/** Summary of a trash record, or `undefined` when it has no readable id, name and time. */
function trashSummaryOf(entry: RawEntry): TrashSummary | undefined {
  const { key, raw } = entry;
  if (!isObject(raw) || !isObject(raw.stack)) {
    return undefined;
  }
  const { id, name } = raw.stack;
  if (typeof id !== 'string' || typeof name !== 'string') {
    return undefined;
  }
  if (typeof raw.deletedAt !== 'number' || !Number.isFinite(raw.deletedAt)) {
    return undefined;
  }
  return { key, id, name, deletedAt: raw.deletedAt };
}

/** Summary used for records dropped by the cap, readable or not. */
function droppedSummaryOf(entry: RawEntry): TrashSummary {
  return (
    trashSummaryOf(entry) ?? {
      key: entry.key,
      id: '',
      name: '',
      deletedAt: deletedAtOf(entry.raw),
    }
  );
}

function isTrashKey(key: unknown): key is number {
  return typeof key === 'number' && !Number.isNaN(key);
}

function seedLabel(seed: SeedStack, index: number): string {
  const id: unknown = isObject(seed.stack) ? seed.stack.id : undefined;
  return typeof id === 'string' ? `"${id}"` : `number ${index + 1}`;
}

/** Validates every seed. Returns the failure to report, or `undefined` when all are fine. */
function checkSeeds(seeds: readonly SeedStack[]): Failure | undefined {
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

/** A value IndexedDB cannot clone, built from `value`. Used only by the failure hook. */
function poisoned(value: unknown): unknown {
  const poison = (): undefined => undefined;
  return isObject(value) ? { ...value, poison } : poison;
}

/** Aborts a transaction, ignoring the error when it has already finished. */
function abortQuietly(tx: { abort(): void }): void {
  try {
    tx.abort();
  } catch {
    // The transaction was already finished or aborted. Nothing is left to undo.
  }
}

/** Reads every key and value of a store in one snapshot. Both requests belong to one transaction. */
async function entriesOf(store: {
  getAllKeys(): Promise<IDBValidKey[]>;
  getAll(): Promise<unknown[]>;
}): Promise<RawEntry[]> {
  const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()]);
  const entries: RawEntry[] = [];
  for (const [index, key] of keys.entries()) {
    if (typeof key === 'number') {
      entries.push({ key, raw: values[index] });
    }
  }
  return entries;
}

/** Opens the database with a given factory. Same steps as `openDB` from `idb`, which only uses the global. */
function openWith(
  factory: IDBFactory,
  name: string,
  callbacks: { onBlocked?: () => void },
): Promise<IDBPDatabase<HyperGeistDB>> {
  const request = factory.open(name, DB_VERSION);
  const opened = wrap(request) as Promise<IDBPDatabase<HyperGeistDB>>;
  request.addEventListener('upgradeneeded', (event) => {
    upgrade(wrap(request.result) as IDBPDatabase<HyperGeistDB>, event.oldVersion);
  });
  request.addEventListener('blocked', () => {
    callbacks.onBlocked?.();
  });
  return opened;
}

/**
 * Opens (and if needed creates or upgrades) the database and returns a repository over it.
 * Rejects when the database cannot be opened; the caller then switches to Memory_Mode.
 * Every other method returns a result and never throws for expected failures.
 *
 * Each method uses one transaction over only the stores it needs, so a failure leaves nothing
 * half written. Time comes from the callers (`now`). Nothing here reads a clock or uses
 * randomness. Anything read from IndexedDB is treated as untrusted and parsed.
 *
 * Same observable behavior as `createMemoryRepository`, with these differences that cannot
 * be avoided: `problems` of `list` come in store-key order (not insertion order), and a
 * store record needs a usable `stack.id` to exist at all (the key path).
 */
export async function openIdbRepository(
  options: OpenIdbRepositoryOptions = {},
): Promise<IdbRepository> {
  const name = options.name ?? DEFAULT_DB_NAME;
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (factory === undefined) {
    throw new Error('IndexedDB is not available in this browser.');
  }

  let closedMessage: string | undefined;
  const connection = await openWith(factory, name, { onBlocked: options.onBlocked });
  connection.addEventListener('versionchange', () => {
    // Another tab wants to upgrade. Close so it can, and say so on later calls.
    closedMessage = 'Storage was closed so another tab can update it. Reload the page.';
    connection.close();
    options.onBlocking?.();
  });
  connection.addEventListener('close', () => {
    closedMessage ??= 'The browser closed the connection to storage. Reload the page.';
  });

  let failPlan: FailPlan | undefined;

  /**
   * Called with every value just before it is written by a counted `put` or `add`. Returns
   * the value to write, or throws when the failure hook says so.
   */
  function counted<T>(session: Session, value: T): T {
    session.writes += 1;
    const plan = failPlan;
    if (plan === undefined) {
      return value;
    }
    if (plan.remaining > 0) {
      plan.remaining -= 1;
      return value;
    }
    failPlan = undefined;
    if (plan.kind === 'quota') {
      throw new DOMException('The storage quota was exceeded.', 'QuotaExceededError');
    }
    // Deliberately not a `T`: the point is that IndexedDB refuses to clone it.
    return poisoned(value) as T;
  }

  /**
   * Runs `work` in one transaction. The transaction commits when `work` returns `ok` and is
   * aborted (nothing written) when it returns a failure or throws. Never throws.
   * `work` may only await IndexedDB requests, or the transaction would close under it.
   */
  async function run<Names extends StoreList, Mode extends ReadMode, T>(
    names: Names,
    mode: Mode,
    work: (tx: Tx<Names, Mode>, session: Session) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (closedMessage !== undefined) {
      return fail('STORAGE_FAILED', closedMessage);
    }
    const session: Session = { writes: 0 };
    let tx: Tx<Names, Mode>;
    try {
      tx = connection.transaction(names, mode);
    } catch (error) {
      return failureOf(error);
    }
    // The done promise rejects on every abort. Mark it handled; the outcome is read below.
    tx.done.catch(() => undefined);
    try {
      const result = await work(tx, session);
      if (!result.ok) {
        abortQuietly(tx);
        return result;
      }
      await tx.done;
      return result;
    } catch (error) {
      abortQuietly(tx);
      return failureOf(error, tx.error);
    } finally {
      if (session.writes > 0) {
        failPlan = undefined;
      }
    }
  }

  /** Moves a stored record that cannot be read to the quarantine, unchanged. Returns its quarantine key. */
  async function quarantineRaw(
    tx: { objectStore(name: 'quarantine'): Store<'quarantine'> },
    session: Session,
    raw: unknown,
    errors: readonly ValidationError[],
    now: number,
  ): Promise<number> {
    const value: QuarantineValue = { record: raw, errors, quarantinedAt: now };
    return tx.objectStore('quarantine').add(counted(session, value));
  }

  async function addToTrash(
    store: Store<'trash'>,
    session: Session,
    record: StackRecord,
    now: number,
  ): Promise<void> {
    await store.add(counted(session, { ...record, deletedAt: now }));
  }

  /** Deletes the oldest trash records beyond the cap. Oldest = lowest `deletedAt`, then lowest key. */
  async function enforceTrashCap(store: Store<'trash'>): Promise<readonly TrashSummary[]> {
    const entries = await entriesOf(store);
    const excess = entries.length - TRASH_CAP;
    if (excess <= 0) {
      return [];
    }
    const oldestFirst = [...entries].sort(
      (a, b) => deletedAtOf(a.raw) - deletedAtOf(b.raw) || a.key - b.key,
    );
    const dropped: TrashSummary[] = [];
    for (const entry of oldestFirst.slice(0, excess)) {
      dropped.push(droppedSummaryOf(entry));
      await store.delete(entry.key);
    }
    return dropped;
  }

  const repository: Repository = {
    list(now: number): Promise<Result<ListResult>> {
      return run(['stacks', 'quarantine'], 'readwrite', async (tx, session) => {
        const stacksStore = tx.objectStore('stacks');
        const [keys, values] = await Promise.all([stacksStore.getAllKeys(), stacksStore.getAll()]);
        const stacks: StackSummary[] = [];
        const problems: QuarantineProblem[] = [];
        for (const [index, storeKey] of keys.entries()) {
          const raw: unknown = values[index];
          const recordKey = String(storeKey);
          const inspection = inspect(recordKey, raw);
          if (inspection.ok) {
            stacks.push(summaryOf(inspection.record));
          } else {
            const quarantineKey = await quarantineRaw(tx, session, raw, inspection.errors, now);
            await stacksStore.delete(storeKey);
            problems.push({ recordKey, quarantineKey, errors: inspection.errors });
          }
        }
        stacks.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return ok({ stacks, problems });
      });
    },

    load(id: string): Promise<Result<Stack>> {
      return run(['stacks'], 'readonly', async (tx) => {
        const raw: unknown = await tx.objectStore('stacks').get(id);
        if (raw === undefined) {
          return fail('NOT_FOUND', 'That stack was not found.');
        }
        const inspection = inspect(id, raw);
        if (!inspection.ok) {
          return fail('INVALID_STACK', 'That stack could not be read.', inspection.errors);
        }
        return ok(inspection.record.stack);
      });
    },

    async save(stack: Stack, now: number): Promise<Result<SaveOutcome>> {
      const checked = validateStack(stack);
      if (!checked.valid) {
        return fail(
          'INVALID_STACK',
          'This stack is not valid, so it was not saved.',
          checked.errors,
        );
      }
      return run(['stacks', 'quarantine'], 'readwrite', async (tx, session) => {
        const store = tx.objectStore('stacks');
        const existing: unknown = await store.get(stack.id);
        if (existing !== undefined) {
          const inspection = inspect(stack.id, existing);
          if (!inspection.ok) {
            // The old record cannot be read. Keep it in the quarantine before it is replaced.
            await quarantineRaw(tx, session, existing, inspection.errors, now);
          }
        }
        const record: StackRecord = { stack, savedAt: now, origin: originOf(existing) };
        await store.put(counted(session, record));
        return ok(summaryOf(record));
      });
    },

    async create(stack: Stack, now: number): Promise<Result<SaveOutcome>> {
      const checked = validateStack(stack);
      if (!checked.valid) {
        return fail(
          'INVALID_STACK',
          'This stack is not valid, so it was not saved.',
          checked.errors,
        );
      }
      return run(['stacks'], 'readwrite', async (tx, session) => {
        const store = tx.objectStore('stacks');
        if ((await store.getKey(stack.id)) !== undefined) {
          return fail('ID_IN_USE', `A stack with the id "${stack.id}" already exists.`);
        }
        const record: StackRecord = { stack, savedAt: now, origin: 'user' };
        await store.put(counted(session, record));
        return ok(summaryOf(record));
      });
    },

    moveToTrash(id: string, now: number): Promise<Result<readonly TrashSummary[]>> {
      return run(['stacks', 'trash'], 'readwrite', async (tx, session) => {
        const stacksStore = tx.objectStore('stacks');
        const raw: unknown = await stacksStore.get(id);
        if (raw === undefined) {
          return fail('NOT_FOUND', 'That stack was not found.');
        }
        const inspection = inspect(id, raw);
        if (!inspection.ok) {
          // The record stays where it is; the next list() moves it to the quarantine.
          return fail('INVALID_STACK', 'That stack could not be read.', inspection.errors);
        }
        await stacksStore.delete(id);
        const trashStore = tx.objectStore('trash');
        await addToTrash(trashStore, session, inspection.record, now);
        return ok(await enforceTrashCap(trashStore));
      });
    },

    listTrash(): Promise<Result<readonly TrashSummary[]>> {
      return run(['trash'], 'readonly', async (tx) => {
        const entries = await entriesOf(tx.objectStore('trash'));
        const summaries: TrashSummary[] = [];
        for (const entry of entries) {
          const summary = trashSummaryOf(entry);
          if (summary !== undefined) {
            summaries.push(summary);
          }
        }
        summaries.sort((a, b) => b.deletedAt - a.deletedAt || b.key - a.key);
        return ok(summaries);
      });
    },

    restoreFromTrash(key: number, now: number, newId?: string): Promise<Result<SaveOutcome>> {
      return run(['stacks', 'trash'], 'readwrite', async (tx, session) => {
        if (!isTrashKey(key)) {
          return fail('NOT_FOUND', 'That item is not in the trash.');
        }
        const trashStore = tx.objectStore('trash');
        const trashed: unknown = await trashStore.get(key);
        if (trashed === undefined) {
          return fail('NOT_FOUND', 'That item is not in the trash.');
        }
        // Trash records are parsed again before they come back. An invalid one stays in the trash.
        const parsed = parseStack(structuredClone(isObject(trashed) ? trashed.stack : undefined));
        if (!parsed.ok) {
          return fail('INVALID_STACK', 'That stack could not be read.', parsed.errors);
        }
        const stacksStore = tx.objectStore('stacks');
        let record: StackRecord;
        if ((await stacksStore.getKey(parsed.value.id)) === undefined) {
          record = { stack: parsed.value, savedAt: now, origin: originOf(trashed) };
        } else if (newId === undefined) {
          return fail('ID_IN_USE', `A stack with the id "${parsed.value.id}" already exists.`);
        } else {
          const remixed = remixStack(parsed.value, newId);
          if (!remixed.ok) {
            return fail('INVALID_STACK', 'The new id is not valid.', remixed.errors);
          }
          if ((await stacksStore.getKey(newId)) !== undefined) {
            return fail('ID_IN_USE', `A stack with the id "${newId}" already exists.`);
          }
          // A copy under a new id is a new stack of the user, not a bundled demo stack.
          record = { stack: remixed.stack, savedAt: now, origin: 'user' };
        }
        await stacksStore.put(counted(session, record));
        await trashStore.delete(key);
        return ok(summaryOf(record));
      });
    },

    deleteForever(key: number): Promise<Result<void>> {
      // Deleting a key that is not there is not an error: the record is gone either way.
      return run(['trash'], 'readwrite', async (tx) => {
        if (isTrashKey(key)) {
          await tx.objectStore('trash').delete(key);
        }
        return ok(undefined);
      });
    },

    emptyTrash(): Promise<Result<void>> {
      return run(['trash'], 'readwrite', async (tx) => {
        await tx.objectStore('trash').clear();
        return ok(undefined);
      });
    },

    seedIfNeeded(seeds: readonly SeedStack[], now: number): Promise<Result<SeedOutcome>> {
      return run<['stacks', 'meta'], 'readwrite', SeedOutcome>(
        ['stacks', 'meta'],
        'readwrite',
        async (tx, session) => {
          const stacksStore = tx.objectStore('stacks');
          const metaStore = tx.objectStore('meta');
          const seeded = await metaStore.get(SEEDED_KEY);
          if (seeded === true || (await stacksStore.count()) > 0) {
            return ok({ seeded: false });
          }
          const rejected = checkSeeds(seeds);
          if (rejected !== undefined) {
            return rejected;
          }
          for (const seed of seeds) {
            const record: StackRecord = { stack: seed.stack, savedAt: now, origin: 'seed' };
            await stacksStore.put(counted(session, record));
          }
          await metaStore.put(counted(session, true), SEEDED_KEY);
          return ok({ seeded: true });
        },
      );
    },

    restoreDemo(seeds: readonly SeedStack[], now: number): Promise<Result<RestoreDemoOutcome>> {
      return run(['stacks', 'trash', 'quarantine', 'meta'], 'readwrite', async (tx, session) => {
        const rejected = checkSeeds(seeds);
        if (rejected !== undefined) {
          return rejected;
        }
        const stacksStore = tx.objectStore('stacks');
        const trashStore = tx.objectStore('trash');
        const replacedIds: string[] = [];
        const addedIds: string[] = [];
        for (const seed of seeds) {
          const id = seed.stack.id;
          const existing: unknown = await stacksStore.get(id);
          if (existing !== undefined) {
            const inspection = inspect(id, existing);
            if (inspection.ok) {
              await addToTrash(trashStore, session, inspection.record, now);
            } else {
              // An unreadable old copy cannot go to the trash. It is kept in the quarantine.
              await quarantineRaw(tx, session, existing, inspection.errors, now);
            }
            replacedIds.push(id);
          } else {
            addedIds.push(id);
          }
          const record: StackRecord = { stack: seed.stack, savedAt: now, origin: 'seed' };
          await stacksStore.put(counted(session, record));
        }
        const dropped = await enforceTrashCap(trashStore);
        await tx.objectStore('meta').put(counted(session, true), SEEDED_KEY);
        return ok({ replacedIds, addedIds, dropped });
      });
    },

    getMeta(key: MetaKey): Promise<Result<MetaValue | undefined>> {
      return run(['meta'], 'readonly', async (tx) => {
        const value: unknown = await tx.objectStore('meta').get(key);
        return ok(typeof value === 'boolean' || typeof value === 'string' ? value : undefined);
      });
    },

    setMeta(key: MetaKey, value: MetaValue): Promise<Result<void>> {
      return run(['meta'], 'readwrite', async (tx, session) => {
        await tx.objectStore('meta').put(counted(session, value), key);
        return ok(undefined);
      });
    },

    close(): Promise<Result<void>> {
      try {
        closedMessage ??= 'The storage connection is closed.';
        connection.close();
        return Promise.resolve(ok(undefined));
      } catch (error) {
        return Promise.resolve(failureOf(error));
      }
    },
  };

  const testing: IdbRepositoryTesting = {
    async putRawStack(record: unknown): Promise<void> {
      await connection.put('stacks', record);
    },
    async rawStack(key: string): Promise<unknown> {
      return connection.get('stacks', key);
    },
    async putTrashRecord(record: TrashRecord): Promise<number> {
      return connection.add('trash', record);
    },
    async quarantine(): Promise<readonly QuarantineEntry[]> {
      const entries = await entriesOf(connection.transaction('quarantine').store);
      return entries.map(({ key, raw }) => {
        const value = raw as QuarantineValue;
        return {
          key,
          record: value.record,
          errors: value.errors,
          quarantinedAt: value.quarantinedAt,
        };
      });
    },
    failNextWrite(failOptions: FailNextWriteOptions = {}): void {
      failPlan = { remaining: failOptions.afterPuts ?? 1, kind: failOptions.kind ?? 'clone' };
    },
  };

  return { ...repository, testing };
}
