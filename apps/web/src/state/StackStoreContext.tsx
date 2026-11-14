import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { Stack } from '@hypergeist/shared/format';
import { createStackStore } from './stack-store.ts';
import type { StackStore, StackStoreApi } from './stack-store.ts';

export const StackStoreContext = createContext<StackStoreApi | null>(null);

/** Creates the store once from the validated Stack and provides it to the tree. */
export function StackStoreProvider({
  stack,
  children,
}: {
  readonly stack: Stack;
  readonly children: ReactNode;
}) {
  const [store] = useState(() => createStackStore(stack));
  return <StackStoreContext.Provider value={store}>{children}</StackStoreContext.Provider>;
}

/** The store API for code that needs `getState`, for example event handlers and effects. */
export function useStackStoreApi(): StackStoreApi {
  const store = useContext(StackStoreContext);
  if (store === null) {
    throw new Error('useStackStore must be used inside StackStoreProvider.');
  }
  return store;
}

export function useStackStore<T>(selector: (state: StackStore) => T): T {
  return useStore(useStackStoreApi(), selector);
}
