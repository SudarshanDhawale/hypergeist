// Pure UTC date helpers. The caller passes the time in; nothing here reads the clock.

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` of the UTC day that contains `ms` (milliseconds since the epoch). */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole seconds from `ms` until the next 00:00:00 UTC, from 1 to 86,400. */
export function secondsUntilUtcMidnight(ms: number): number {
  const nextMidnight = (Math.floor(ms / MS_PER_DAY) + 1) * MS_PER_DAY;
  return Math.ceil((nextMidnight - ms) / 1000);
}
