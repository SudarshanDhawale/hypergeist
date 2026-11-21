import { describe, expect, it } from 'vitest';
import { DUE_TIME_FORMAT_MESSAGE, parseDueTime } from './due-time.ts';

/*
 * These tests do not depend on the host time zone. Expected local times are built with the same
 * `Date` constructor the code uses. The offset and `Z` cases use `Date.UTC`, which has no zone.
 * To exercise other zones, run with `TZ=America/New_York pnpm exec vitest run ...` (the TZ is
 * only passed on the command line, never set here).
 */

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

function local(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function dueAtOf(text: string): number {
  const result = parseDueTime(text, NOW);
  if (!result.ok) {
    throw new Error(`expected "${text}" to parse, got: ${result.message}`);
  }
  return result.dueAt;
}

function messageOf(text: string): string {
  const result = parseDueTime(text, NOW);
  if (result.ok) {
    throw new Error(`expected "${text}" to be rejected, got ${result.dueAt}`);
  }
  return result.message;
}

/** First local wall-clock time in 2026 that does not exist here (a DST gap), if the zone has one. */
function findLocalGap():
  { year: number; month: number; day: number; hour: number; minute: number } | undefined {
  for (let month = 1; month <= 12; month += 1) {
    for (let day = 1; day <= 28; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        for (const minute of [0, 30]) {
          const date = new Date(2026, month - 1, day, hour, minute, 0);
          if (date.getHours() !== hour || date.getMinutes() !== minute) {
            return { year: 2026, month, day, hour, minute };
          }
        }
      }
    }
  }
  return undefined;
}

const gap = findLocalGap();

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

describe('parseDueTime: local time formats', () => {
  it('reads YYYY-MM-DDTHH:mm as local time', () => {
    expect(dueAtOf('2026-11-18T17:00')).toBe(local(2026, 11, 18, 17, 0));
  });

  it('reads YYYY-MM-DD HH:mm (space) as local time', () => {
    expect(dueAtOf('2026-11-18 17:00')).toBe(local(2026, 11, 18, 17, 0));
  });

  it('reads seconds with either separator', () => {
    expect(dueAtOf('2026-11-18T17:00:45')).toBe(local(2026, 11, 18, 17, 0, 45));
    expect(dueAtOf('2026-11-18 17:00:45')).toBe(local(2026, 11, 18, 17, 0, 45));
  });

  it('accepts midnight, the last minute of the day and a leap day', () => {
    expect(dueAtOf('2026-11-18T00:00')).toBe(local(2026, 11, 18, 0, 0));
    expect(dueAtOf('2026-12-31T23:59:59')).toBe(local(2026, 12, 31, 23, 59, 59));
    expect(dueAtOf('2028-02-29T09:30')).toBe(local(2028, 2, 29, 9, 30));
  });

  it('ignores spaces around the text', () => {
    expect(dueAtOf('  2026-11-18T17:00 \n')).toBe(local(2026, 11, 18, 17, 0));
  });

  it('returns an integer number of milliseconds', () => {
    expect(Number.isSafeInteger(dueAtOf('2026-11-18T17:00'))).toBe(true);
  });
});

describe('parseDueTime: Z and offsets', () => {
  it('reads Z as UTC', () => {
    expect(dueAtOf('2026-11-18T17:00Z')).toBe(Date.UTC(2026, 10, 18, 17, 0, 0));
    expect(dueAtOf('2026-11-18 17:00Z')).toBe(Date.UTC(2026, 10, 18, 17, 0, 0));
  });

  it('reads seconds with Z', () => {
    expect(dueAtOf('2026-11-18T17:00:30Z')).toBe(Date.UTC(2026, 10, 18, 17, 0, 30));
  });

  it('applies a positive offset (ahead of UTC)', () => {
    expect(dueAtOf('2026-11-18T17:00+05:30')).toBe(Date.UTC(2026, 10, 18, 11, 30, 0));
  });

  it('applies a negative offset (behind UTC)', () => {
    expect(dueAtOf('2026-11-18T17:00-08:00')).toBe(Date.UTC(2026, 10, 19, 1, 0, 0));
  });

  it('gives the same instant for different spellings of it', () => {
    const expected = dueAtOf('2026-11-18T11:30Z');
    expect(dueAtOf('2026-11-18T17:00+05:30')).toBe(expected);
    expect(dueAtOf('2026-11-18T06:30-05:00')).toBe(expected);
    expect(dueAtOf('2026-11-18T11:30:00+00:00')).toBe(expected);
  });

  it('does not depend on the host zone when an offset is given', () => {
    // Local parsing would differ between zones; an explicit offset must not.
    expect(dueAtOf('2026-07-01T12:00+02:00')).toBe(Date.UTC(2026, 6, 1, 10, 0, 0));
  });
});

describe('parseDueTime: rejected text', () => {
  const NOT_THE_FORMAT = [
    '',
    '   ',
    'tomorrow',
    'dentist Thursday 5pm',
    '2026-11-18',
    '2026-11-18T',
    '2026-11-18T17',
    '2026-11-18T17:0',
    '2026-11-18T17:00:',
    '2026-11-18T17:00:5',
    '2026-11-18T17:00:00.000Z',
    '2026-11-18T17:00:00.5',
    '2026-11-18t17:00',
    '2026-11-18T17:00z',
    '2026-11-18  17:00',
    '2026-11-18\n17:00',
    '18-11-2026 17:00',
    '2026/11/18 17:00',
    '2026-1-8T1:00',
    '26-11-18T17:00',
    '+2026-11-18T17:00',
    '2026-11-18T17:00+0530',
    '2026-11-18T17:00+05',
    '2026-11-18T17:00 Z',
    '2026-11-18T17:00 PM',
    '2026-11-18T17:00Z extra',
    'Wed Nov 18 2026 17:00:00 GMT+0000',
    '２０２６-１１-１８T１７:００',
    '1e3',
    'NaN',
    'null',
  ];

  it.each(NOT_THE_FORMAT)('rejects %j with the format message', (text) => {
    expect(messageOf(text)).toBe(DUE_TIME_FORMAT_MESSAGE);
  });

  it('rejects hour 24, minute 60 and second 60', () => {
    expect(parseDueTime('2026-11-18T24:00', NOW).ok).toBe(false);
    expect(parseDueTime('2026-11-18T17:60', NOW).ok).toBe(false);
    expect(parseDueTime('2026-11-18T17:00:60', NOW).ok).toBe(false);
    expect(parseDueTime('2026-11-18T24:00Z', NOW).ok).toBe(false);
  });

  it('rejects a month or day outside the calendar', () => {
    expect(parseDueTime('2026-00-10T10:00', NOW).ok).toBe(false);
    expect(parseDueTime('2026-13-10T10:00', NOW).ok).toBe(false);
    expect(parseDueTime('2026-11-00T10:00', NOW).ok).toBe(false);
    expect(parseDueTime('2026-11-32T10:00', NOW).ok).toBe(false);
  });

  it('rejects offsets that are out of range', () => {
    expect(messageOf('2026-11-18T17:00+24:00')).toMatch(/offset/);
    expect(messageOf('2026-11-18T17:00-05:60')).toMatch(/offset/);
  });

  it('rejects text longer than any due time', () => {
    expect(messageOf(`2026-11-18T17:00${'x'.repeat(200)}`)).toBe(DUE_TIME_FORMAT_MESSAGE);
    expect(messageOf('2'.repeat(10_000))).toBe(DUE_TIME_FORMAT_MESSAGE);
  });

  it('gives plain messages without code words', () => {
    for (const text of NOT_THE_FORMAT) {
      const message = messageOf(text);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/undefined|NaN|RangeError|Invalid Date/);
    }
  });
});

describe('parseDueTime: impossible dates', () => {
  const IMPOSSIBLE = [
    '2026-02-30T10:00',
    '2026-02-29T10:00',
    '2026-02-31T10:00',
    '2026-04-31T10:00',
    '2026-06-31T10:00',
    '2026-09-31T10:00',
    '2026-11-31T10:00',
    '2100-02-29T10:00',
  ];

  it.each(IMPOSSIBLE)('rejects local %s', (text) => {
    expect(messageOf(text)).toBe('That date does not exist.');
  });

  it.each(IMPOSSIBLE)('rejects the same date with Z: %s', (text) => {
    expect(messageOf(`${text}Z`)).toBe('That date does not exist.');
  });

  it('rejects an impossible date with an offset', () => {
    expect(messageOf('2026-02-30T10:00+01:00')).toBe('That date does not exist.');
  });

  it('accepts the real neighbours of impossible dates', () => {
    expect(parseDueTime('2026-02-28T10:00', NOW).ok).toBe(true);
    expect(parseDueTime('2026-03-31T10:00', NOW).ok).toBe(true);
    expect(parseDueTime('2000-02-29T10:00', NOW).ok).toBe(true);
  });

  it('rejects years that `Date` would move into the 1900s', () => {
    expect(parseDueTime('0050-01-01T10:00', NOW).ok).toBe(false);
    expect(parseDueTime('0000-01-01T10:00', NOW).ok).toBe(false);
    expect(parseDueTime('0050-01-01T10:00Z', NOW).ok).toBe(false);
  });
});

describe('parseDueTime: daylight-saving gaps', () => {
  // A zone with no gap (UTC, for example) has nothing to reject, so the case is skipped there.
  it.skipIf(gap === undefined)('rejects a local time the clock skips', () => {
    if (gap === undefined) {
      return;
    }
    const text = `${gap.year}-${pad(gap.month)}-${pad(gap.day)}T${pad(gap.hour)}:${pad(gap.minute)}`;
    const result = parseDueTime(text, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/does not exist on that day/);
    }
  });

  it.skipIf(gap === undefined)('accepts the same wall time with an explicit offset', () => {
    if (gap === undefined) {
      return;
    }
    const text = `${gap.year}-${pad(gap.month)}-${pad(gap.day)}T${pad(gap.hour)}:${pad(gap.minute)}Z`;
    expect(parseDueTime(text, NOW)).toEqual({
      ok: true,
      dueAt: Date.UTC(gap.year, gap.month - 1, gap.day, gap.hour, gap.minute, 0),
    });
  });

  it('accepts every wall time that round-trips and returns what the Date constructor gives', () => {
    // Covers, in whatever zone the host has, the minutes just before and after any change.
    for (let day = 1; day <= 28; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const date = new Date(2026, 2, day, hour, 30, 0);
        const text = `2026-03-${pad(day)}T${pad(hour)}:30`;
        const exists = date.getHours() === hour && date.getMinutes() === 30;
        const result = parseDueTime(text, NOW);
        expect(result.ok).toBe(exists);
        if (result.ok) {
          expect(result.dueAt).toBe(date.getTime());
        }
      }
    }
  });
});

describe('parseDueTime: totality', () => {
  it('never throws for odd arguments', () => {
    const odd: unknown[] = [
      undefined,
      null,
      42,
      {},
      [],
      Symbol.for('x'),
      () => 1,
      '\u0000',
      '\uD800',
    ];
    for (const value of odd) {
      expect(() => parseDueTime(value as string, NOW)).not.toThrow();
      expect(parseDueTime(value as string, NOW).ok).toBe(false);
    }
    for (const nowMs of [Number.NaN, Infinity, -Infinity, -1, 0, Number.MAX_VALUE]) {
      expect(() => parseDueTime('2026-11-18T17:00', nowMs)).not.toThrow();
    }
  });

  it('gives the same answer whatever nowMs is (parsing only)', () => {
    const text = '2026-11-18T17:00';
    expect(parseDueTime(text, 0)).toEqual(parseDueTime(text, Number.MAX_SAFE_INTEGER));
    expect(parseDueTime('2000-01-01T00:00', NOW).ok).toBe(true); // past times parse; canSchedule rejects them
  });

  it('is deterministic', () => {
    expect(parseDueTime('2026-11-18T17:00', NOW)).toEqual(parseDueTime('2026-11-18T17:00', NOW));
    expect(parseDueTime('nope', NOW)).toEqual(parseDueTime('nope', NOW));
  });
});
