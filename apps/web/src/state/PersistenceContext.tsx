import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Stack } from '@hypergeist/shared/format';
import type { Repository, SeedStack } from '../persistence/types.ts';

/** What the Stacks window needs from the app: the repository and a few callbacks. */
export type PersistenceValue = {
  readonly repository: Repository;
  /** The bundled demo stacks, used by "Restore demo stacks". */
  readonly seeds: readonly SeedStack[];
  /** Id of the stack that is open now. */
  readonly openStackId: string;
  /** The clock. Called only when something is written. */
  readonly now: () => number;
  /**
   * Called with a stack the user opened, imported, created after deleting the last stack, or
   * reloaded after "Restore demo stacks" replaced the open one. The stack is already stored and
   * parsed. The same id can arrive again with different content, so the receiver must treat it
   * as a replacement of the open stack and not assume that a new id means a new stack.
   */
  readonly onOpenStack: (stack: Stack) => void;
  /** Called after every successful change to the stored stacks (not the trash alone). */
  readonly onStacksChanged?: () => void;
  /**
   * Awaited before every action that reads or changes the stored stacks, so edits that wait for
   * the autosave timer are written first. It must not reject; a rejection is ignored.
   */
  readonly beforeAction?: () => Promise<void>;
};

const PersistenceContext = createContext<PersistenceValue | null>(null);

/** Provides the repository and callbacks to the Stacks window. */
export function PersistenceProvider({
  repository,
  seeds,
  openStackId,
  now,
  onOpenStack,
  onStacksChanged,
  beforeAction,
  children,
}: PersistenceValue & { readonly children: ReactNode }) {
  const value = useMemo<PersistenceValue>(
    () => ({ repository, seeds, openStackId, now, onOpenStack, onStacksChanged, beforeAction }),
    [repository, seeds, openStackId, now, onOpenStack, onStacksChanged, beforeAction],
  );
  return <PersistenceContext.Provider value={value}>{children}</PersistenceContext.Provider>;
}

/** The persistence value, or `null` when there is no `PersistenceProvider`. */
export function usePersistence(): PersistenceValue | null {
  return useContext(PersistenceContext);
}
