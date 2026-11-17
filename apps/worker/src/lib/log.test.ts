import { afterEach, describe, expect, it, vi } from 'vitest';
import { logRequest, type LogEntry } from './log';

const KEYS = ['route', 'status', 'code', 'provider', 'kind', 'ms', 'counted'];

const ENTRY: LogEntry = {
  route: '/api/ai/chat',
  status: 200,
  code: 'ok',
  provider: 'sarvam',
  kind: 'none',
  ms: 123,
  counted: true,
};

function capture(entry: LogEntry): { lines: string[]; parsed: Record<string, unknown> } {
  const lines: string[] = [];
  logRequest(entry, (line) => lines.push(line));
  return { lines, parsed: JSON.parse(lines[0] ?? 'null') as Record<string, unknown> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logRequest', () => {
  it('writes exactly one line with exactly the seven keys, in order', () => {
    const { lines, parsed } = capture(ENTRY);
    expect(lines).toHaveLength(1);
    expect(Object.keys(parsed)).toEqual(KEYS);
    expect(parsed).toEqual(ENTRY);
  });

  it('writes a single line without a newline', () => {
    const { lines } = capture({ ...ENTRY, route: 'a\nb\r\nc' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
  });

  it('keeps numbers numeric and the flag boolean', () => {
    const { parsed } = capture({ ...ENTRY, status: 429, ms: 7, counted: false });
    expect(parsed.status).toBe(429);
    expect(parsed.ms).toBe(7);
    expect(parsed.counted).toBe(false);
    for (const key of ['route', 'code', 'provider', 'kind']) {
      expect(typeof parsed[key]).toBe('string');
    }
  });

  it('drops extra properties', () => {
    const extra = {
      ...ENTRY,
      ip: '203.0.113.9',
      authorization: 'Bearer test-secret-sarvam-0000',
      message: 'hello there',
      headers: { cookie: 'x' },
    } as unknown as LogEntry;
    const { lines, parsed } = capture(extra);
    expect(Object.keys(parsed)).toEqual(KEYS);
    expect(lines[0]).not.toContain('203.0.113.9');
    expect(lines[0]).not.toContain('test-secret-sarvam-0000');
    expect(lines[0]).not.toContain('hello there');
  });

  it('cuts string values to 64 characters', () => {
    const long = 'x'.repeat(500);
    const { parsed } = capture({ ...ENTRY, route: long, code: long, provider: long, kind: long });
    for (const key of ['route', 'code', 'provider', 'kind']) {
      expect(parsed[key]).toBe('x'.repeat(64));
    }
  });

  it('keeps a value of exactly 64 characters and does not split a surrogate pair', () => {
    const exact = 'y'.repeat(64);
    expect(capture({ ...ENTRY, route: exact }).parsed.route).toBe(exact);
    const emoji = '😀'.repeat(70);
    expect(capture({ ...ENTRY, route: emoji }).parsed.route).toBe('😀'.repeat(64));
  });

  it('strips control characters', () => {
    const { parsed } = capture({
      ...ENTRY,
      route: '/a\u0000b\u001bc\u007fd\u0085e\u2028f\u2029g\th',
    });
    expect(parsed.route).toBe('/abcdefgh');
  });

  it('strips control characters before cutting, so the cut keeps 64 real characters', () => {
    const { parsed } = capture({ ...ENTRY, route: `\u0000${'z'.repeat(70)}` });
    expect(parsed.route).toBe('z'.repeat(64));
  });

  it('makes ms an integer of at least 0', () => {
    expect(capture({ ...ENTRY, ms: 12.9 }).parsed.ms).toBe(12);
    expect(capture({ ...ENTRY, ms: -5 }).parsed.ms).toBe(0);
    expect(capture({ ...ENTRY, ms: Number.NaN }).parsed.ms).toBe(0);
    expect(capture({ ...ENTRY, ms: Number.POSITIVE_INFINITY }).parsed.ms).toBe(0);
  });

  it('makes status an integer', () => {
    expect(capture({ ...ENTRY, status: 502.7 }).parsed.status).toBe(502);
    expect(capture({ ...ENTRY, status: Number.NaN }).parsed.status).toBe(0);
  });

  it('coerces wrongly typed values from a caller bug instead of leaking them', () => {
    const bad = {
      route: { text: 'private' },
      status: '200',
      code: 5,
      provider: null,
      kind: undefined,
      ms: '9',
      counted: 'yes',
    } as unknown as LogEntry;
    const { lines, parsed } = capture(bad);
    expect(parsed).toEqual({
      route: '',
      status: 0,
      code: '',
      provider: '',
      kind: '',
      ms: 0,
      counted: false,
    });
    expect(lines[0]).not.toContain('private');
  });

  it('does not throw when write throws', () => {
    const write = vi.fn(() => {
      throw new Error('disk full');
    });
    expect(() => logRequest(ENTRY, write)).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not throw for a null entry and writes nothing', () => {
    const write = vi.fn();
    expect(() => logRequest(null as unknown as LogEntry, write)).not.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not mutate the entry', () => {
    const entry = { ...ENTRY, route: 'a\u0000b' };
    const copy = { ...entry };
    logRequest(entry, () => {});
    expect(entry).toEqual(copy);
  });

  it('uses console.log by default, with the same single line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logRequest(ENTRY);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0];
    expect(typeof line).toBe('string');
    expect(JSON.parse(line as string)).toEqual(ENTRY);
  });
});
