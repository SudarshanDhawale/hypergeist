import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbStack } from '../../test-support/arbitraries.ts';
import { assertProperty } from '../../test-support/seed.ts';
import { validateStack } from './validate.ts';

describe('valid stacks property', () => {
  // Feature: thin-slice, Property 1: Valid stacks validate and survive JSON
  // **Validates: Requirements 6.2, 22.3, 22.7**
  it('every generated stack validates as an object and as JSON text, and round-trips through JSON', () => {
    assertProperty(
      fc.property(arbStack, (stack) => {
        const asObject = validateStack(stack);
        expect(asObject).toEqual({ valid: true, errors: [], truncated: false });

        const text = JSON.stringify(stack);
        const asText = validateStack(text);
        expect(asText).toEqual({ valid: true, errors: [], truncated: false });

        expect(JSON.parse(text)).toEqual(stack);
        expect(validateStack(JSON.parse(text))).toEqual({
          valid: true,
          errors: [],
          truncated: false,
        });
      }),
    );
  });
});
