import { ENTITY_ID_PATTERN } from '@hypergeist/shared/format';
import { describe, expect, it } from 'vitest';
import { deepFreeze } from '../../../../packages/shared/test-support/freeze.ts';
import {
  MAX_AHEAD_MS,
  MAX_PENDING_REMINDERS,
  PAST_MESSAGE,
  TOO_FAR_MESSAGE,
  TOO_MANY_MESSAGE,
  canSchedule,
  dueNow,
  markFired,
  markMissed,
  newReminderId,
  nextDue,
} from './reminder-logic.ts';
import { ReminderSchema } from './types.ts';
import type { Reminder } from './types.ts';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function reminder(id: string, dueAt: number, state: Reminder['state'] = 'pending'): Reminder {
  return {
    id,
    stackId: 'smart-todo',
    message: `Message ${id}`,
    dueAt,
    createdAt: NOW - DAY,
    state,
  };
}

function manyPending(count: number): Reminder[] {
  return Array.from({ length: count }, (_, i) => reminder(`r${i}`, NOW + (i + 1) * MINUTE));
}

describe('ReminderSchema', () => {
  it('accepts a valid reminder', () => {
    expect(ReminderSchema.safeParse(reminder('a', NOW)).success).toBe(true);
  });

  it('rejects unknown properties instead of stripping them', () => {
    expect(ReminderSchema.safeParse({ ...reminder('a', NOW), extra: 1 }).success).toBe(false);
  });

  it('rejects bad ids, bad messages, bad numbers and bad states', () => {
    const base = reminder('a', NOW);
    const bad: unknown[] = [
      { ...base, id: 'A' },
      { ...base, id: '' },
      { ...base, id: 'a'.repeat(65) },
      { ...base, stackId: '-x' },
      { ...base, message: '' },
      { ...base, message: 'x'.repeat(501) },
      { ...base, dueAt: -1 },
      { ...base, dueAt: 1.5 },
      { ...base, dueAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, dueAt: Number.NaN },
      { ...base, createdAt: -1 },
      { ...base, state: 'done' },
      { ...base, state: undefined },
    ];
    for (const value of bad) {
      expect(ReminderSchema.safeParse(value).success).toBe(false);
    }
  });

  it('accepts messages of 1 and 500 characters and the id length limit', () => {
    expect(ReminderSchema.safeParse({ ...reminder('a', 0), message: 'x' }).success).toBe(true);
    expect(
      ReminderSchema.safeParse({ ...reminder('a', 0), message: 'x'.repeat(500) }).success,
    ).toBe(true);
    expect(ReminderSchema.safeParse(reminder('a'.repeat(64), 0)).success).toBe(true);
  });
});

describe('dueNow', () => {
  it('returns pending reminders that are due, earliest first, ties by id', () => {
    const list = [
      reminder('c', NOW),
      reminder('a', NOW - 5 * MINUTE),
      reminder('b', NOW),
      reminder('later', NOW + 1),
    ];
    expect(dueNow(list, NOW).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('counts a reminder due exactly now as due, and one a millisecond ahead as not due', () => {
    expect(dueNow([reminder('a', NOW)], NOW)).toHaveLength(1);
    expect(dueNow([reminder('a', NOW + 1)], NOW)).toHaveLength(0);
  });

  it('ignores fired and missed reminders', () => {
    const list = [reminder('a', NOW - 1, 'fired'), reminder('b', NOW - 1, 'missed')];
    expect(dueNow(list, NOW)).toEqual([]);
  });

  it('does not mutate its input or reorder it', () => {
    const list = deepFreeze([reminder('b', NOW), reminder('a', NOW - 1)]);
    const result = dueNow(list, NOW);
    expect(list.map((r) => r.id)).toEqual(['b', 'a']);
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('handles an empty list', () => {
    expect(dueNow([], NOW)).toEqual([]);
  });
});

describe('nextDue', () => {
  it('returns the earliest pending reminder, ties by id', () => {
    const list = [
      reminder('z', NOW + 10),
      reminder('b', NOW + 5),
      reminder('a', NOW + 5),
      reminder('early', NOW - 10, 'fired'),
      reminder('earlier', NOW - 20, 'missed'),
    ];
    expect(nextDue(list)?.id).toBe('a');
  });

  it('returns undefined when nothing is pending', () => {
    expect(nextDue([])).toBeUndefined();
    expect(nextDue([reminder('a', NOW, 'fired'), reminder('b', NOW, 'missed')])).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const list = deepFreeze([reminder('b', NOW + 2), reminder('a', NOW + 1)]);
    nextDue(list);
    expect(list.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('markMissed', () => {
  it('turns pending reminders that are past due into missed and reports them', () => {
    const list = [
      reminder('past', NOW - MINUTE),
      reminder('exact', NOW),
      reminder('future', NOW + MINUTE),
      reminder('fired', NOW - MINUTE, 'fired'),
    ];
    const result = markMissed(list, NOW);
    expect(result.reminders.map((r) => [r.id, r.state])).toEqual([
      ['past', 'missed'],
      ['exact', 'missed'],
      ['future', 'pending'],
      ['fired', 'fired'],
    ]);
    expect(result.changed.map((r) => r.id)).toEqual(['past', 'exact']);
    expect(result.changed.every((r) => r.state === 'missed')).toBe(true);
  });

  it('keeps unchanged reminders as the same objects and keeps the order', () => {
    const future = reminder('future', NOW + MINUTE);
    const result = markMissed([reminder('past', NOW - 1), future], NOW);
    expect(result.reminders[1]).toBe(future);
  });

  it('does not mutate its input', () => {
    const list = deepFreeze([reminder('past', NOW - 1)]);
    const result = markMissed(list, NOW);
    expect(list[0]?.state).toBe('pending');
    expect(result.reminders[0]).not.toBe(list[0]);
  });

  it('changes nothing when nothing is past due', () => {
    const result = markMissed([reminder('a', NOW + 1)], NOW);
    expect(result.changed).toEqual([]);
  });

  it('gives schema-valid reminders', () => {
    const result = markMissed([reminder('a', NOW - 1)], NOW);
    expect(ReminderSchema.safeParse(result.reminders[0]).success).toBe(true);
  });
});

describe('markFired', () => {
  it('marks only the listed pending reminders', () => {
    const list = [reminder('a', NOW), reminder('b', NOW), reminder('c', NOW, 'missed')];
    const result = markFired(list, ['a', 'c', 'unknown']);
    expect(result.reminders.map((r) => r.state)).toEqual(['fired', 'pending', 'missed']);
    expect(result.changed.map((r) => r.id)).toEqual(['a']);
  });

  it('does not mutate its input', () => {
    const list = deepFreeze([reminder('a', NOW)]);
    markFired(list, ['a']);
    expect(list[0]?.state).toBe('pending');
  });

  it('cannot fire the same reminder twice', () => {
    const first = markFired([reminder('a', NOW)], ['a']);
    const second = markFired(first.reminders, ['a']);
    expect(second.changed).toEqual([]);
    expect(dueNow(second.reminders, NOW + DAY)).toEqual([]);
  });
});

describe('canSchedule', () => {
  it('accepts a time in the future within the range', () => {
    expect(canSchedule([], NOW + MINUTE, NOW)).toEqual({ ok: true });
    expect(canSchedule([], NOW + 1, NOW)).toEqual({ ok: true });
  });

  it('rejects the present and the past with the plain message', () => {
    expect(canSchedule([], NOW, NOW)).toEqual({
      ok: false,
      message: 'That time has already passed',
    });
    expect(canSchedule([], NOW - 1, NOW)).toEqual({ ok: false, message: PAST_MESSAGE });
    expect(canSchedule([], 0, NOW)).toEqual({ ok: false, message: PAST_MESSAGE });
  });

  it('accepts exactly 366 days ahead and rejects one millisecond more', () => {
    expect(MAX_AHEAD_MS).toBe(366 * DAY);
    expect(canSchedule([], NOW + 366 * DAY, NOW)).toEqual({ ok: true });
    expect(canSchedule([], NOW + 366 * DAY + 1, NOW)).toEqual({
      ok: false,
      message: TOO_FAR_MESSAGE,
    });
  });

  it('accepts the 50th pending reminder and rejects the 51st', () => {
    expect(MAX_PENDING_REMINDERS).toBe(50);
    expect(canSchedule(manyPending(49), NOW + DAY, NOW)).toEqual({ ok: true });
    expect(canSchedule(manyPending(50), NOW + DAY, NOW)).toEqual({
      ok: false,
      message: TOO_MANY_MESSAGE,
    });
    expect(TOO_MANY_MESSAGE).toMatch(/50/);
  });

  it('counts only pending reminders toward the limit', () => {
    const list = [
      ...manyPending(49),
      reminder('f', NOW - 1, 'fired'),
      reminder('m', NOW - 1, 'missed'),
    ];
    expect(canSchedule(list, NOW + DAY, NOW)).toEqual({ ok: true });
  });

  it('reports the past before the range and the range before the limit', () => {
    expect(canSchedule(manyPending(50), NOW - 1, NOW)).toEqual({
      ok: false,
      message: PAST_MESSAGE,
    });
    expect(canSchedule(manyPending(50), NOW + 400 * DAY, NOW)).toEqual({
      ok: false,
      message: TOO_FAR_MESSAGE,
    });
  });

  it('rejects numbers that are not times, without throwing', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(canSchedule([], bad, NOW).ok).toBe(false);
      expect(canSchedule([], NOW + MINUTE, bad).ok).toBe(false);
    }
  });

  it('does not mutate the list', () => {
    const list = deepFreeze(manyPending(3));
    canSchedule(list, NOW + DAY, NOW);
    expect(list).toHaveLength(3);
  });
});

describe('newReminderId', () => {
  it('builds ids that match the entity id pattern and the schema', () => {
    for (const counter of [0, 1, 35, 36, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      const id = newReminderId(counter);
      expect(ENTITY_ID_PATTERN.test(id)).toBe(true);
      expect(ReminderSchema.safeParse(reminder(id, NOW)).success).toBe(true);
    }
  });

  it('is deterministic and different for different counters', () => {
    expect(newReminderId(7)).toBe(newReminderId(7));
    const ids = new Set(Array.from({ length: 500 }, (_, i) => newReminderId(i)));
    expect(ids.size).toBe(500);
  });

  it('throws RangeError for a counter that is not a non-negative safe integer', () => {
    for (const bad of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => newReminderId(bad)).toThrow(RangeError);
    }
  });
});
