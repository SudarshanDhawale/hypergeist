// The only place in the Worker that writes to the console. One JSON line per request.
// The entry type has no field that could hold request, reply or header text, and the
// line is built by picking the named fields, so nothing else can reach the log.

export type LogEntry = {
  route: string;
  status: number;
  /** An error code, or `ok`. */
  code: string;
  /** The provider that answered, or `none`. */
  provider: string;
  /** The upstream outcome kind, or `none`. */
  kind: string;
  /** Duration in milliseconds. */
  ms: number;
  /** Whether the request was counted against the caps. */
  counted: boolean;
};

const MAX_FIELD_LENGTH = 64;

// Control characters (Cc) plus the line and paragraph separators (Zl, Zp), so a value
// can never break the one-line format.
const UNSAFE_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Cut by code points so a surrogate pair is never split.
  return Array.from(value.replace(UNSAFE_CHARS, '')).slice(0, MAX_FIELD_LENGTH).join('');
}

function cleanInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function defaultWrite(line: string): void {
  console.log(line);
}

/**
 * Writes exactly one JSON line with the keys `route`, `status`, `code`, `provider`,
 * `kind`, `ms`, `counted`, in that order. Never throws: a failing `write` is ignored,
 * because logging must not change the answer to the visitor.
 */
export function logRequest(entry: LogEntry, write: (line: string) => void = defaultWrite): void {
  try {
    const line = JSON.stringify({
      route: cleanText(entry.route),
      status: cleanInteger(entry.status),
      code: cleanText(entry.code),
      provider: cleanText(entry.provider),
      kind: cleanText(entry.kind),
      ms: Math.max(0, cleanInteger(entry.ms)),
      counted: entry.counted === true,
    });
    write(line);
  } catch {
    // Deliberately empty: see the doc comment.
  }
}
