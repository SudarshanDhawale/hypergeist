/**
 * Number of bytes `text` occupies in UTF-8. Written by hand because the shared
 * package's `lib` has no `TextEncoder`. A lone surrogate counts as 3 bytes,
 * the size of the U+FFFD replacement that `TextEncoder` would write.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      // BMP unit, including a lone low surrogate.
      bytes += 3;
    }
  }
  return bytes;
}

/** Number of Unicode code points in `text`. A lone surrogate counts as one. */
export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
      }
    }
    count += 1;
  }
  return count;
}

/** Escapes one JSON Pointer reference token (RFC 6901): `~` becomes `~0`, `/` becomes `~1`. */
export function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Reverses `escapePointerSegment`. `~1` is decoded before `~0`, as RFC 6901 requires. */
export function unescapePointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** Builds a JSON Pointer from path segments. An empty list gives the root pointer `""`. */
export function toJsonPointer(segments: readonly (string | number)[]): string {
  let pointer = '';
  for (const segment of segments) {
    pointer += `/${escapePointerSegment(String(segment))}`;
  }
  return pointer;
}
