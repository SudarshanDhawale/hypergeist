import { describe, expect, it } from 'vitest';
import { createSchemaValidator } from './schema-validator.ts';

describe('createSchemaValidator', () => {
  const validator = createSchemaValidator();

  it('accepts a valid draft 2020-12 schema and rejects an invalid one', () => {
    expect(
      validator.isValidSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
      }),
    ).toBe(true);
    expect(validator.isValidSchema({ type: 'not-a-type' })).toBe(false);
  });

  it('checks data against a compiled 2020-12 schema', () => {
    const check = validator.compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { n: { type: 'integer', minimum: 0 } },
      required: ['n'],
      additionalProperties: false,
    });
    expect(check({ n: 0 })).toEqual({ valid: true });
    const wrong = check({ n: -1, extra: true });
    expect(wrong.valid).toBe(false);
    if (!wrong.valid) {
      expect(wrong.errors.length).toBeGreaterThan(0);
    }
  });

  it('supports oneOf with required lists and ignores formats', () => {
    const check = validator.compile({
      type: 'object',
      properties: { a: { type: 'string', format: 'date-time' }, b: { type: 'string' } },
      oneOf: [{ required: ['a'] }, { required: ['b'] }],
    });
    expect(check({ a: 'not a date' }).valid).toBe(true);
    expect(check({ a: 'x', b: 'y' }).valid).toBe(false);
    expect(check({}).valid).toBe(false);
  });
});
