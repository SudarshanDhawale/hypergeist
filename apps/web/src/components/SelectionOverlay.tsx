import type { StackObject } from '@hypergeist/shared/format';
import { objectCssVars } from '../lib/css-vars.ts';

/** Handle positions, clockwise from the top left. The CSS places each one by its index. */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

/**
 * The dashed outline and the 8 resize handles around the selected Object.
 * Purely visual: it is hidden from assistive technology, takes no pointer events,
 * and starts no drag or resize.
 */
export function SelectionOverlay({ object }: { readonly object: StackObject }) {
  return (
    <div className="selection-overlay" style={objectCssVars(object)} aria-hidden="true">
      {HANDLES.map((handle) => (
        <span key={handle} className="selection-handle" data-handle={handle} />
      ))}
    </div>
  );
}
