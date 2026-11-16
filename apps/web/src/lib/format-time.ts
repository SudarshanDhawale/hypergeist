/**
 * Formats a timestamp (milliseconds since the epoch) as `YYYY-MM-DD HH:mm UTC`.
 * Deterministic: it does not depend on the locale or the time zone of the browser.
 * A value that is not a valid time gives `unknown time`.
 */
export function formatTimestamp(milliseconds: number): string {
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    return 'unknown time';
  }
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
