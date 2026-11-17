import { useId } from 'react';
import type { JSX } from 'react';
import { useStackStore } from '../state/StackStoreContext.tsx';
import { Canvas } from './Canvas.tsx';
import { LinkBar } from './LinkBar.tsx';
import { MemoryModeBanner } from './MemoryModeBanner.tsx';
import { PropertyReadout } from './PropertyReadout.tsx';
import { SaveIndicator } from './SaveIndicator.tsx';
import { StatusBar } from './StatusBar.tsx';

/**
 * The one window of the slice, named by its title bar. There is no close or expand
 * box because there is nothing to close or expand. The not-saved notice shows on
 * every Card (Requirement 18.3). The Property_Readout renders itself in Edit and AI edit modes.
 */
export function StackWindow(): JSX.Element {
  const titleId = useId();
  const name = useStackStore((state) => state.stack.name);

  return (
    <section className="window stack-window" aria-labelledby={titleId}>
      <div className="title-bar">
        <h2 id={titleId}>{name}</h2>
      </div>
      <Canvas />
      <LinkBar />
      <MemoryModeBanner />
      <SaveIndicator />
      <PropertyReadout />
      <StatusBar />
    </section>
  );
}
