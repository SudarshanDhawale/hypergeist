/**
 * Locates the first syntax error in a JSON text.
 *
 * Node's `JSON.parse` error message carries no position, so the validator needs its own
 * scanner to report a line and a column. This is an iterative RFC 8259 scanner with an
 * explicit nesting stack, so a text of 2 MiB of `[` cannot overflow the call stack. It
 * accepts exactly what `JSON.parse` accepts: whitespace is space, tab, line feed, and
 * carriage return only; no byte order mark; no raw control characters in strings; no
 * leading zeros; no trailing commas. It is pure and never throws.
 */

export type JsonSyntaxError = {
  /** UTF-16 index of the first character that cannot continue valid JSON, or `text.length`. */
  readonly offset: number;
  /** 1-based. Lines break at `\n` only. */
  readonly line: number;
  /** 1-based, in UTF-16 code units from the start of the line. */
  readonly column: number;
  /** The offending character (one whole code point), or `null` at the end of the text. */
  readonly found: string | null;
};

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const PLUS = 0x2b;
const COMMA = 0x2c;
const MINUS = 0x2d;
const DOT = 0x2e;
const SLASH = 0x2f;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const COLON = 0x3a;
const UPPER_E = 0x45;
const LEFT_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const RIGHT_BRACKET = 0x5d;
const LOWER_E = 0x65;
const LEFT_BRACE = 0x7b;
const RIGHT_BRACE = 0x7d;

/** Parser states. */
const EXPECT_VALUE = 0;
const EXPECT_VALUE_OR_END_ARRAY = 1;
const EXPECT_KEY_OR_END_OBJECT = 2;
const EXPECT_KEY = 3;
const EXPECT_COLON = 4;
const EXPECT_COMMA_OR_END = 5;

/**
 * The low-level scanners return the index after the token, or a negative number
 * `-1 - offset` when the token is bad at `offset`.
 */
function bad(offset: number): number {
  return -1 - offset;
}

function isDigit(code: number): boolean {
  return code >= DIGIT_0 && code <= DIGIT_9;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

/** `NaN` past the end of the text, so every comparison with it is false. */
function codeAt(text: string, index: number): number {
  return index < text.length ? text.charCodeAt(index) : Number.NaN;
}

function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === SPACE || code === TAB || code === LF || code === CR) {
      index += 1;
    } else {
      break;
    }
  }
  return index;
}

/** `start` is the index of the opening quote. */
function scanString(text: string, start: number): number {
  let index = start + 1;
  for (;;) {
    if (index >= text.length) {
      return bad(text.length);
    }
    const code = text.charCodeAt(index);
    if (code === QUOTE) {
      return index + 1;
    }
    if (code < SPACE) {
      return bad(index);
    }
    if (code !== BACKSLASH) {
      index += 1;
      continue;
    }
    const escape = codeAt(text, index + 1);
    if (Number.isNaN(escape)) {
      return bad(text.length);
    }
    if (escape === 0x75) {
      // \uXXXX
      for (let offset = 2; offset <= 5; offset += 1) {
        const hex = codeAt(text, index + offset);
        if (Number.isNaN(hex)) {
          return bad(text.length);
        }
        if (!isHexDigit(hex)) {
          return bad(index + offset);
        }
      }
      index += 6;
      continue;
    }
    // " \ / b f n r t
    if (
      escape === QUOTE ||
      escape === BACKSLASH ||
      escape === SLASH ||
      escape === 0x62 ||
      escape === 0x66 ||
      escape === 0x6e ||
      escape === 0x72 ||
      escape === 0x74
    ) {
      index += 2;
      continue;
    }
    return bad(index + 1);
  }
}

function scanDigits(text: string, from: number): number {
  let index = from;
  while (isDigit(codeAt(text, index))) {
    index += 1;
  }
  return index;
}

/** `start` is the index of `-` or a digit. */
function scanNumber(text: string, start: number): number {
  let index = start;
  if (codeAt(text, index) === MINUS) {
    index += 1;
  }
  const first = codeAt(text, index);
  if (first === DIGIT_0) {
    index += 1;
  } else if (isDigit(first)) {
    index = scanDigits(text, index);
  } else {
    return bad(Math.min(index, text.length));
  }
  if (codeAt(text, index) === DOT) {
    index += 1;
    if (!isDigit(codeAt(text, index))) {
      return bad(Math.min(index, text.length));
    }
    index = scanDigits(text, index);
  }
  const exponent = codeAt(text, index);
  if (exponent === LOWER_E || exponent === UPPER_E) {
    index += 1;
    const sign = codeAt(text, index);
    if (sign === PLUS || sign === MINUS) {
      index += 1;
    }
    if (!isDigit(codeAt(text, index))) {
      return bad(Math.min(index, text.length));
    }
    index = scanDigits(text, index);
  }
  return index;
}

/** `start` is the index of the first letter of `true`, `false`, or `null`. */
function scanLiteral(text: string, start: number, word: string): number {
  for (let offset = 0; offset < word.length; offset += 1) {
    if (codeAt(text, start + offset) !== word.charCodeAt(offset)) {
      return bad(Math.min(start + offset, text.length));
    }
  }
  return start + word.length;
}

function describeError(text: string, offset: number): JsonSyntaxError {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === LF) {
      line += 1;
      lineStart = index + 1;
    }
  }
  const point = offset < text.length ? text.codePointAt(offset) : undefined;
  return {
    offset,
    line,
    column: offset - lineStart + 1,
    found: point === undefined ? null : String.fromCodePoint(point),
  };
}

/**
 * Returns the position of the first syntax error in `text`, or `undefined` when the text
 * is well-formed JSON (that is, when `JSON.parse(text)` does not throw).
 */
export function findJsonSyntaxError(text: string): JsonSyntaxError | undefined {
  // Open containers, innermost last: LEFT_BRACKET for an array, LEFT_BRACE for an object.
  const open: number[] = [];
  let state = EXPECT_VALUE;
  let index = 0;

  for (;;) {
    index = skipWhitespace(text, index);
    const code = codeAt(text, index);
    // Not a character: the end of the text. `offset` is the index of the current character.
    const offset = Math.min(index, text.length);

    switch (state) {
      case EXPECT_VALUE_OR_END_ARRAY:
      case EXPECT_VALUE: {
        if (state === EXPECT_VALUE_OR_END_ARRAY && code === RIGHT_BRACKET) {
          open.pop();
          index += 1;
          state = EXPECT_COMMA_OR_END;
          break;
        }
        if (code === LEFT_BRACKET) {
          open.push(LEFT_BRACKET);
          index += 1;
          state = EXPECT_VALUE_OR_END_ARRAY;
          break;
        }
        if (code === LEFT_BRACE) {
          open.push(LEFT_BRACE);
          index += 1;
          state = EXPECT_KEY_OR_END_OBJECT;
          break;
        }
        let next: number;
        if (code === QUOTE) {
          next = scanString(text, index);
        } else if (code === MINUS || isDigit(code)) {
          next = scanNumber(text, index);
        } else if (code === 0x74) {
          next = scanLiteral(text, index, 'true');
        } else if (code === 0x66) {
          next = scanLiteral(text, index, 'false');
        } else if (code === 0x6e) {
          next = scanLiteral(text, index, 'null');
        } else {
          return describeError(text, offset);
        }
        if (next < 0) {
          return describeError(text, -1 - next);
        }
        index = next;
        state = EXPECT_COMMA_OR_END;
        break;
      }
      case EXPECT_KEY_OR_END_OBJECT:
      case EXPECT_KEY: {
        if (state === EXPECT_KEY_OR_END_OBJECT && code === RIGHT_BRACE) {
          open.pop();
          index += 1;
          state = EXPECT_COMMA_OR_END;
          break;
        }
        if (code !== QUOTE) {
          return describeError(text, offset);
        }
        const next = scanString(text, index);
        if (next < 0) {
          return describeError(text, -1 - next);
        }
        index = next;
        state = EXPECT_COLON;
        break;
      }
      case EXPECT_COLON: {
        if (code !== COLON) {
          return describeError(text, offset);
        }
        index += 1;
        state = EXPECT_VALUE;
        break;
      }
      default: {
        // EXPECT_COMMA_OR_END
        const innermost = open[open.length - 1];
        if (innermost === undefined) {
          return index === text.length ? undefined : describeError(text, offset);
        }
        if (code === COMMA) {
          index += 1;
          state = innermost === LEFT_BRACKET ? EXPECT_VALUE : EXPECT_KEY;
        } else if (
          (code === RIGHT_BRACKET && innermost === LEFT_BRACKET) ||
          (code === RIGHT_BRACE && innermost === LEFT_BRACE)
        ) {
          // The container is finished, so a comma or an end follows.
          open.pop();
          index += 1;
          state = EXPECT_COMMA_OR_END;
        } else {
          return describeError(text, offset);
        }
        break;
      }
    }
  }
}
