import { useId } from 'react';
import type { JSX } from 'react';
import type { EffectsNotice } from '../state/effects-store.ts';
import { useEffects, useEffectsStore } from '../state/EffectsContext.tsx';

function Notice({
  notice,
  onDismiss,
}: {
  readonly notice: EffectsNotice;
  readonly onDismiss: (id: string) => void;
}): JSX.Element {
  const textId = useId();
  return (
    <div className="reminder-notice">
      <p id={textId}>{notice.text}</p>
      <button type="button" aria-describedby={textId} onClick={() => onDismiss(notice.id)}>
        Dismiss
      </button>
    </div>
  );
}

function Notices(): JSX.Element {
  const notices = useEffectsStore((state) => state.notices);
  const dismissNotice = useEffectsStore((state) => state.dismissNotice);
  // The live region stays in the page when empty, so a new notice is announced.
  return (
    <div className="reminder-notices" aria-live="polite">
      {notices.map((notice) => (
        <Notice key={notice.id} notice={notice} onDismiss={dismissNotice} />
      ))}
    </div>
  );
}

/** In-app "reminder due" notices that stay until dismissed. Renders nothing without an EffectsProvider. */
export function ReminderNotices(): JSX.Element | null {
  return useEffects() === null ? null : <Notices />;
}
