import type { CSSProperties } from 'react';
import type { StackObject } from '@hypergeist/shared/format';

/**
 * Unitless position and size custom properties for the `style` prop. The CSS multiplies
 * them by `--scale` and `--px`.
 */
export function objectCssVars(object: StackObject): CSSProperties {
  // React's CSSProperties has no index signature for custom properties, so the
  // literal needs this one cast. The values are plain numbers.
  return {
    '--x': object.x,
    '--y': object.y,
    '--w': object.width,
    '--h': object.height,
  } as CSSProperties;
}
