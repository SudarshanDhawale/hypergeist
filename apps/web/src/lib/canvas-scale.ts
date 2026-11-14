export interface Size {
  readonly w: number;
  readonly h: number;
}

export type CanvasScale = 1 | 2 | 3;

/**
 * The largest whole scale from 1 through 3 at which the card fits the available area.
 * Returns 1 when no larger scale fits (including when even scale 1 does not fit).
 */
export function chooseCanvasScale(avail: Size, card: Size): CanvasScale {
  for (const scale of [3, 2, 1] as const) {
    if (card.w * scale <= avail.w && card.h * scale <= avail.h) return scale;
  }
  return 1;
}
