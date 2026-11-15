import { describe, expect, it } from 'vitest';
import { createSchemaValidator } from '../../../test-support/schema-validator.ts';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import { LIMITS } from '../../format/index.ts';
import type { Stack } from '../../format/index.ts';
import { createStack } from '../create-stack.ts';
import type { OperationResult } from '../operation-result.ts';
import { OPERATIONS, OPERATION_NAMES, applyOperation, operationJsonSchema } from './index.ts';
import type { OperationName } from './index.ts';

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object');
  }
  return value as Json;
}

/** Applies a call that must be accepted and returns the new Stack. */
function mustApply(stack: Stack, name: string, params: unknown): Stack {
  const result = applyOperation(stack, name, params);
  if (!result.ok)
    throw new Error(`fixture call ${name} was rejected: ${JSON.stringify(result.errors)}`);
  return result.stack;
}

/** card-1 and card-2; a button `obj-1` and a field `obj-2` on card-1; a link from card-1. */
function makeStack(): Stack {
  const created = createStack({ id: 'stack-1', name: 'Test' });
  if (!created.ok) throw new Error('fixture stack must be valid');
  let stack = created.stack;
  stack = mustApply(stack, 'create_card', { name: 'Two' });
  stack = mustApply(stack, 'add_object', {
    cardId: 'card-1',
    type: 'button',
    x: 10,
    y: 10,
    width: 80,
    height: 24,
    label: 'Go',
    id: 'obj-1',
  });
  stack = mustApply(stack, 'add_object', {
    cardId: 'card-1',
    type: 'field',
    x: 10,
    y: 50,
    width: 120,
    height: 24,
    id: 'obj-2',
  });
  return stack;
}

/** One accepted call per Operation, valid on `makeStack()`. */
const VALID_CALLS: Readonly<Record<OperationName, unknown>> = {
  create_card: { name: 'Three' },
  delete_card: { cardId: 'card-2' },
  add_object: { cardId: 'card-2', type: 'list', x: 0, y: 0, width: 100, height: 100 },
  update_object: { objectId: 'obj-2', changes: { value: 'hello' } },
  remove_object: { objectId: 'obj-1' },
  link_cards: { fromCardId: 'card-1', toCardId: 'card-2', label: 'Next' },
  set_action: {
    ownerId: 'obj-1',
    handler: [{ type: 'go_to_card', cardId: 'card-2' }],
  },
};

function collect(node: unknown, key: string, found: number[] = []): number[] {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, found);
  } else if (typeof node === 'object' && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      if (k === key && typeof v === 'number') found.push(v);
      collect(v, key, found);
    }
  }
  return found;
}

describe('OPERATION_NAMES and OPERATIONS', () => {
  it('lists seven unique names, in the design order', () => {
    expect([...OPERATION_NAMES]).toEqual([
      'create_card',
      'delete_card',
      'add_object',
      'update_object',
      'remove_object',
      'link_cards',
      'set_action',
    ]);
    expect(new Set(OPERATION_NAMES).size).toBe(7);
  });

  it('has exactly seven entries in the order of OPERATION_NAMES', () => {
    expect(OPERATIONS.map((operation) => operation.name)).toEqual([...OPERATION_NAMES]);
    for (const operation of OPERATIONS) {
      expect(typeof operation.schema.safeParse).toBe('function');
    }
  });
});

describe('operationJsonSchema', () => {
  const validator = createSchemaValidator();
  const allowedMaxima = new Set<number>(
    Object.values(LIMITS).flatMap((row) =>
      typeof row === 'object' && 'max' in row ? [row.max] : [],
    ),
  );

  for (const name of OPERATION_NAMES) {
    describe(name, () => {
      const json = asRecord(operationJsonSchema(name));

      it('is valid under the draft 2020-12 meta-schema', () => {
        expect(validator.isValidSchema(json)).toBe(true);
      });

      it('has a root object with additionalProperties false', () => {
        expect(json['type']).toBe('object');
        expect(json['additionalProperties']).toBe(false);
      });

      it('has a root description of 1 to 1,000 characters', () => {
        const description = json['description'];
        expect(typeof description).toBe('string');
        expect((description as string).length).toBeGreaterThan(0);
        expect((description as string).length).toBeLessThanOrEqual(1000);
      });

      it('describes every parameter in 1 to 500 characters', () => {
        const properties = asRecord(json['properties']);
        expect(Object.keys(properties).length).toBeGreaterThan(0);
        for (const [key, property] of Object.entries(properties)) {
          const description = asRecord(property)['description'];
          expect(typeof description, `description of ${key}`).toBe('string');
          expect((description as string).length, `length of ${key}`).toBeGreaterThan(0);
          expect((description as string).length, `length of ${key}`).toBeLessThanOrEqual(500);
        }
      });

      it('keeps maxLength and maxItems equal to rows of LIMITS', () => {
        for (const value of [...collect(json, 'maxLength'), ...collect(json, 'maxItems')]) {
          expect(allowedMaxima.has(value), `bound ${value}`).toBe(true);
        }
      });

      it('matches the description in OPERATIONS', () => {
        const info = OPERATIONS.find((operation) => operation.name === name);
        expect(info?.description).toBe(json['description']);
      });

      it('returns a fresh document on each call', () => {
        const first = operationJsonSchema(name);
        const second = operationJsonSchema(name);
        expect(first).not.toBe(second);
        expect(first).toEqual(second);
      });
    });
  }

  it('keeps the format bounds on named parameters', () => {
    const create = asRecord(asRecord(operationJsonSchema('create_card'))['properties']);
    expect(asRecord(create['name'])['maxLength']).toBe(LIMITS.cardName.max);
    const link = asRecord(asRecord(operationJsonSchema('link_cards'))['properties']);
    expect(asRecord(link['label'])['maxLength']).toBe(LIMITS.linkLabel.max);
  });

  it('describes update_object from the plain schema (an object root, not a pipe)', () => {
    const json = asRecord(operationJsonSchema('update_object'));
    expect(json['type']).toBe('object');
    expect(Object.keys(asRecord(json['properties']))).toEqual(['objectId', 'changes']);
  });

  it('throws for a name that is not an Operation (a programmer error)', () => {
    expect(() => operationJsonSchema('nope' as OperationName)).toThrow(RangeError);
  });
});

describe('applyOperation', () => {
  for (const name of OPERATION_NAMES) {
    it(`applies ${name}`, () => {
      const stack = deepFreeze(makeStack());
      const before = deepCopy(stack);
      const result = applyOperation(stack, name, VALID_CALLS[name]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.stack).not.toEqual(before);
      expect(stack).toEqual(before);
    });
  }

  for (const name of ['nope', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    it(`rejects the unknown name ${JSON.stringify(name)} with INVALID_VALUE at /operation`, () => {
      const stack = deepFreeze(makeStack());
      const before = deepCopy(stack);
      const result = applyOperation(stack, name, VALID_CALLS.create_card);
      expect(result.ok).toBe(false);
      expect('stack' in result).toBe(false);
      if (!result.ok) {
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.code).toBe('INVALID_VALUE');
        expect(result.errors[0]?.path).toBe('/operation');
        expect(result.errors[0]?.hint).toContain('create_card');
      }
      expect(stack).toEqual(before);
    });
  }

  it('cuts a very long unknown name in the error', () => {
    const result = applyOperation(makeStack(), 'x'.repeat(5000), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(String(result.errors[0]?.actual).length).toBeLessThanOrEqual(LIMITS.actualMaxChars);
    }
  });

  for (const [label, params] of [
    ['null', null],
    ['an array', []],
    ['a string', 'create_card'],
  ] as const) {
    it(`rejects parameters that are ${label} with WRONG_TYPE at ""`, () => {
      const result: OperationResult = applyOperation(makeStack(), 'create_card', params);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.code).toBe('WRONG_TYPE');
        expect(result.errors[0]?.path).toBe('');
      }
    });
  }

  it('does not throw for a cyclic parameter object', () => {
    const cyclic: Json = { name: 'Loop' };
    cyclic['self'] = cyclic;
    let result: OperationResult | undefined;
    expect(() => {
      result = applyOperation(makeStack(), 'create_card', cyclic);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  it('rejects an unknown parameter and leaves the Stack unchanged', () => {
    const stack = deepFreeze(makeStack());
    const before = deepCopy(stack);
    const result = applyOperation(stack, 'create_card', { name: 'Ok', color: 'red' });
    expect(result.ok).toBe(false);
    expect(stack).toEqual(before);
  });

  it('reaches update_object through its pre-pass (id cannot change)', () => {
    const result = applyOperation(makeStack(), 'update_object', {
      objectId: 'obj-2',
      changes: { id: 'other' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('INVALID_VALUE');
      expect(result.errors[0]?.path).toBe('/changes/id');
    }
  });
});
