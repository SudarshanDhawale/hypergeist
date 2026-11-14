import type { JSX } from 'react';
import { ModeControl } from './ModeControl.tsx';
import { SpiritGlyph } from './SpiritGlyph.tsx';

/** Always visible. The `h1` is the heading of the page. */
export function MenuBar(): JSX.Element {
  return (
    <header className="menu-bar" aria-label="Menu bar">
      <SpiritGlyph />
      <h1>HyperGeist</h1>
      <ModeControl />
    </header>
  );
}
