import { describe, expect, it } from 'vitest';
import { checkText, checkValue } from './check.ts';
import { LIMITS } from './limits.ts';
import { utf8ByteLength } from './text.ts';

describe('checkText: INVALID_JSON location', () => {
  it('names the line and column of the first bad character', () => {
    const { result } = checkText('{"a":1,}');
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'INVALID_JSON',
      path: '',
      message: 'The text is not well-formed JSON: unexpected "}" at line 1, column 8.',
    });
    expect(result.errors[0]?.hint).toContain('line 1, column 8');
  });

  it('counts lines at LF only, so a CRLF text reports the line after the break', () => {
    const { result } = checkText('{\r\n  "a": 1,\r\n}');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('INVALID_JSON');
    expect(result.errors[0]?.message).toBe(
      'The text is not well-formed JSON: unexpected "}" at line 3, column 1.',
    );
  });

  it('reports an end-of-text error at the position after the last character', () => {
    const { result } = checkText('{"a":');
    expect(result.errors[0]?.code).toBe('INVALID_JSON');
    expect(result.errors[0]?.message).toBe(
      'The text is not well-formed JSON: unexpected end of text at line 1, column 6.',
    );
  });

  it('reports an end-of-text error on a later line of a CRLF text', () => {
    const { result } = checkText('{\r\n"a":\r\n');
    expect(result.errors[0]?.message).toBe(
      'The text is not well-formed JSON: unexpected end of text at line 3, column 1.',
    );
  });

  it('reports a leading byte order mark by code point and adds the BOM hint', () => {
    const { result } = checkText('\uFEFF{}');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('INVALID_JSON');
    expect(result.errors[0]?.message).toBe(
      'The text is not well-formed JSON: unexpected character U+FEFF at line 1, column 1.',
    );
    expect(result.errors[0]?.hint).toContain('byte order mark');
  });

  it('adds no BOM hint to text without a byte order mark', () => {
    const { result } = checkText('{"a":1,}');
    expect(result.errors[0]?.hint).not.toContain('byte order mark');
  });
});

describe('checkText: document size limit', () => {
  it('gives one LIMIT_EXCEEDED at the root for text over 2,097,152 bytes, without parsing', () => {
    // Not JSON: a parse would report INVALID_JSON, so LIMIT_EXCEEDED proves no parse happened.
    const { result } = checkText('a'.repeat(LIMITS.maxDocumentBytes + 1));
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'LIMIT_EXCEEDED', path: '' });
  });

  it('parses text of exactly 2,097,152 bytes', () => {
    const text = `{}${' '.repeat(LIMITS.maxDocumentBytes - 2)}`;
    expect(utf8ByteLength(text)).toBe(LIMITS.maxDocumentBytes);
    const { result } = checkText(text);
    expect(result.errors.map((error) => error.code)).not.toContain('LIMIT_EXCEEDED');
    expect(result.errors[0]?.code).toBe('MISSING_PROPERTY');
  });
});

describe('the pipeline never throws', () => {
  it('handles a cyclic object', () => {
    const cyclic: Record<string, unknown> = { formatVersion: 1 };
    cyclic['self'] = cyclic;
    cyclic['cards'] = [cyclic];
    const { result } = checkValue(cyclic);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles a throwing getter', () => {
    const hostile: Record<string, unknown> = { formatVersion: 1 };
    Object.defineProperty(hostile, 'id', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const { result } = checkValue(hostile);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles undefined as a value', () => {
    const { result } = checkValue(undefined);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'WRONG_TYPE', path: '' });
  });
});
