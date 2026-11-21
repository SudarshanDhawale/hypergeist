/*
 * Reading a due time from the text of a Field.
 *
 * This module only PARSES. It answers "which instant does this text name?" and nothing else.
 * Whether that instant may be scheduled (not in the past, at most 366 days ahead, fewer than 50
 * pending reminders) is decided by `canSchedule` in `reminder-logic.ts`.
 *
 * It uses its own regular expression and never `Date.parse` on free text, so the result does not
 * depend on the browser's locale parsing. The host time zone matters only where the text itself
 * has no offset: such a time is local time.
 */

export type ParseDueTimeResult =
  { readonly ok: true; readonly dueAt: number } | { readonly ok: false; readonly message: string };

/** Longest text that is looked at. Anything longer cannot be a due time. */
const MAX_TEXT_LENGTH = 64;

const DUE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;

const MS_PER_MINUTE = 60_000;

export const DUE_TIME_FORMAT_MESSAGE =
  'I could not read that time. Type it like 2026-11-18T17:00 (year-month-day, then 24-hour time).';
const NO_DATE_MESSAGE = 'That date does not exist.';
const NO_LOCAL_TIME_MESSAGE =
  'That time does not exist on that day, because the clock skips it. Pick another time.';
const NO_OFFSET_MESSAGE = 'That time zone offset is not valid.';

function fail(message: string): ParseDueTimeResult {
  return { ok: false, message };
}

/**
 * Parses `YYYY-MM-DDTHH:mm` or `YYYY-MM-DD HH:mm`, with optional `:ss`, and an optional `Z` or
 * `+HH:mm` / `-HH:mm` offset. Without an offset the time is local time.
 *
 * Rejects impossible dates (2026-02-30), hour 24, seconds above 59, and local times that do not
 * exist because a daylight-saving change skips them. A local time that occurs twice (the clock
 * goes back) resolves to the first occurrence, as `Date` does. Never throws.
 *
 * `nowMs` is accepted so callers pass the same arguments they pass elsewhere, but it is not used:
 * past and far-future times are `canSchedule`'s job.
 */
export function parseDueTime(text: string, nowMs: number): ParseDueTimeResult {
  void nowMs;
  if (typeof text !== 'string') {
    return fail(DUE_TIME_FORMAT_MESSAGE);
  }
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) {
    return fail(DUE_TIME_FORMAT_MESSAGE);
  }
  const match = DUE_TIME_PATTERN.exec(trimmed);
  if (match === null) {
    return fail(DUE_TIME_FORMAT_MESSAGE);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const zone = match[7];

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return fail(NO_DATE_MESSAGE);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return fail(DUE_TIME_FORMAT_MESSAGE);
  }

  try {
    if (zone === undefined) {
      return parseLocal(year, month, day, hour, minute, second);
    }
    return parseWithOffset(year, month, day, hour, minute, second, zone);
  } catch {
    // Not expected: Date methods do not throw for numbers. Kept so the contract holds anyway.
    return fail(DUE_TIME_FORMAT_MESSAGE);
  }
}

function parseLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): ParseDueTimeResult {
  const date = new Date(year, month - 1, day, hour, minute, second);
  const time = date.getTime();
  if (!Number.isSafeInteger(time)) {
    return fail(DUE_TIME_FORMAT_MESSAGE);
  }
  // Round trip. `Date` rolls impossible values over (Feb 30 becomes Mar 2, a skipped DST hour
  // moves forward), so any field that comes back different was not a real local time.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return fail(NO_DATE_MESSAGE);
  }
  if (date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) {
    return fail(NO_LOCAL_TIME_MESSAGE);
  }
  return { ok: true, dueAt: time };
}

function parseWithOffset(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
): ParseDueTimeResult {
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetRest = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetRest > 59) {
      return fail(NO_OFFSET_MESSAGE);
    }
    offsetMinutes = (offsetHours * 60 + offsetRest) * (zone.startsWith('-') ? -1 : 1);
  }

  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isSafeInteger(wall)) {
    return fail(DUE_TIME_FORMAT_MESSAGE);
  }
  // Round trip in UTC fields, so 2026-02-30T10:00Z is rejected like its local twin.
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return fail(NO_DATE_MESSAGE);
  }
  const dueAt = wall - offsetMinutes * MS_PER_MINUTE;
  if (!Number.isSafeInteger(dueAt)) {
    return fail(DUE_TIME_FORMAT_MESSAGE);
  }
  return { ok: true, dueAt };
}
