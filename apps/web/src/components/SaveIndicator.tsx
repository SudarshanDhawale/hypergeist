import { usePersistenceInfo, useSaveState } from '../state/SaveStateContext.tsx';

/**
 * "Saved", "Saving" or "Not saved: <reason>", with an Export button when the browser's
 * storage is full. A polite live region without a role: the Hint_Line in the status bar
 * is the one `status` in the stack window. Renders nothing without a SaveStateProvider.
 */
export function SaveIndicator() {
  const state = useSaveState();
  const info = usePersistenceInfo();
  if (state === null || info === null) return null;

  const text =
    state.status === 'saved'
      ? 'Saved'
      : state.status === 'saving'
        ? 'Saving'
        : `Not saved: ${state.reason ?? 'unknown reason'}`;

  return (
    <div className="save-indicator-row">
      <p className="save-indicator" aria-live="polite">
        {text}
      </p>
      {state.canExport ? (
        <button type="button" onClick={info.onExport}>
          Export this stack
        </button>
      ) : null}
    </div>
  );
}
