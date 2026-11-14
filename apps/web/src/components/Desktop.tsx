import { useEffect } from 'react';
import type { JSX } from 'react';
import { useStackStoreApi } from '../state/StackStoreContext.tsx';
import { GhostWindow } from './GhostWindow.tsx';
import { MenuBar } from './MenuBar.tsx';
import { StackWindow } from './StackWindow.tsx';

/**
 * The desktop grid: menu bar, the Stack_Window, and a right-hand rail with the Ghost.
 * Global keys: Alt+M toggles the Mode, Escape clears the Selection (the store ignores
 * it outside Edit mode).
 */
export function Desktop(): JSX.Element {
  const store = useStackStoreApi();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.altKey && event.code === 'KeyM') {
        event.preventDefault();
        store.getState().toggleMode();
      } else if (event.key === 'Escape') {
        store.getState().clearSelection();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [store]);

  return (
    <div className="desktop">
      <MenuBar />
      <main className="desktop-main">
        <StackWindow />
      </main>
      <aside className="rail">
        <GhostWindow />
      </aside>
    </div>
  );
}
