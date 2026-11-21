/*
 * Pure reminder logic. No clock, randomness, timers, storage or DOM: the caller passes the time
 * and the counter. Inputs are never mutated; results are new arrays (unchanged reminders keep
 * their object identity).
 *
 * `parseDueTime` (`due-time.ts`) reads text into an instant. `canSchedule` here decides whether
 * that instant may become a reminder.
 */

import type { Reminder } from './types.ts';

/** At most this many reminders may be pending at once. */
export const MAX_PENDING_REMINDERS = 50;

/** A reminder may be at most 366 days ahead. */
export const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

export const PAST_MESSAGE = 'That time has already passed';
export const TOO_FAR_MESSAGE = 'That time is more than 366 days away. Pick a nearer time.';
export const TOO_MANY_MESSAGE = `You already have ${MAX_PENDING_REMINDERS} pending reminders. Cancel one first.`;
export const BAD_TIME_MESSAGE = 'That time cannot be used.';

export type CanScheduleResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/** A state change over a list: the whole new list, and only the reminders that changed. */
export type ReminderChange = {
  readonly reminders: readonly Reminder[];
  readonly changed: readonly Reminder[];
};

function byDueThenId(a: Reminder, b: Reminder): number {
  if (a.dueAt !== b.dueAt) {
    return a.dueAt - b.dueAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Pending reminders that are due at `nowMs` (`dueAt <= nowMs`), earliest first, ties by id. */
export function dueNow(reminders: readonly Reminder[], nowMs: number): readonly Reminder[] {
  return reminders
    .filter((reminder) => reminder.state === 'pending' && reminder.dueAt <= nowMs)
    .sort(byDueThenId);
}

/** The pending reminder that is due first (ties by id), or `undefined` when none is pending. */
export function nextDue(reminders: readonly Reminder[]): Reminder | undefined {
  let best: Reminder | undefined;
  for (const reminder of reminders) {
    if (reminder.state === 'pending' && (best === undefined || byDueThenId(reminder, best) < 0)) {
      best = reminder;
    }
  }
  return best;
}

function transition(
  reminders: readonly Reminder[],
  shouldChange: (reminder: Reminder) => boolean,
  state: Reminder['state'],
): ReminderChange {
  const changed: Reminder[] = [];
  const next = reminders.map((reminder) => {
    if (reminder.state === 'pending' && shouldChange(reminder)) {
      const updated: Reminder = { ...reminder, state };
      changed.push(updated);
      return updated;
    }
    return reminder;
  });
  return { reminders: next, changed };
}

/**
 * The app opened and found pending reminders already past due (`dueAt <= nowMs`): they become
 * `missed`. Reminders that are not pending are left alone.
 */
export function markMissed(reminders: readonly Reminder[], nowMs: number): ReminderChange {
  return transition(reminders, (reminder) => reminder.dueAt <= nowMs, 'missed');
}

/** The reminders with these ids, if pending, become `fired`. Others are left alone. */
export function markFired(reminders: readonly Reminder[], ids: readonly string[]): ReminderChange {
  const wanted = new Set(ids);
  return transition(reminders, (reminder) => wanted.has(reminder.id), 'fired');
}

/**
 * May a reminder due at `dueAtMs` be added now? Checked in this order: past (the time must be
 * after `nowMs`), more than 366 days ahead, and 50 reminders already pending.
 */
export function canSchedule(
  reminders: readonly Reminder[],
  dueAtMs: number,
  nowMs: number,
): CanScheduleResult {
  if (!Number.isFinite(dueAtMs) || !Number.isFinite(nowMs)) {
    return { ok: false, message: BAD_TIME_MESSAGE };
  }
  if (dueAtMs <= nowMs) {
    return { ok: false, message: PAST_MESSAGE };
  }
  if (dueAtMs - nowMs > MAX_AHEAD_MS) {
    return { ok: false, message: TOO_FAR_MESSAGE };
  }
  const pending = reminders.reduce((n, reminder) => n + (reminder.state === 'pending' ? 1 : 0), 0);
  if (pending >= MAX_PENDING_REMINDERS) {
    return { ok: false, message: TOO_MANY_MESSAGE };
  }
  return { ok: true };
}

/**
 * Builds a reminder id from a counter the caller owns. The result matches the entity id pattern.
 * The caller must pass a counter that is unique across sessions (for example one above the
 * highest stored counter, or a time-based number), because this function has no memory.
 * Throws `RangeError` for a counter that is not a non-negative safe integer (a programmer error).
 */
export function newReminderId(counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError('newReminderId needs a non-negative safe integer');
  }
  return `rem-${counter.toString(36)}`;
}
