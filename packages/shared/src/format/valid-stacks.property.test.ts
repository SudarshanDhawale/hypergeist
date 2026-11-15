import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbStack } from '../../test-support/arbitraries.ts';
import { assertProperty } from '../../test-support/seed.ts';
import { serializeStack } from './serialize.ts';
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

  // Feature: stack-format-and-validator, Property 1: Valid stacks validate
  // **Validates: Requirements 1.1, 1.2, 1.4, 1.5, 1.6, 1.8, 3.1, 3.2, 4.1, 4.2, 4.3, 4.5, 4.6, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 7.2**
  it('validates a generated stack as an object, as canonical text, and as minified JSON text', () => {
    const valid = { valid: true, errors: [], truncated: false };
    assertProperty(
      fc.property(arbStack, (stack) => {
        expect(validateStack(stack)).toEqual(valid);

        const serialized = serializeStack(stack);
        expect(serialized.ok).toBe(true);
        if (serialized.ok) {
          expect(validateStack(serialized.value)).toEqual(valid);
        }

        expect(validateStack(JSON.stringify(stack))).toEqual(valid);
      }),
    );
  });
});
