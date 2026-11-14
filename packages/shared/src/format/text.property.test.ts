import * as fc from 'fast-check';
import { describe, it } from 'vitest';
import { assertProperty } from '../../test-support/seed.ts';
import {
  codePointLength,
  escapePointerSegment,
  unescapePointerSegment,
  utf8ByteLength,
} from './text.ts';

describe('text helpers properties', () => {
  // Feature: thin-slice, text helpers agree with the platform
  // **Validates: Requirements 6.3, 6.9**
  it('utf8ByteLength matches Buffer and codePointLength matches spread for any string', () => {
    assertProperty(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        // Buffer replaces a lone surrogate with U+FFFD (3 bytes), as utf8ByteLength does.
        return (
          utf8ByteLength(text) === Buffer.byteLength(text, 'utf8') &&
          codePointLength(text) === [...text].length
        );
      }),
    );
  });

  // Feature: thin-slice, pointer escaping round trip
  // **Validates: Requirements 6.3**
  it('unescape reverses escape and the escaped form has no raw slash', () => {
    assertProperty(
      fc.property(fc.string({ unit: 'binary' }), (segment) => {
        const escaped = escapePointerSegment(segment);
        return unescapePointerSegment(escaped) === segment && !escaped.includes('/');
      }),
    );
  });
});
