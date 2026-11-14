import type { JSX } from 'react';

/**
 * Original pixel art for the sleeping Ghost (drawn for this project).
 * A sheet ghost in a nightcap, eyes shut, with a small "z".
 *
 * Legend: `#` ink, `.` paper, space = transparent.
 * Every row has the same width, and the map is at most 24 by 24 cells.
 */
export const GHOST_PIXELS: readonly string[] = [
  '          ##          ',
  '        ####          ',
  '      ######          ',
  '    ########          ',
  '   ##########         ',
  '  #..........#  ###   ',
  '  #..........#    #   ',
  '  #.###..###.#  ###   ',
  '  #..........#        ',
  '  #....##....#        ',
  '  #....##....#        ',
  '  #..........#        ',
  '  #..........#        ',
  '  #..........#        ',
  '  ##.##..##.##        ',
  '    #  ##  #          ',
];

type Rect = { readonly x: number; readonly y: number; readonly w: number };

/** Merge horizontal runs of one cell kind into rectangles, one per run. */
function runs(rows: readonly string[], kind: string): Rect[] {
  const out: Rect[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== kind) {
        x += 1;
        continue;
      }
      let w = 1;
      while (row[x + w] === kind) w += 1;
      out.push({ x, y, w });
      x += w;
    }
  });
  return out;
}

const WIDTH = Math.max(...GHOST_PIXELS.map((row) => row.length));
const HEIGHT = GHOST_PIXELS.length;
const INK_RECTS = runs(GHOST_PIXELS, '#');
const PAPER_RECTS = runs(GHOST_PIXELS, '.');

/** Static, inert sprite. Ink is `currentColor`, paper comes from the token. */
export function GhostSprite(): JSX.Element {
  return (
    <svg
      className="ghost-sprite"
      role="img"
      aria-label="A sleeping ghost"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
    >
      <g style={{ fill: 'var(--paper)' }}>
        {PAPER_RECTS.map((r) => (
          <rect key={`p${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />
        ))}
      </g>
      <g fill="currentColor">
        {INK_RECTS.map((r) => (
          <rect key={`i${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />
        ))}
      </g>
    </svg>
  );
}
