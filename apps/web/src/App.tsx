import { useMemo } from 'react';
import type { JSX } from 'react';
import { Desktop } from './components/Desktop.tsx';
import { LoadErrorScreen } from './components/LoadErrorScreen.tsx';
import { StackStoreProvider } from './state/StackStoreContext.tsx';
import { loadStack } from './stacks/load-stack.ts';
import demoStackText from './stacks/thin-slice-todo.json?raw';

/**
 * Loads and validates the Stack text, then shows the Desktop or the error screen.
 * `stackText` defaults to the bundled Demo_Stack; tests pass invalid text.
 */
export function App({ stackText = demoStackText }: { readonly stackText?: string }): JSX.Element {
  const loaded = useMemo(() => loadStack(stackText), [stackText]);
  if (!loaded.ok) {
    return <LoadErrorScreen errors={loaded.errors} />;
  }
  return (
    <StackStoreProvider stack={loaded.stack}>
      <Desktop />
    </StackStoreProvider>
  );
}
