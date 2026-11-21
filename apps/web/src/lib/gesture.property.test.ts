import { LIMITS } from '@hypergeist/shared/format';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SEED_VARIABLE,
  getTestSeed,
  propertyParams,
} from '../../../../packages/shared/test-support/seed.ts';
import { applyGesture, rectToChanges } from './gesture.ts';
import type { Handle, Rect } from './gesture.ts';

const limits = LIMITS.objectSize;
const HUGE = 1_000_000_000;

const handles: readonly Handle[] = ['move', 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const resizeHandles = handles.filter((handle) => handle !== 'move');

const arbHandle = fc.constantFrom(...handles);
const arbResizeHandle = fc.constantFrom(...resizeHandles);

const arbDelta = fc.oneof(
  fc.integer({ min: -600, max: 600 }),
  fc.integer({ min: -HUGE, max: HUGE }),
  fc.constantFrom(0, -HUGE, HUGE),
);

type Scene = { card: { w: number; h: number }; start: Rect };

/** A card of at least the minimum size and a valid rectangle inside it. */
const arbScene: fc.Arbitrary<Scene> = fc
  .record({
    cardW: fc.integer({ min: limits.min, max: 6000 }),
    cardH: fc.integer({ min: limits.min, max: 6000 }),
    fw: fc.double({ min: 0, max: 1, noNaN: true }),
    fh: fc.double({ min: 0, max: 1, noNaN: true }),
    fx: fc.double({ min: 0, max: 1, noNaN: true }),
    fy: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ cardW, cardH, fw, fh, fx, fy }) => {
    const maxW = Math.min(limits.max, cardW);
    const maxH = Math.min(limits.max, cardH);
    const w = limits.min + Math.floor(fw * (maxW - limits.min));
    const h = limits.min + Math.floor(fh * (maxH - limits.min));
    const x = Math.floor(fx * (cardW - w));
    const y = Math.floor(fy * (cardH - h));
    return { card: { w: cardW, h: cardH }, start: { x, y, w, h } };
  });

function check<T>(property: fc.IPropertyWithHooks<T>): void {
  try {
    fc.assert(property, propertyParams<T>());
  } catch (error: unknown) {
    console.error(`Property failed with ${SEED_VARIABLE}=${getTestSeed()}`);
    throw error;
  }
}

describe('gesture properties', () => {
  it('always lands inside the card, within limits, on whole numbers', () => {
    check(
      fc.property(arbScene, arbHandle, arbDelta, arbDelta, ({ card, start }, handle, dx, dy) => {
        const next = applyGesture(start, handle, dx, dy, card, limits);
        expect(Number.isInteger(next.x)).toBe(true);
        expect(Number.isInteger(next.y)).toBe(true);
        expect(Number.isInteger(next.w)).toBe(true);
        expect(Number.isInteger(next.h)).toBe(true);
        expect(next.x).toBeGreaterThanOrEqual(0);
        expect(next.y).toBeGreaterThanOrEqual(0);
        expect(next.x + next.w).toBeLessThanOrEqual(card.w);
        expect(next.y + next.h).toBeLessThanOrEqual(card.h);
        expect(next.w).toBeGreaterThanOrEqual(limits.min);
        expect(next.w).toBeLessThanOrEqual(limits.max);
        expect(next.h).toBeGreaterThanOrEqual(limits.min);
        expect(next.h).toBeLessThanOrEqual(limits.max);
      }),
    );
  });

  it('returns the start for a zero drag', () => {
    check(
      fc.property(arbScene, arbHandle, ({ card, start }, handle) => {
        expect(applyGesture(start, handle, 0, 0, card, limits)).toEqual(start);
      }),
    );
  });

  it('move keeps the width and height', () => {
    check(
      fc.property(arbScene, arbDelta, arbDelta, ({ card, start }, dx, dy) => {
        const next = applyGesture(start, 'move', dx, dy, card, limits);
        expect(next.w).toBe(start.w);
        expect(next.h).toBe(start.h);
      }),
    );
  });

  it('a resize never moves the opposite edge', () => {
    check(
      fc.property(
        arbScene,
        arbResizeHandle,
        arbDelta,
        arbDelta,
        ({ card, start }, handle, dx, dy) => {
          const next = applyGesture(start, handle, dx, dy, card, limits);
          if (handle.includes('w')) expect(next.x + next.w).toBe(start.x + start.w);
          if (handle.includes('e')) expect(next.x).toBe(start.x);
          if (handle.includes('n')) expect(next.y + next.h).toBe(start.y + start.h);
          if (handle.includes('s')) expect(next.y).toBe(start.y);
          if (!handle.includes('w') && !handle.includes('e')) {
            expect(next.x).toBe(start.x);
            expect(next.w).toBe(start.w);
          }
          if (!handle.includes('n') && !handle.includes('s')) {
            expect(next.y).toBe(start.y);
            expect(next.h).toBe(start.h);
          }
        },
      ),
    );
  });

  it('dragging an edge far toward the opposite edge stops at the minimum size', () => {
    check(
      fc.property(arbScene, arbResizeHandle, ({ card, start }, handle) => {
        const dx = handle.includes('e') ? -HUGE : handle.includes('w') ? HUGE : 0;
        const dy = handle.includes('s') ? -HUGE : handle.includes('n') ? HUGE : 0;
        const next = applyGesture(start, handle, dx, dy, card, limits);
        if (dx !== 0) expect(next.w).toBe(limits.min);
        if (dy !== 0) expect(next.h).toBe(limits.min);
      }),
    );
  });

  it('rectToChanges is empty exactly when the rectangles are equal', () => {
    check(
      fc.property(arbScene, arbHandle, arbDelta, arbDelta, ({ card, start }, handle, dx, dy) => {
        const next = applyGesture(start, handle, dx, dy, card, limits);
        const changes = rectToChanges(start, next);
        const same =
          next.x === start.x && next.y === start.y && next.w === start.w && next.h === start.h;
        expect(Object.keys(changes).length === 0).toBe(same);
        expect({
          x: changes.x ?? start.x,
          y: changes.y ?? start.y,
          w: changes.width ?? start.w,
          h: changes.height ?? start.h,
        }).toEqual(next);
      }),
    );
  });
});
