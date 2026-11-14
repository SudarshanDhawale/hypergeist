import { describe, expect, it } from 'vitest';
import { chooseCanvasScale } from './canvas-scale.ts';

const card = { w: 512, h: 342 };

describe('chooseCanvasScale', () => {
  it.each([
    [{ w: 1536, h: 1026 }, 3],
    [{ w: 1535, h: 1026 }, 2],
    [{ w: 1536, h: 1025 }, 2],
    [{ w: 1024, h: 684 }, 2],
    [{ w: 1023, h: 684 }, 1],
    [{ w: 1024, h: 683 }, 1],
    [{ w: 512, h: 342 }, 1],
    [{ w: 4000, h: 4000 }, 3],
  ])('avail %j gives scale %i', (avail, expected) => {
    expect(chooseCanvasScale(avail, card)).toBe(expected);
  });

  it('returns 1 when no scale fits', () => {
    expect(chooseCanvasScale({ w: 100, h: 100 }, card)).toBe(1);
    expect(chooseCanvasScale({ w: 0, h: 0 }, card)).toBe(1);
  });

  it('returns 1 for non-finite available sizes', () => {
    expect(chooseCanvasScale({ w: Number.NaN, h: Number.NaN }, card)).toBe(1);
  });

  it('is limited by the tighter dimension', () => {
    expect(chooseCanvasScale({ w: 5000, h: 700 }, card)).toBe(2);
    expect(chooseCanvasScale({ w: 1100, h: 5000 }, card)).toBe(2);
  });
});
