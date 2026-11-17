import { useEffect } from 'react';
import { hintForMode } from '../state/hints.ts';
import type { Mode } from '../state/stack-store.ts';
import { useStackStore } from '../state/StackStoreContext.tsx';

const MODE_LABELS: Readonly<Record<Mode, string>> = {
  interact: 'Interact',
  edit: 'Edit',
  'ai-edit': 'AI edit',
};

/** How long a Status_Message replaces the hint (Requirement 15.2). */
const STATUS_MESSAGE_MS = 4000;

/**
 * "Card N of M", the Mode, and the Hint_Line. The Hint_Line is a polite live
 * region that stays mounted, so each change of text is announced.
 */
export function StatusBar() {
  const cardNumber = useStackStore(
    (state) => state.stack.cards.findIndex((card) => card.id === state.currentCardId) + 1,
  );
  const cardCount = useStackStore((state) => state.stack.cards.length);
  const mode = useStackStore((state) => state.mode);
  const status = useStackStore((state) => state.status);
  const expireStatus = useStackStore((state) => state.expireStatus);

  const seq = status === null ? null : status.seq;

  // Keyed on the message `seq`: a new message cleans up the old timer and restarts the period.
  useEffect(() => {
    if (seq === null) return undefined;
    const timer = setTimeout(() => {
      expireStatus(seq);
    }, STATUS_MESSAGE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [seq, expireStatus]);

  return (
    <footer className="status-bar" aria-label="Status">
      <span className="status-card">{`Card ${cardNumber} of ${cardCount}`}</span>
      <span className="status-mode">{`Mode: ${MODE_LABELS[mode]}`}</span>
      <p className="status-hint" role="status" aria-live="polite">
        {status === null ? hintForMode(mode) : status.text}
      </p>
    </footer>
  );
}
