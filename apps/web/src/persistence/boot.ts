import { createStack } from '@hypergeist/shared/engine';
import type { Stack } from '@hypergeist/shared/format';

import { createMemoryRepository } from './memory-repository.ts';
import { openRepository as openRealRepository } from './open-repository.ts';
import type { OpenedRepository } from './open-repository.ts';
import { loadSeedSet } from './seed-set.ts';
import type { SeedProblem, SeedSet } from './seed-set.ts';
import type { QuarantineProblem, Repository, StackSummary } from './types.ts';

/** Id of the stack created when the database holds no usable stack and the caller gave none. */
export const DEFAULT_NEW_STACK_ID = 'my-stack';

/** Name of the stack created when the database holds no usable stack. */
export const NEW_STACK_NAME = 'My stack';

/** Meta key that remembers the stack that was open last. Written by the UI, read here. */
export const LAST_OPENED_KEY = 'lastOpenedId';

/** Reason shown when a repository that opened fine fails to seed, list or store. */
export const STORAGE_FAILED_REASON =
  'This browser stopped storing your stacks, so they are kept in memory for now.';

export type BootOptions = {
  /** Milliseconds since the epoch. Used for the seeding and fresh-stack timestamps. */
  readonly now: number;
  /** Id for a fresh stack when none exists. Defaults to `my-stack`. */
  readonly newStackId?: string;
  /** Opens the repository. Defaults to the real `openRepository()`. */
  readonly openRepository?: () => Promise<OpenedRepository>;
  /** The demo stacks. Defaults to `loadSeedSet()`. */
  readonly seedSet?: SeedSet;
};

export type BootResult = {
  readonly repository: Repository;
  readonly mode: 'indexeddb' | 'memory';
  /** Plain-words explanation. Only set when `mode` is `memory`. Never contains exception text. */
  readonly reason?: string;
  /** Valid stacks, newest `savedAt` first. Includes the initial stack. */
  readonly summaries: readonly StackSummary[];
  /** Stored records that were moved to the quarantine while booting. */
  readonly problems: readonly QuarantineProblem[];
  /** Bundled demo files that were skipped. */
  readonly seedProblems: readonly SeedProblem[];
  /** The stack to open. */
  readonly initial: Stack;
};

type Booted = {
  readonly summaries: readonly StackSummary[];
  readonly problems: readonly QuarantineProblem[];
  readonly initial: Stack;
};

/** `{ ok: false }` means "this repository cannot be used": the caller switches to memory. */
type Attempt = { readonly ok: true; readonly value: Booted } | { readonly ok: false };

const FAILED: Attempt = { ok: false };

/** A fresh one-card stack. Fixed, valid parameters, so a failure is a programmer error. */
function freshStack(id: string): Stack {
  const made = createStack({ id, name: NEW_STACK_NAME });
  if (made.ok) {
    return made.stack;
  }
  const fallback = createStack({ id: DEFAULT_NEW_STACK_ID, name: NEW_STACK_NAME });
  if (!fallback.ok) {
    throw new Error('createStack rejected its fixed default parameters.');
  }
  return fallback.stack;
}

/**
 * Seeds, lists and picks the stack to open on one repository. Returns `{ ok: false }` when the
 * storage itself fails (any error result from seeding, listing, creating, or a storage error
 * while loading). Records that only fail validation are skipped.
 */
async function bootOn(
  repository: Repository,
  seedSet: SeedSet,
  now: number,
  newStackId: string,
): Promise<Attempt> {
  const seeded = await repository.seedIfNeeded(seedSet.stacks, now);
  if (!seeded.ok) {
    return FAILED;
  }
  const listed = await repository.list(now);
  if (!listed.ok) {
    return FAILED;
  }
  let { stacks: summaries, problems } = listed.value;

  const lastOpened = await repository.getMeta(LAST_OPENED_KEY);
  const lastId =
    lastOpened.ok && typeof lastOpened.value === 'string' ? lastOpened.value : undefined;
  const ids = summaries.map((summary) => summary.id);
  const order =
    lastId !== undefined && ids.includes(lastId)
      ? [lastId, ...ids.filter((id) => id !== lastId)]
      : ids;

  let initial: Stack | undefined;
  let changed = false;
  for (const id of order) {
    const loaded = await repository.load(id);
    if (loaded.ok) {
      initial = loaded.value;
      break;
    }
    if (loaded.errors.some((error) => error.code === 'STORAGE_FAILED')) {
      return FAILED;
    }
    // The record was invalid and has been quarantined by `load`; the lists below are stale.
    changed = true;
  }

  if (initial === undefined) {
    const stack = freshStack(newStackId);
    const created = await repository.create(stack, now);
    if (!created.ok) {
      return FAILED;
    }
    initial = stack;
    changed = true;
  }

  if (changed) {
    const relisted = await repository.list(now);
    if (!relisted.ok) {
      return FAILED;
    }
    summaries = relisted.value.stacks;
    problems = [...problems, ...relisted.value.problems];
  }

  return { ok: true, value: { summaries, problems, initial } };
}

/** `bootOn` that turns a thrown error from an injected repository into a failed attempt. */
async function safeBootOn(
  repository: Repository,
  seedSet: SeedSet,
  now: number,
  newStackId: string,
): Promise<Attempt> {
  try {
    return await bootOn(repository, seedSet, now, newStackId);
  } catch {
    return FAILED;
  }
}

async function safeOpen(open: () => Promise<OpenedRepository>): Promise<OpenedRepository> {
  try {
    return await open();
  } catch {
    return {
      repository: createMemoryRepository(),
      mode: 'memory',
      reason: STORAGE_FAILED_REASON,
    };
  }
}

function safeClose(repository: Repository): void {
  try {
    void repository.close().catch(() => undefined);
  } catch {
    // Nothing to do: the repository is being abandoned.
  }
}

/**
 * Opens the repository, seeds the demo stacks once, and picks the stack to show first.
 * Never throws or rejects.
 *
 * The first stack is the one saved under the meta key `lastOpenedId`, else the first stack in
 * the list (newest `savedAt`), else a fresh one-card stack that is stored first. A stack that
 * fails to load is skipped. If the repository fails while seeding, listing or creating, the app
 * switches to a memory repository that is seeded the same way (`mode: 'memory'`).
 *
 * Boot never writes `lastOpenedId`; the UI does that when the user opens a stack.
 */
export async function bootPersistence(options: BootOptions): Promise<BootResult> {
  const { now } = options;
  const newStackId = options.newStackId ?? DEFAULT_NEW_STACK_ID;
  const seedSet = options.seedSet ?? loadSeedSet();
  const opened = await safeOpen(options.openRepository ?? (() => openRealRepository()));
  const seedProblems = seedSet.problems;

  const first = await safeBootOn(opened.repository, seedSet, now, newStackId);
  if (first.ok) {
    return {
      repository: opened.repository,
      mode: opened.mode,
      ...(opened.reason === undefined ? {} : { reason: opened.reason }),
      ...first.value,
      seedProblems,
    };
  }

  // The storage opened but cannot be used. Keep the app working in memory.
  safeClose(opened.repository);
  const memory = createMemoryRepository();
  const reason = opened.reason ?? STORAGE_FAILED_REASON;
  const second = await safeBootOn(memory, seedSet, now, newStackId);
  if (second.ok) {
    return { repository: memory, mode: 'memory', reason, ...second.value, seedProblems };
  }

  // The memory repository only fails if something is badly wrong. Still give the UI a stack.
  return {
    repository: memory,
    mode: 'memory',
    reason,
    summaries: [],
    problems: [],
    seedProblems,
    initial: freshStack(newStackId),
  };
}
