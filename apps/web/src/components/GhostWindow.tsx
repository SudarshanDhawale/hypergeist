import type { JSX } from 'react';
import { GhostSprite } from './GhostSprite';

/** Inert placeholder that states honestly that AI is not here yet. */
export function GhostWindow(): JSX.Element {
  return (
    <aside
      className="window ghost-window"
      aria-label="Ghost is asleep. AI arrives in a later release."
    >
      <div className="title-bar">
        <h2>Ghost</h2>
      </div>
      <div className="ghost-body">
        <GhostSprite />
        <p className="ghost-text">AI arrives in a later release</p>
      </div>
    </aside>
  );
}
