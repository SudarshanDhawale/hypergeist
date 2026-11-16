import { describe, expect, it } from 'vitest';
import { formatTimestamp } from './format-time.ts';

describe('formatTimestamp', () => {
  it('formats in UTC with minutes', () => {
    expect(formatTimestamp(Date.UTC(2026, 10, 15, 14, 30, 59))).toBe('2026-11-15 14:30 UTC');
  });

  it('pads small values', () => {
    expect(formatTimestamp(Date.UTC(2026, 0, 2, 3, 4))).toBe('2026-01-02 03:04 UTC');
  });

  it('formats the epoch', () => {
    expect(formatTimestamp(0)).toBe('1970-01-01 00:00 UTC');
  });

  it('does not throw for values that are not times', () => {
    expect(formatTimestamp(Number.NaN)).toBe('unknown time');
    expect(formatTimestamp(Number.POSITIVE_INFINITY)).toBe('unknown time');
    expect(formatTimestamp(8.64e15 + 1)).toBe('unknown time');
  });

  it('is deterministic', () => {
    expect(formatTimestamp(1_700_000_000_000)).toBe(formatTimestamp(1_700_000_000_000));
  });
});
