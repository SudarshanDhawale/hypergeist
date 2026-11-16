import { useCallback, useRef, useState } from 'react';
import type { JSX } from 'react';
import { usePersistence } from '../state/PersistenceContext.tsx';
import { ModeControl } from './ModeControl.tsx';
import { SpiritGlyph } from './SpiritGlyph.tsx';
import { StacksWindow } from './StacksWindow.tsx';

/**
 * Always visible. The `h1` is the heading of the page. The Stacks button opens the Stacks
 * window and exists only when a PersistenceProvider is present.
 */
export function MenuBar(): JSX.Element {
  const persistence = usePersistence();
  const [stacksOpen, setStacksOpen] = useState(false);
  const stacksButtonRef = useRef<HTMLButtonElement>(null);

  const closeStacks = useCallback(() => {
    setStacksOpen(false);
    // Some browsers do not focus a button on click, so the window cannot rely on remembering it.
    stacksButtonRef.current?.focus();
  }, []);

  return (
    <header className="menu-bar" aria-label="Menu bar">
      <SpiritGlyph />
      <h1>HyperGeist</h1>
      <ModeControl />
      {persistence === null ? null : (
        <>
          <button
            ref={stacksButtonRef}
            type="button"
            aria-haspopup="dialog"
            onClick={() => setStacksOpen(true)}
          >
            Stacks
          </button>
          {stacksOpen ? <StacksWindow onClose={closeStacks} /> : null}
        </>
      )}
    </header>
  );
}
