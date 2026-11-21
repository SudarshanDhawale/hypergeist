import type { Stack, ValidationError } from '@hypergeist/shared/format';

/** Result value for expected failures. Repositories never throw for these. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly PersistenceError[] };

export type PersistenceErrorCode =
  'INVALID_STACK' | 'ID_IN_USE' | 'NOT_FOUND' | 'QUOTA_EXCEEDED' | 'STORAGE_FAILED';

export type PersistenceError = {
  readonly code: PersistenceErrorCode;
  /** Plain-language message, safe to show to the user. */
  readonly message: string;
  /** Only set for `INVALID_STACK`. */
  readonly validationErrors?: readonly ValidationError[];
};

/** Where a stored stack came from: bundled demo set or the user. */
export type StackOrigin = 'seed' | 'user';

/** One stored stack. `savedAt` is milliseconds since the epoch, supplied by the caller. */
export type StackRecord = {
  readonly stack: Stack;
  readonly savedAt: number;
  readonly origin: StackOrigin;
};

/** A stack deleted by the user. `deletedAt` is milliseconds since the epoch, supplied by the caller. */
export type TrashRecord = StackRecord & {
  readonly deletedAt: number;
};

export type StackSummary = {
  readonly id: string;
  readonly name: string;
  readonly savedAt: number;
  readonly origin: StackOrigin;
};

export type TrashSummary = {
  /** Trash store key. The same stack id can be in the trash more than once. */
  readonly key: number;
  readonly id: string;
  readonly name: string;
  readonly deletedAt: number;
};

/** A stored record that failed `parseStack` and was moved, unchanged, to the quarantine. */
export type QuarantineProblem = {
  /** Key the record had in the `stacks` store. */
  readonly recordKey: string;
  /** Quarantine store key of the unchanged copy. */
  readonly quarantineKey: number;
  readonly errors: readonly ValidationError[];
};

export type ListResult = {
  readonly stacks: readonly StackSummary[];
  readonly problems: readonly QuarantineProblem[];
};

/** A bundled demo stack. The stack is already parsed with `parseStack`. */
export type SeedStack = {
  readonly stack: Stack;
  /**
   * Place in the demo list, 0 for the first. The stored `savedAt` is `now - position`, so the
   * list (newest first) shows the demo stacks in this order. Missing means 0.
   */
  readonly position?: number;
};

/** Returned by `save`, `create` and `restoreFromTrash`: the stored record's summary. */
export type SaveOutcome = StackSummary;

export type SeedOutcome = {
  /** False when seeding was not needed (already seeded, or stacks exist). */
  readonly seeded: boolean;
};

export type RestoreDemoOutcome = {
  /** Ids of seed stacks that replaced an existing stack. */
  readonly replacedIds: readonly string[];
  /** Ids of seed stacks that were missing and were added. */
  readonly addedIds: readonly string[];
  /** Trash records deleted because the trash exceeded its cap. */
  readonly dropped: readonly TrashSummary[];
};

export type MetaKey = string;
export type MetaValue = boolean | string;

export type Repository = {
  /** Lists valid stacks and quarantines invalid records. */
  list(now: number): Promise<Result<ListResult>>;
  /** Loads one stack. An invalid record is quarantined and an error is returned. */
  load(id: string): Promise<Result<Stack>>;
  /** Validates, then replaces the record with the same id (keeps its origin) or adds it with origin `user`. */
  save(stack: Stack, now: number): Promise<Result<SaveOutcome>>;
  /** Like `save`, but `ID_IN_USE` if the id exists. Origin is `user`. */
  create(stack: Stack, now: number): Promise<Result<SaveOutcome>>;
  /** Moves a stack to the trash in one transaction. Returns trash records dropped by the cap of 50. */
  moveToTrash(id: string, now: number): Promise<Result<readonly TrashSummary[]>>;
  /** Newest first. */
  listTrash(): Promise<Result<readonly TrashSummary[]>>;
  /** Moves a trash record back. If its id is in use, `newId` stores a remix; without it, `ID_IN_USE`. */
  restoreFromTrash(key: number, now: number, newId?: string): Promise<Result<SaveOutcome>>;
  deleteForever(key: number): Promise<Result<void>>;
  emptyTrash(): Promise<Result<void>>;
  /** Writes every seed and the seeding marker in one transaction, only if not seeded and no stacks exist. */
  seedIfNeeded(seeds: readonly SeedStack[], now: number): Promise<Result<SeedOutcome>>;
  /** Replaces seed stacks by id (old copy goes to the trash) and adds missing ones. Other ids stay untouched. */
  restoreDemo(seeds: readonly SeedStack[], now: number): Promise<Result<RestoreDemoOutcome>>;
  /** Returns `undefined` when the key is not set. */
  getMeta(key: MetaKey): Promise<Result<MetaValue | undefined>>;
  setMeta(key: MetaKey, value: MetaValue): Promise<Result<void>>;
  close(): Promise<Result<void>>;
};
