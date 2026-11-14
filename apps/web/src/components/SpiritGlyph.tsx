import type { JSX } from 'react';

/**
 * Original pixel art for the Menu_Bar mark: a small ghost-like wisp with two eyes.
 * Drawn for this project. It is decorative, so it is hidden from assistive technology.
 *
 * Legend: `#` ink, `.` paper, space = transparent.
 */
export const SPIRIT_PIXELS: readonly string[] = [
  '    ####    ',
  '  ########  ',
  ' ########## ',
  '############',
  '###..##..###',
  '###..##..###',
  '############',
  '############',
  '############',
  '############',
  '##  ####  ##',
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

const WIDTH = Math.max(...SPIRIT_PIXELS.map((row) => row.length));
const HEIGHT = SPIRIT_PIXELS.length;
const INK_RECTS = runs(SPIRIT_PIXELS, '#');
const PAPER_RECTS = runs(SPIRIT_PIXELS, '.');

/** Static decorative glyph. Ink is `currentColor`, paper comes from the token. */
export function SpiritGlyph(): JSX.Element {
  return (
    <svg
      className="spirit-glyph"
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      shapeRendering="crispEdges"
    >
      <g fill="currentColor">
        {INK_RECTS.map((r) => (
          <rect key={`i${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />
        ))}
      </g>
      <g style={{ fill: 'var(--paper)' }}>
        {PAPER_RECTS.map((r) => (
          <rect key={`p${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />
        ))}
      </g>
    </svg>
  );
}
