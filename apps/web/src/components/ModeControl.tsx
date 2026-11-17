import type { JSX } from 'react';
import { useStackStore } from '../state/StackStoreContext.tsx';

const OPTIONS = [
  { mode: 'interact', label: 'Interact' },
  { mode: 'edit', label: 'Edit' },
  { mode: 'ai-edit', label: 'AI edit' },
] as const;

/**
 * Native radio group. The browser gives it one Tab stop and arrow-key switching,
 * and exposes the checked state with no custom ARIA.
 */
export function ModeControl(): JSX.Element {
  const mode = useStackStore((state) => state.mode);
  const setMode = useStackStore((state) => state.setMode);

  return (
    <div className="mode-control" role="radiogroup" aria-label="Mode">
      {OPTIONS.map((option) => (
        <label key={option.mode} className="mode-option">
          <input
            type="radio"
            name="mode"
            value={option.mode}
            checked={mode === option.mode}
            onChange={() => setMode(option.mode)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
