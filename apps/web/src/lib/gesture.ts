/** A rectangle in card units. All values are whole numbers. */
export type Rect = { x: number; y: number; w: number; h: number };

export type Handle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export type CardSize = { w: number; h: number };

export type SizeLimits = { min: number; max: number };

/** The `update_object.changes` fields a gesture can produce. */
export type RectChanges = { x?: number; y?: number; width?: number; height?: number };

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * Resolves one axis of a resize. `pos` and `size` describe the start, `moveStart`
 * and `moveEnd` say which edges the handle drags, `delta` is the pointer travel.
 * The edge that is not dragged stays fixed. Returns the new position and size.
 */
function resizeAxis(
  pos: number,
  size: number,
  moveStart: boolean,
  moveEnd: boolean,
  delta: number,
  extent: number,
  limits: SizeLimits,
): { pos: number; size: number } {
  if (moveStart) {
    const end = pos + size;
    const start = clamp(pos + delta, Math.max(0, end - limits.max), end - limits.min);
    return { pos: start, size: end - start };
  }
  if (moveEnd) {
    const end = clamp(pos + size + delta, pos + limits.min, Math.min(extent, pos + limits.max));
    return { pos, size: end - pos };
  }
  return { pos, size };
}

/**
 * Applies a drag of `dx`, `dy` (card units, already scaled and rounded) to `start`.
 * `move` shifts the rectangle and keeps it inside the card. A resize handle moves
 * only its own edges, keeps the opposite edge fixed, keeps the size within
 * `limits` and keeps the result inside the card. Inputs are not mutated.
 */
export function applyGesture(
  start: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  card: CardSize,
  limits: SizeLimits,
): Rect {
  const stepX = Math.round(dx);
  const stepY = Math.round(dy);
  if (handle === 'move') {
    return {
      x: clamp(start.x + stepX, 0, card.w - start.w),
      y: clamp(start.y + stepY, 0, card.h - start.h),
      w: start.w,
      h: start.h,
    };
  }
  const horizontal = resizeAxis(
    start.x,
    start.w,
    handle.includes('w'),
    handle.includes('e'),
    stepX,
    card.w,
    limits,
  );
  const vertical = resizeAxis(
    start.y,
    start.h,
    handle.includes('n'),
    handle.includes('s'),
    stepY,
    card.h,
    limits,
  );
  return { x: horizontal.pos, y: vertical.pos, w: horizontal.size, h: vertical.size };
}

/** The `update_object.changes` object holding only the fields that differ. */
export function rectToChanges(start: Rect, next: Rect): RectChanges {
  const changes: RectChanges = {};
  if (next.x !== start.x) changes.x = next.x;
  if (next.y !== start.y) changes.y = next.y;
  if (next.w !== start.w) changes.width = next.w;
  if (next.h !== start.h) changes.height = next.h;
  return changes;
}
