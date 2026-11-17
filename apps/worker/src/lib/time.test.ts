import { describe, expect, it } from 'vitest';
import { secondsUntilUtcMidnight, utcDate } from './time';

describe('utcDate', () => {
  it('formats the epoch', () => {
    expect(utcDate(0)).toBe('1970-01-01');
  });

  it('changes exactly at midnight UTC', () => {
    expect(utcDate(Date.UTC(2026, 10, 15, 23, 59, 59, 999))).toBe('2026-11-15');
    expect(utcDate(Date.UTC(2026, 10, 16, 0, 0, 0, 0))).toBe('2026-11-16');
  });

  it('handles a leap day', () => {
    expect(utcDate(Date.UTC(2028, 1, 29, 12))).toBe('2028-02-29');
    expect(utcDate(Date.UTC(2028, 2, 1, 0))).toBe('2028-03-01');
    expect(utcDate(Date.UTC(2027, 2, 1, 0))).toBe('2027-03-01');
  });

  it('handles the year end', () => {
    expect(utcDate(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe('2026-12-31');
    expect(utcDate(Date.UTC(2027, 0, 1, 0, 0, 0, 0))).toBe('2027-01-01');
  });
});

describe('secondsUntilUtcMidnight', () => {
  it('is 86,400 exactly at midnight', () => {
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 15, 0, 0, 0, 0))).toBe(86_400);
    expect(secondsUntilUtcMidnight(0)).toBe(86_400);
  });

  it('is 1 in the last second of the day', () => {
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 15, 23, 59, 59, 0))).toBe(1);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 15, 23, 59, 59, 999))).toBe(1);
  });

  it('counts whole seconds, rounding up', () => {
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 15, 23, 59, 58, 500))).toBe(2);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 15, 12, 0, 0, 0))).toBe(43_200);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 15, 0, 0, 0, 1))).toBe(86_400);
  });

  it('works on a leap day and across the year end', () => {
    expect(secondsUntilUtcMidnight(Date.UTC(2028, 1, 29, 23, 0, 0))).toBe(3_600);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 11, 31, 23, 59, 0))).toBe(60);
  });

  it('stays within 1 to 86,400 and lands on the next UTC date', () => {
    for (let ms = Date.UTC(2028, 1, 28); ms < Date.UTC(2028, 2, 2); ms += 3_600_017) {
      const seconds = secondsUntilUtcMidnight(ms);
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(86_400);
      expect(utcDate(ms + seconds * 1000)).not.toBe(utcDate(ms));
      expect(utcDate(ms + (seconds - 1) * 1000)).toBe(utcDate(ms));
    }
  });
});
