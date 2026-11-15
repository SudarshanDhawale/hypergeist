import * as fc from 'fast-check';
import { describe, it } from 'vitest';
import { arbJsonText } from '../../test-support/json-text-arbitraries.ts';
import { lineAndColumn } from '../../test-support/oracles.ts';
import { assertProperty } from '../../test-support/seed.ts';
import { findJsonSyntaxError } from './json-text.ts';
import { validateStack } from './validate.ts';

function jsonParseThrows(text: string): boolean {
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

/** Returns a description of the first disagreement, or `undefined` when the scanner agrees. */
function disagreement(text: string): string | undefined {
  const error = findJsonSyntaxError(text);
  const throws = jsonParseThrows(text);
  if (error === undefined) {
    return throws ? 'scanner accepted a text that JSON.parse rejects' : undefined;
  }
  if (!throws) {
    return 'scanner rejected a text that JSON.parse accepts';
  }
  if (!Number.isInteger(error.offset) || error.offset < 0 || error.offset > text.length) {
    return `offset ${error.offset} is outside 0..${text.length}`;
  }
  const expected = lineAndColumn(text, error.offset);
  if (error.line !== expected.line || error.column !== expected.column) {
    return `line ${error.line}, column ${error.column} differ from oracle ${expected.line}, ${expected.column}`;
  }
  if (error.offset === text.length) {
    return error.found === null ? undefined : 'found must be null at the end of the text';
  }
  const point = text.codePointAt(error.offset);
  const expectedFound = point === undefined ? null : String.fromCodePoint(point);
  return error.found === expectedFound ? undefined : 'found is not the character at the offset';
}

/** Returns a description of the first problem with the validator's answer for text that JSON.parse rejects. */
function validatorProblem(text: string): string | undefined {
  const located = findJsonSyntaxError(text);
  if (located === undefined) {
    return 'scanner found no error in a text that JSON.parse rejects';
  }
  const result = validateStack(text);
  if (result.valid || result.errors.length !== 1) {
    return `expected one error, got valid=${result.valid} with ${result.errors.length} errors`;
  }
  const [error] = result.errors;
  if (error === undefined || error.code !== 'INVALID_JSON' || error.path !== '') {
    return `expected INVALID_JSON at "", got ${error?.code} at ${JSON.stringify(error?.path)}`;
  }
  const expected = lineAndColumn(text, located.offset);
  const match = /line (\d+), column (\d+)/.exec(error.message);
  if (match === null) {
    return `message has no line and column: ${error.message}`;
  }
  const line = Number(match[1]);
  const column = Number(match[2]);
  if (line !== expected.line || column !== expected.column) {
    return `message says line ${line}, column ${column}; oracle says ${expected.line}, ${expected.column}`;
  }
  // Within the text: lines break at LF only; a column may point just past the end of its line.
  const lines = text.split('\n');
  const lineText = lines[line - 1];
  if (line < 1 || line > lines.length || lineText === undefined) {
    return `line ${line} is outside 1..${lines.length}`;
  }
  if (column < 1 || column > lineText.length + 1) {
    return `column ${column} is outside 1..${lineText.length + 1} on line ${line}`;
  }
  return undefined;
}

describe('findJsonSyntaxError properties', () => {
  // Feature: stack-format-and-validator, Property 17: JSON syntax errors are located
  // **Validates: Requirements 7.12, 9.3**
  it('reports an error exactly when JSON.parse throws, with an in-range offset and oracle line and column', () => {
    assertProperty(
      fc.property(arbJsonText, (text) => {
        const problem = disagreement(text);
        if (problem !== undefined) {
          throw new Error(`${problem} for text ${JSON.stringify(text)}`);
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: stack-format-and-validator, Property 17: JSON syntax errors are located
  // **Validates: Requirements 7.12, 9.3**
  it('makes validateStack report one INVALID_JSON at the root with the oracle line and column', () => {
    assertProperty(
      fc.property(
        arbJsonText.filter((text) => jsonParseThrows(text)),
        (text) => {
          const problem = validatorProblem(text);
          if (problem !== undefined) {
            throw new Error(`${problem} for text ${JSON.stringify(text)}`);
          }
          return true;
        },
      ),
      { numRuns: 1000 },
    );
  });
});
