import { describe, expect, it } from 'vitest';
import { JsonReplySchema, MAX_JSON_CALLS, extractJson, parseJsonReply } from './json-mode.ts';
import type { ExtractJsonResult } from './json-mode.ts';

function valueOf(result: ExtractJsonResult): unknown {
  if (!result.ok) throw new Error(`expected a value, got ${result.reason}`);
  return result.value;
}

function reasonOf(result: ExtractJsonResult): string {
  if (result.ok) throw new Error('expected a failure');
  return result.reason;
}

const REPLY = '{"calls":[{"tool":"create_card","params":{"name":"Notes"}}],"say":"Done"}';
const REPLY_VALUE = {
  calls: [{ tool: 'create_card', params: { name: 'Notes' } }],
  say: 'Done',
};

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(valueOf(extractJson(REPLY))).toEqual(REPLY_VALUE);
  });

  it('reads an object in a fence with the json tag', () => {
    expect(valueOf(extractJson(`\`\`\`json\n${REPLY}\n\`\`\``))).toEqual(REPLY_VALUE);
  });

  it('reads an object in a fence without a language tag', () => {
    expect(valueOf(extractJson(`\`\`\`\n${REPLY}\n\`\`\``))).toEqual(REPLY_VALUE);
  });

  it('reads a fence with a Windows line ending', () => {
    expect(valueOf(extractJson(`\`\`\`json\r\n${REPLY}\r\n\`\`\``))).toEqual(REPLY_VALUE);
  });

  it('reads a fence that was never closed', () => {
    expect(valueOf(extractJson(`\`\`\`json\n${REPLY}`))).toEqual(REPLY_VALUE);
  });

  it('prefers the fenced object over braces in the text before it', () => {
    const text = `Use {curly} braces like so.\n\`\`\`json\n${REPLY}\n\`\`\`\nBye.`;
    expect(valueOf(extractJson(text))).toEqual(REPLY_VALUE);
  });

  it('tolerates text before and after', () => {
    expect(valueOf(extractJson(`Sure, here you go:\n${REPLY}\nLet me know!`))).toEqual(REPLY_VALUE);
  });

  it('handles nested braces', () => {
    const value = { a: { b: { c: {} } }, d: [{ e: {} }] };
    expect(valueOf(extractJson(`x ${JSON.stringify(value)} y`))).toEqual(value);
  });

  it('ignores braces inside strings', () => {
    const value = { text: 'a } b { c {{ }}', other: '}' };
    expect(valueOf(extractJson(`ok ${JSON.stringify(value)} done`))).toEqual(value);
  });

  it('handles escaped quotes and a string that ends in a backslash', () => {
    const value = { text: 'say "hi} there"', path: 'C:\\dir\\', more: '\\"}' };
    expect(valueOf(extractJson(`${JSON.stringify(value)} trailing }`))).toEqual(value);
  });

  it('keeps the first of two objects', () => {
    expect(valueOf(extractJson('{"n":1} then {"n":2}'))).toEqual({ n: 1 });
  });

  it('skips a balanced span that is not JSON and takes the next one', () => {
    expect(valueOf(extractJson('For example {like this} but really {"n":2}'))).toEqual({ n: 2 });
  });

  it('reports no object when there is none', () => {
    const result = extractJson('I cannot help with that. [1, 2, 3]');
    expect(reasonOf(result)).toBe('NO_JSON');
    expect(result.ok ? [] : result.errors).toHaveLength(1);
  });

  it('reports an empty string as no object', () => {
    expect(reasonOf(extractJson(''))).toBe('NO_JSON');
  });

  it('reports an unterminated object', () => {
    expect(reasonOf(extractJson('{"calls":[{"tool":"say"'))).toBe('UNTERMINATED');
    expect(reasonOf(extractJson('{"a":"b\\'))).toBe('UNTERMINATED');
    expect(reasonOf(extractJson('{"a":"}'))).toBe('UNTERMINATED');
  });

  it('reports an object that is balanced but not valid JSON', () => {
    expect(reasonOf(extractJson("{'calls': []}"))).toBe('INVALID_JSON');
    expect(reasonOf(extractJson('{"calls": [],}'))).toBe('INVALID_JSON');
  });

  it('gives errors that a repair message can use', () => {
    const result = extractJson('nothing here');
    if (result.ok) throw new Error('expected a failure');
    const [error] = result.errors;
    expect(error?.code).toBe('INVALID_JSON');
    expect(error?.path).toBe('');
    expect(error?.message).not.toBe('');
    expect(error?.hint).not.toBe('');
  });

  it('does not treat a top-level array as an object', () => {
    expect(reasonOf(extractJson('[1,2,3]'))).toBe('NO_JSON');
  });

  it('turns a __proto__ key into plain data, not a prototype change', () => {
    const value = valueOf(extractJson('{"__proto__":{"polluted":true},"a":1}'));
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  describe('linear time', () => {
    const MEGABYTE = 1024 * 1024;
    // Generous bound: a linear scan takes a few milliseconds. A backtracking pattern on these
    // inputs would take seconds or minutes.
    const LIMIT_MS = 1000;

    function timed(text: string): { result: ExtractJsonResult; ms: number } {
      const start = performance.now();
      const result = extractJson(text);
      return { result, ms: performance.now() - start };
    }

    it('scans 1 MB of text without a brace', () => {
      const { result, ms } = timed('a'.repeat(MEGABYTE));
      expect(reasonOf(result)).toBe('NO_JSON');
      expect(ms).toBeLessThan(LIMIT_MS);
    });

    it('scans 1 MB of prose that ends in an object', () => {
      const { result, ms } = timed(`${'word '.repeat(MEGABYTE / 5)}${REPLY}`);
      expect(valueOf(result)).toEqual(REPLY_VALUE);
      expect(ms).toBeLessThan(LIMIT_MS);
    });

    it('scans 1 MB of opening braces', () => {
      const { result, ms } = timed('{'.repeat(MEGABYTE));
      expect(reasonOf(result)).toBe('UNTERMINATED');
      expect(ms).toBeLessThan(LIMIT_MS);
    });

    it('scans 1 MB of opening braces and quotes', () => {
      const { result, ms } = timed('{"'.repeat(MEGABYTE / 2));
      expect(reasonOf(result)).toBe('UNTERMINATED');
      expect(ms).toBeLessThan(LIMIT_MS);
    });

    it('scans 1 MB of backslashes inside an unterminated string', () => {
      const { result, ms } = timed(`{"a":"${'\\'.repeat(MEGABYTE)}`);
      expect(reasonOf(result)).toBe('UNTERMINATED');
      expect(ms).toBeLessThan(LIMIT_MS);
    });

    it('scans many balanced spans that are not JSON', () => {
      // 100 KB, not 1 MB: each span costs one failed JSON.parse, which is slow but linear.
      const { result, ms } = timed('{x}'.repeat(100_000 / 3));
      expect(reasonOf(result)).toBe('INVALID_JSON');
      expect(ms).toBeLessThan(LIMIT_MS);
    });

    it('scans a 1 MB string value inside an object', () => {
      const { result, ms } = timed(`{"text":"${'x'.repeat(MEGABYTE)}"}`);
      expect(result.ok).toBe(true);
      expect(ms).toBeLessThan(LIMIT_MS);
    });

    it('scans 1 MB of backticks', () => {
      const { result, ms } = timed('`'.repeat(MEGABYTE));
      expect(reasonOf(result)).toBe('NO_JSON');
      expect(ms).toBeLessThan(LIMIT_MS);
    });
  });
});

describe('JsonReplySchema', () => {
  it('accepts an empty list of calls', () => {
    expect(JsonReplySchema.safeParse({ calls: [] }).success).toBe(true);
  });

  it('accepts calls and a say text', () => {
    const parsed = JsonReplySchema.safeParse(REPLY_VALUE);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(REPLY_VALUE);
  });

  it('keeps params as given, whatever they are', () => {
    const parsed = JsonReplySchema.safeParse({
      calls: [
        { tool: 'a', params: null },
        { tool: 'b', params: [1] },
        { tool: 'c', params: 'text' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an extra key at the top level and inside a call', () => {
    expect(JsonReplySchema.safeParse({ calls: [], extra: 1 }).success).toBe(false);
    expect(
      JsonReplySchema.safeParse({ calls: [{ tool: 'a', params: {}, extra: 1 }] }).success,
    ).toBe(false);
  });

  it('rejects a missing calls list, a wrong tool type and a long say', () => {
    expect(JsonReplySchema.safeParse({}).success).toBe(false);
    expect(JsonReplySchema.safeParse({ calls: {} }).success).toBe(false);
    expect(JsonReplySchema.safeParse({ calls: [{ tool: 1, params: {} }] }).success).toBe(false);
    expect(JsonReplySchema.safeParse({ calls: [], say: 'x'.repeat(2001) }).success).toBe(false);
    expect(JsonReplySchema.safeParse({ calls: [], say: 'x'.repeat(2000) }).success).toBe(true);
  });

  it('accepts 40 calls and rejects 41', () => {
    const call = { tool: 'say', params: { text: 'hi' } };
    expect(MAX_JSON_CALLS).toBe(40);
    expect(JsonReplySchema.safeParse({ calls: Array(40).fill(call) }).success).toBe(true);
    expect(JsonReplySchema.safeParse({ calls: Array(41).fill(call) }).success).toBe(false);
  });
});

describe('parseJsonReply', () => {
  it('returns the reply for a good fenced answer', () => {
    const result = parseJsonReply(`Here:\n\`\`\`json\n${REPLY}\n\`\`\``);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply).toEqual(REPLY_VALUE);
  });

  it('returns errors for a reply with no object', () => {
    const result = parseJsonReply('Sorry, I will not do that.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe('INVALID_JSON');
  });

  it('returns mapped schema errors with a path', () => {
    const result = parseJsonReply('{"calls":[{"tool":5,"params":{}}]}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((error) => error.path === '/calls/0/tool')).toBe(true);
    }
  });

  it('returns an error for an unknown property', () => {
    const result = parseJsonReply('{"calls":[],"extra":true}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe('UNKNOWN_PROPERTY');
  });

  it('returns an error for 41 calls', () => {
    const call = { tool: 'say', params: { text: 'hi' } };
    const result = parseJsonReply(JSON.stringify({ calls: Array(41).fill(call) }));
    expect(result.ok).toBe(false);
  });
});
