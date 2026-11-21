import { LIMITS } from '@hypergeist/shared/format';
import { describe, expect, it } from 'vitest';
import { applyGesture, rectToChanges } from './gesture.ts';
import type { Rect } from './gesture.ts';

const card = { w: 512, h: 342 };
const limits = LIMITS.objectSize;
const start: Rect = { x: 100, y: 80, w: 120, h: 60 };

describe('applyGesture move', () => {
  it('shifts the rectangle', () => {
    expect(applyGesture(start, 'move', 10, -5, card, limits)).toEqual({
      x: 110,
      y: 75,
      w: 120,
      h: 60,
    });
  });

  it('clamps at the top left of the card', () => {
    expect(applyGesture(start, 'move', -1000, -1000, card, limits)).toEqual({
      x: 0,
      y: 0,
      w: 120,
      h: 60,
    });
  });

  it('clamps at the bottom right of the card', () => {
    expect(applyGesture(start, 'move', 1000, 1000, card, limits)).toEqual({
      x: 392,
      y: 282,
      w: 120,
      h: 60,
    });
  });

  it('returns the start for a zero drag', () => {
    expect(applyGesture(start, 'move', 0, 0, card, limits)).toEqual(start);
  });

  it('does not mutate the input', () => {
    const copy = { ...start };
    applyGesture(start, 'move', 7, 7, card, limits);
    expect(start).toEqual(copy);
  });
});

describe('applyGesture resize', () => {
  it('east grows the width and keeps the left edge', () => {
    expect(applyGesture(start, 'e', 20, 99, card, limits)).toEqual({
      x: 100,
      y: 80,
      w: 140,
      h: 60,
    });
  });

  it('west moves the left edge and keeps the right edge', () => {
    expect(applyGesture(start, 'w', -30, 99, card, limits)).toEqual({
      x: 70,
      y: 80,
      w: 150,
      h: 60,
    });
  });

  it('south east moves both edges of its corner only', () => {
    expect(applyGesture(start, 'se', 10, 20, card, limits)).toEqual({
      x: 100,
      y: 80,
      w: 130,
      h: 80,
    });
  });

  it('north west keeps the bottom right corner', () => {
    const next = applyGesture(start, 'nw', -10, -20, card, limits);
    expect(next).toEqual({ x: 90, y: 60, w: 130, h: 80 });
    expect(next.x + next.w).toBe(start.x + start.w);
    expect(next.y + next.h).toBe(start.y + start.h);
  });

  it('north east moves the top and right edges', () => {
    expect(applyGesture(start, 'ne', 10, -10, card, limits)).toEqual({
      x: 100,
      y: 70,
      w: 130,
      h: 70,
    });
  });

  it('south west moves the bottom and left edges', () => {
    expect(applyGesture(start, 'sw', -10, 10, card, limits)).toEqual({
      x: 90,
      y: 80,
      w: 130,
      h: 70,
    });
  });

  it('stops the east edge at the minimum width', () => {
    const next = applyGesture(start, 'e', -1000, 0, card, limits);
    expect(next).toEqual({ x: 100, y: 80, w: limits.min, h: 60 });
  });

  it('stops the west edge at the minimum width, right edge fixed', () => {
    const next = applyGesture(start, 'w', 1000, 0, card, limits);
    expect(next.w).toBe(limits.min);
    expect(next.x + next.w).toBe(220);
  });

  it('stops the north edge at the minimum height, bottom edge fixed', () => {
    const next = applyGesture(start, 'n', 0, 1000, card, limits);
    expect(next.h).toBe(limits.min);
    expect(next.y + next.h).toBe(140);
  });

  it('clamps growth to the card edge', () => {
    expect(applyGesture(start, 'se', 5000, 5000, card, limits)).toEqual({
      x: 100,
      y: 80,
      w: 412,
      h: 262,
    });
  });

  it('clamps growth at the card origin', () => {
    expect(applyGesture(start, 'nw', -5000, -5000, card, limits)).toEqual({
      x: 0,
      y: 0,
      w: 220,
      h: 140,
    });
  });

  it('keeps the size under the maximum on a large card', () => {
    const big = { w: 10000, h: 10000 };
    const next = applyGesture({ x: 0, y: 0, w: 100, h: 100 }, 'se', 9000, 9000, big, limits);
    expect(next.w).toBe(limits.max);
    expect(next.h).toBe(limits.max);
  });

  it('returns the start for a zero drag on every handle', () => {
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
      expect(applyGesture(start, handle, 0, 0, card, limits)).toEqual(start);
    }
  });
});

describe('rectToChanges', () => {
  it('is empty when nothing changed', () => {
    expect(rectToChanges(start, { ...start })).toEqual({});
  });

  it('lists only the fields that differ', () => {
    expect(rectToChanges(start, { x: 101, y: 80, w: 120, h: 61 })).toEqual({ x: 101, height: 61 });
  });

  it('maps w and h to width and height', () => {
    expect(rectToChanges(start, { x: 90, y: 70, w: 130, h: 70 })).toEqual({
      x: 90,
      y: 70,
      width: 130,
      height: 70,
    });
  });
});
