import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertProperty } from '../../../../packages/shared/test-support/seed.ts';
import { parseDueTime } from './due-time.ts';
import type { ParseDueTimeResult } from './due-time.ts';

/*
 * Properties of `parseDueTime`: it is total (a result value for any string, never a throw) and
 * deterministic, and it agrees with the `Date` constructor on well-formed text. The seed comes
 * from HYPERGEIST_TEST_SEED and is printed on failure. Nothing here depends on the host zone.
 */

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function isWellShaped(result: ParseDueTimeResult): boolean {
  if (result.ok) {
    return Number.isSafeInteger(result.dueAt);
  }
  return typeof result.message === 'string' && result.message.length > 0;
}

/** Text that is shaped like a due time but has random field values, so many are impossible. */
/** Mostly in-range values, sometimes anything up to `wide`, so both outcomes are common. */
function arbField(min: number, max: number, wide: number): fc.Arbitrary<number> {
  return fc.oneof(
    { weight: 5, arbitrary: fc.integer({ min, max }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: wide }) },
  );
}

/** Text that is shaped like a due time but has random field values, so some are impossible. */
const arbNearValid = fc
  .record({
    year: arbField(1971, 2100, 9999),
    month: arbField(1, 12, 99),
    day: arbField(1, 31, 99),
    hour: arbField(0, 23, 99),
    minute: arbField(0, 59, 99),
    second: fc.option(arbField(0, 59, 99), { nil: undefined }),
    separator: fc.constantFrom('T', 'T', 'T', ' ', ' ', 't', '  ', ''),
    zone: fc.constantFrom('', '', '', 'Z', 'z', '+05:30', '-08:00', '+24:00', '+00:60', '+0530'),
  })
  .map(
    (f) =>
      `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}${f.separator}${pad(f.hour)}:${pad(f.minute)}` +
      `${f.second === undefined ? '' : `:${pad(f.second)}`}${f.zone}`,
  );

const arbAnyText = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.string({ unit: 'grapheme' }),
  fc.stringMatching(/^[0-9T:+\-Z ]{0,40}$/),
  arbNearValid,
  fc.constantFrom('', ' ', 'Z', 'T', '2026-02-30T10:00', '9999-12-31T23:59:59+23:59'),
);

const arbNow = fc.oneof(
  fc.integer({ min: 0, max: 4_000_000_000_000 }),
  fc.double({ noNaN: false }),
  fc.constantFrom(0, -1, Number.MAX_SAFE_INTEGER),
);

describe('parseDueTime properties', () => {
  it('is total: always a result value, never a throw', () => {
    assertProperty(
      fc.property(arbAnyText, arbNow, (text, nowMs) => {
        const result = parseDueTime(text, nowMs);
        return isWellShaped(result);
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic: the same arguments give an equal result', () => {
    assertProperty(
      fc.property(arbAnyText, arbNow, (text, nowMs) => {
        expect(parseDueTime(text, nowMs)).toEqual(parseDueTime(text, nowMs));
      }),
      { numRuns: 300 },
    );
  });

  it('ignores nowMs: parsing does not depend on the clock', () => {
    assertProperty(
      fc.property(arbAnyText, arbNow, arbNow, (text, a, b) => {
        expect(parseDueTime(text, a)).toEqual(parseDueTime(text, b));
      }),
      { numRuns: 300 },
    );
  });

  it('is total for values that are not strings', () => {
    assertProperty(
      fc.property(fc.anything(), (value) => {
        const result = parseDueTime(value as string, 0);
        return isWellShaped(result);
      }),
      { numRuns: 200 },
    );
  });

  it('agrees with the Date constructor for local times (accepts exactly the ones that round-trip)', () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 1971, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.option(fc.integer({ min: 0, max: 59 }), { nil: undefined }),
        fc.constantFrom('T', ' '),
        (year, month, day, hour, minute, second, separator) => {
          const text =
            `${pad(year, 4)}-${pad(month)}-${pad(day)}${separator}${pad(hour)}:${pad(minute)}` +
            (second === undefined ? '' : `:${pad(second)}`);
          const date = new Date(year, month - 1, day, hour, minute, second ?? 0);
          const exists =
            date.getFullYear() === year &&
            date.getMonth() === month - 1 &&
            date.getDate() === day &&
            date.getHours() === hour &&
            date.getMinutes() === minute &&
            date.getSeconds() === (second ?? 0);
          const result = parseDueTime(text, 0);
          expect(result.ok).toBe(exists);
          if (result.ok) {
            expect(result.dueAt).toBe(date.getTime());
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('agrees with Date.UTC for Z and offsets, whatever the host zone', () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 1971, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 59 }),
        fc.constantFrom('+', '-'),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.boolean(),
        (year, month, day, hour, minute, second, sign, offsetHour, offsetMinute, useZ) => {
          const zone = useZ ? 'Z' : `${sign}${pad(offsetHour)}:${pad(offsetMinute)}`;
          const offsetMs = useZ
            ? 0
            : (sign === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60_000;
          const text = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${zone}`;
          const result = parseDueTime(text, 0);
          expect(result).toEqual({
            ok: true,
            dueAt: Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs,
          });
        },
      ),
      { numRuns: 400 },
    );
  });

  it('rejects every day that is not on the calendar, with and without Z', () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 1971, max: 2100 }),
        fc.constantFrom(2, 4, 6, 9, 11),
        fc.integer({ min: 29, max: 31 }),
        (year, month, day) => {
          const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
          const daysInMonth = month === 2 ? (leap ? 29 : 28) : 30;
          fc.pre(day > daysInMonth);
          const text = `${pad(year, 4)}-${pad(month)}-${pad(day)}T10:00`;
          expect(parseDueTime(text, 0).ok).toBe(false);
          expect(parseDueTime(`${text}Z`, 0).ok).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// Sanity check that the generators produce both outcomes, so the properties above are not vacuous.
describe('parseDueTime generators', () => {
  it('produce accepted and rejected text', () => {
    const samples = fc.sample(arbNearValid, { numRuns: 400, seed: 1 });
    const accepted = samples.filter((text) => parseDueTime(text, 0).ok).length;
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(samples.length);
  });
});
