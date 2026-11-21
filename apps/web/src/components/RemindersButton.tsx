import { useCallback, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useEffects, useEffectsStore } from '../state/EffectsContext.tsx';
import { countOpenReminders, RemindersWindow } from './RemindersWindow.tsx';

function Button(): JSX.Element {
  const count = useEffectsStore((state) => countOpenReminders(state.reminders));
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    // Some browsers do not focus a button on click, so the window cannot rely on remembering it.
    buttonRef.current?.focus();
  }, []);

  return (
    <>
      <button ref={buttonRef} type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {`Reminders (${String(count)})`}
      </button>
      {open ? <RemindersWindow onClose={close} /> : null}
    </>
  );
}

/** Menu bar button with the number of pending and missed reminders. Renders nothing without an EffectsProvider. */
export function RemindersButton(): JSX.Element | null {
  return useEffects() === null ? null : <Button />;
}
