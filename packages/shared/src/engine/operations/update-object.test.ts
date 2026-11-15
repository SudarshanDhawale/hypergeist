import { describe, expect, it } from 'vitest';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import type { Stack, StackObject } from '../../format/index.ts';
import { validateStack } from '../../format/index.ts';
import { createStack } from '../create-stack.ts';
import type { OperationResult } from '../operation-result.ts';
import { runDefinition } from './definition.ts';
import { UpdateObjectParamsSchema } from './params.ts';
import { updateObjectDefinition } from './update-object.ts';

const BUTTON: StackObject = {
  id: 'btn-1',
  type: 'button',
  name: 'Go',
  x: 10,
  y: 10,
  width: 80,
  height: 24,
  label: 'Go',
  onClick: [{ type: 'show_message', text: 'Hi' }],
};

const FIELD: StackObject = {
  id: 'fld-1',
  type: 'field',
  name: 'Title',
  x: 10,
  y: 50,
  width: 200,
  height: 24,
  value: 'old',
  placeholder: 'type here',
  multiline: false,
  readOnly: false,
};

const LIST: StackObject = {
  id: 'lst-1',
  type: 'list',
  name: 'Items',
  x: 10,
  y: 90,
  width: 200,
  height: 100,
  items: ['a', 'b'],
  ordered: false,
};

const AI_FIELD: StackObject = {
  id: 'ai-1',
  type: 'ai-field',
  name: 'Summary',
  x: 10,
  y: 200,
  width: 200,
  height: 60,
  prompt: 'Summarize',
  inputObjectIds: ['fld-1'],
  value: '',
};

/** Two Cards. card-1 owns the Button, Field, List and ai-field. card-2 is empty. */
function makeStack(): Stack {
  const result = createStack({ id: 'stack-1', name: 'Test' });
  if (!result.ok) throw new Error('fixture stack must be valid');
  const [first] = result.stack.cards;
  if (first === undefined) throw new Error('fixture stack must have a card');
  const stack: Stack = {
    ...result.stack,
    cards: [
      { ...first, objects: [BUTTON, FIELD, LIST, AI_FIELD] },
      { id: 'card-2', name: 'Two', objects: [], links: [], onOpen: [] },
    ],
  };
  if (!validateStack(stack).valid) throw new Error('fixture stack must be valid');
  return stack;
}

function update(stack: Stack, params: unknown): OperationResult {
  return runDefinition(updateObjectDefinition, stack, params);
}

function objectOf(stack: Stack, id: string): StackObject | undefined {
  return stack.cards.flatMap((card) => card.objects).find((object) => object.id === id);
}

function expectAccepted(result: OperationResult): Stack {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.stack;
}

function expectRejected(result: OperationResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect('stack' in result).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  return result.errors;
}

describe('update_object: accepted', () => {
  it('changes the label of a Button and nothing else', () => {
    const input = makeStack();
    const result = update(input, { objectId: 'btn-1', changes: { label: 'Open' } });
    const stack = expectAccepted(result);
    expect(objectOf(stack, 'btn-1')).toEqual({ ...BUTTON, label: 'Open' });
    expect(objectOf(stack, 'fld-1')).toEqual(FIELD);
    expect(stack.cards[1]).toEqual(input.cards[1]);
    if (result.ok) {
      expect(result.summary).toEqual({
        created: [],
        updated: ['btn-1'],
        removed: [],
        removedActions: 0,
      });
    }
  });

  it('changes the value of a Field', () => {
    const stack = expectAccepted(
      update(makeStack(), { objectId: 'fld-1', changes: { value: 'new' } }),
    );
    expect(objectOf(stack, 'fld-1')).toEqual({ ...FIELD, value: 'new' });
  });

  it('replaces the items of a List', () => {
    const stack = expectAccepted(
      update(makeStack(), { objectId: 'lst-1', changes: { items: ['x', 'y', 'z'] } }),
    );
    expect(objectOf(stack, 'lst-1')).toEqual({ ...LIST, items: ['x', 'y', 'z'] });
  });

  it('changes the inputObjectIds of an ai-field', () => {
    const stack = expectAccepted(
      update(makeStack(), { objectId: 'ai-1', changes: { inputObjectIds: ['fld-1', 'lst-1'] } }),
    );
    expect(objectOf(stack, 'ai-1')).toEqual({ ...AI_FIELD, inputObjectIds: ['fld-1', 'lst-1'] });
  });

  it('changes several properties at once, including position', () => {
    const stack = expectAccepted(
      update(makeStack(), { objectId: 'fld-1', changes: { x: 20, width: 150, readOnly: true } }),
    );
    expect(objectOf(stack, 'fld-1')).toEqual({ ...FIELD, x: 20, width: 150, readOnly: true });
  });

  it('keeps the Object at its position in the Card', () => {
    const stack = expectAccepted(
      update(makeStack(), { objectId: 'fld-1', changes: { value: 'n' } }),
    );
    expect(stack.cards[0]?.objects.map((object) => object.id)).toEqual([
      'btn-1',
      'fld-1',
      'lst-1',
      'ai-1',
    ]);
  });

  it('returns the same Stack and an empty summary for empty changes', () => {
    const input = makeStack();
    const result = update(input, { objectId: 'btn-1', changes: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stack).toEqual(input);
    expect(result.summary).toEqual({ created: [], updated: [], removed: [], removedActions: 0 });
  });

  it('does not modify a deeply frozen input Stack, on success or failure', () => {
    const input = deepFreeze(makeStack());
    const before = deepCopy(input);
    expectAccepted(update(input, { objectId: 'btn-1', changes: { label: 'Open' } }));
    expectRejected(update(input, { objectId: 'btn-1', changes: { width: 0 } }));
    expect(input).toEqual(before);
  });

  it('gives the same result for the same call', () => {
    const input = makeStack();
    const params = { objectId: 'lst-1', changes: { ordered: true } };
    expect(update(input, params)).toEqual(update(input, params));
  });
});

describe('update_object: rejected', () => {
  it('reports a change to id as INVALID_VALUE at /changes/id', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'btn-1', changes: { id: 'other' } }),
    );
    expect(errors.map((e) => [e.code, e.path])).toEqual([['INVALID_VALUE', '/changes/id']]);
  });

  it('reports a change to type as INVALID_VALUE at /changes/type', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'btn-1', changes: { type: 'field' } }),
    );
    expect(errors.map((e) => [e.code, e.path])).toEqual([['INVALID_VALUE', '/changes/type']]);
  });

  it('reports id and type together, even with other bad parameters', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'nope', changes: { id: 'a', type: 'list', width: 0 } }),
    );
    expect(errors.map((e) => [e.code, e.path])).toEqual([
      ['INVALID_VALUE', '/changes/id'],
      ['INVALID_VALUE', '/changes/type'],
    ]);
  });

  it('reports a change to id as INVALID_VALUE even when the value equals the current id', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'btn-1', changes: { id: 'btn-1' } }),
    );
    expect(errors[0]?.code).toBe('INVALID_VALUE');
  });

  it('reports a property that the type does not define as UNKNOWN_PROPERTY', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'lst-1', changes: { label: 'x' } }),
    );
    expect(errors.map((e) => [e.code, e.path])).toEqual([['UNKNOWN_PROPERTY', '/changes/label']]);
  });

  it('reports every undefined property together', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'fld-1', changes: { label: 'x', items: [] } }),
    );
    expect(errors.map((e) => [e.code, e.path]).sort()).toEqual([
      ['UNKNOWN_PROPERTY', '/changes/items'],
      ['UNKNOWN_PROPERTY', '/changes/label'],
    ]);
  });

  it('reports a value invalid for its property in stage A, before the type check', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'fld-1', changes: { label: 'x', width: 0 } }),
    );
    expect(errors.map((e) => [e.code, e.path])).toEqual([['INVALID_VALUE', '/changes/width']]);
  });

  it('reports an invalid value as INVALID_VALUE at /changes/<property>', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'btn-1', changes: { width: 0 } }),
    );
    expect(errors.map((e) => [e.code, e.path])).toEqual([['INVALID_VALUE', '/changes/width']]);
  });

  it('reports a too long value as LIMIT_EXCEEDED at /changes/<property>', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'btn-1', changes: { label: 'x'.repeat(101) } }),
    );
    expect(errors.map((e) => [e.code, e.path])).toEqual([['LIMIT_EXCEEDED', '/changes/label']]);
  });

  it('reports a wrong type at /changes/<property>', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'fld-1', changes: { multiline: 'yes' } }),
    );
    expect(errors.map((e) => [e.code, e.path])).toEqual([['WRONG_TYPE', '/changes/multiline']]);
  });

  it('rejects an update that pushes the Object out of the Card through stage C', () => {
    const input = makeStack();
    const errors = expectRejected(
      update(input, { objectId: 'btn-1', changes: { x: 500, width: 100 } }),
    );
    expect(errors.map((e) => [e.code, e.path])).toEqual([['OUT_OF_BOUNDS', '/changes']]);
    expect(input).toEqual(makeStack());
  });

  it('rejects ai-field inputs on another Card or missing Objects through stage C', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'ai-1', changes: { inputObjectIds: ['missing'] } }),
    );
    expect(errors.every((e) => e.path.startsWith('/changes') || e.path.startsWith('/stack'))).toBe(
      true,
    );
  });

  it('reports an unknown Object as UNKNOWN_ENTITY at /objectId', () => {
    const errors = expectRejected(update(makeStack(), { objectId: 'nope', changes: { x: 1 } }));
    expect(errors.map((e) => [e.code, e.path])).toEqual([['UNKNOWN_ENTITY', '/objectId']]);
  });

  it('reports a Card id as objectId as UNKNOWN_ENTITY', () => {
    const errors = expectRejected(update(makeStack(), { objectId: 'card-1', changes: { x: 1 } }));
    expect(errors.map((e) => [e.code, e.path])).toEqual([['UNKNOWN_ENTITY', '/objectId']]);
  });

  it('reports an unknown Object even when changes are empty', () => {
    const errors = expectRejected(update(makeStack(), { objectId: 'nope', changes: {} }));
    expect(errors[0]?.code).toBe('UNKNOWN_ENTITY');
  });

  it('reports a missing changes property as MISSING_PROPERTY', () => {
    const errors = expectRejected(update(makeStack(), { objectId: 'btn-1' }));
    expect(errors.map((e) => [e.code, e.path])).toEqual([['MISSING_PROPERTY', '']]);
  });

  it('reports an unknown top-level parameter as UNKNOWN_PROPERTY', () => {
    const errors = expectRejected(
      update(makeStack(), { objectId: 'btn-1', changes: {}, extra: 1 }),
    );
    expect(errors.map((e) => [e.code, e.path])).toEqual([['UNKNOWN_PROPERTY', '/extra']]);
  });

  it('rejects parameters that are not an object', () => {
    for (const params of [null, 'x', 3, []]) {
      const errors = expectRejected(update(makeStack(), params));
      expect(errors[0]?.code).toBe('WRONG_TYPE');
    }
  });

  it('rejects changes that are not an object', () => {
    const errors = expectRejected(update(makeStack(), { objectId: 'btn-1', changes: [] }));
    expect(errors.map((e) => [e.code, e.path])).toEqual([['WRONG_TYPE', '/changes']]);
  });
});

describe('update_object: schema', () => {
  it('describes the same parameters as UpdateObjectParamsSchema', () => {
    expect(
      JSON.stringify(updateObjectDefinition.schema.safeParse({ objectId: 'a', changes: {} })),
    ).toBe(JSON.stringify(UpdateObjectParamsSchema.safeParse({ objectId: 'a', changes: {} })));
  });

  it('rejects id and type for UpdateObjectParamsSchema itself as unknown keys', () => {
    expect(
      UpdateObjectParamsSchema.safeParse({ objectId: 'a', changes: { id: 'b' } }).success,
    ).toBe(false);
  });
});
