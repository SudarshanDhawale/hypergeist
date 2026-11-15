import { describe, expect, it } from 'vitest';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import type { Card, Stack, StackObject } from '../../format/index.ts';
import { validateStack } from '../../format/index.ts';
import type { OperationResult } from '../operation-result.ts';
import { runDefinition } from './definition.ts';
import { setActionDefinition } from './set-action.ts';

const BOX = { x: 0, y: 0, width: 100, height: 30 };

function field(id: string): StackObject {
  return {
    id,
    type: 'field',
    name: '',
    ...BOX,
    value: '',
    placeholder: '',
    multiline: false,
    readOnly: false,
  };
}

function list(id: string): StackObject {
  return { id, type: 'list', name: '', ...BOX, items: ['a'], ordered: false };
}

function button(id: string, onClick: Card['onOpen']): StackObject {
  return { id, type: 'button', name: '', ...BOX, label: 'Go', onClick };
}

/**
 * card-1 holds fld-1, lst-1, btn-1 (two Actions), btn-2 (empty Handler) and an onOpen with one
 * Action. card-2 is empty apart from a Link and an empty onOpen.
 */
function makeStack(): Stack {
  return {
    formatVersion: 1,
    id: 'stack-1',
    name: 'Test',
    cardWidth: 640,
    cardHeight: 480,
    startCardId: 'card-1',
    cards: [
      {
        id: 'card-1',
        name: 'One',
        objects: [
          field('fld-1'),
          list('lst-1'),
          button('btn-1', [
            { type: 'set_value', targetObjectId: 'fld-1', value: 'old' },
            { type: 'show_message', text: 'old' },
          ]),
          button('btn-2', []),
        ],
        links: [{ id: 'link-1', label: 'Next', targetCardId: 'card-2' }],
        onOpen: [{ type: 'show_message', text: 'welcome' }],
      },
      { id: 'card-2', name: 'Two', objects: [], links: [], onOpen: [] },
    ],
  };
}

function setAction(stack: Stack, params: unknown): OperationResult {
  return runDefinition(setActionDefinition, stack, params);
}

function accepted(result: OperationResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected an accepted result');
  return result;
}

function rejected(result: OperationResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a rejected result');
  expect('stack' in result).toBe(false);
  return result.errors;
}

function findButton(stack: Stack, id: string): StackObject {
  for (const card of stack.cards) {
    const found = card.objects.find((object) => object.id === id);
    if (found !== undefined) return found;
  }
  throw new Error(`no Object ${id}`);
}

describe('set_action: accepted', () => {
  it("sets a Button's onClick and changes nothing else", () => {
    const stack = makeStack();
    const handler: Card['onOpen'] = [{ type: 'go_to_card', cardId: 'card-2' }];
    const result = accepted(setAction(stack, { ownerId: 'btn-2', handler }));
    expect(findButton(result.stack, 'btn-2')).toEqual(button('btn-2', handler));
    expect(findButton(result.stack, 'btn-1')).toEqual(findButton(stack, 'btn-1'));
    expect(result.stack.cards[0]?.onOpen).toEqual(stack.cards[0]?.onOpen);
    expect(result.stack.cards[1]).toEqual(stack.cards[1]);
    expect(result.summary).toEqual({
      created: [],
      updated: ['btn-2'],
      removed: [],
      removedActions: 0,
    });
    expect(validateStack(result.stack).valid).toBe(true);
  });

  it("sets a Card's onOpen and changes nothing else", () => {
    const stack = makeStack();
    const handler = [{ type: 'set_value', targetObjectId: 'fld-1', value: 'hello' }];
    const result = accepted(setAction(stack, { ownerId: 'card-2', handler }));
    expect(result.stack.cards[1]).toEqual({ ...stack.cards[1], onOpen: handler });
    expect(result.stack.cards[0]).toEqual(stack.cards[0]);
    expect(result.summary.updated).toEqual(['card-2']);
    expect(validateStack(result.stack).valid).toBe(true);
  });

  it('replaces a non-empty Handler instead of merging', () => {
    const handler = [{ type: 'show_message', text: 'new' }];
    const result = accepted(setAction(makeStack(), { ownerId: 'btn-1', handler }));
    const btn = findButton(result.stack, 'btn-1');
    expect(btn.type === 'button' && btn.onClick).toEqual(handler);
    const onOpen = accepted(setAction(makeStack(), { ownerId: 'card-1', handler })).stack.cards[0]
      ?.onOpen;
    expect(onOpen).toEqual(handler);
  });

  it('accepts an empty Handler and clears the old one', () => {
    const result = accepted(setAction(makeStack(), { ownerId: 'btn-1', handler: [] }));
    const btn = findButton(result.stack, 'btn-1');
    expect(btn.type === 'button' && btn.onClick).toEqual([]);
    expect(result.summary.updated).toEqual(['btn-1']);
  });

  it('gives an equal Stack when applied twice (idempotence)', () => {
    const params = {
      ownerId: 'btn-1',
      handler: [
        { type: 'append_item', targetObjectId: 'lst-1', fromObjectId: 'fld-1' },
        { type: 'go_to_card', cardId: 'card-2' },
      ],
    };
    const first = accepted(setAction(makeStack(), params));
    const second = accepted(setAction(first.stack, params));
    expect(second.stack).toEqual(first.stack);

    const cardParams = { ownerId: 'card-2', handler: [{ type: 'show_message', text: 'hi' }] };
    const firstCard = accepted(setAction(makeStack(), cardParams));
    expect(accepted(setAction(firstCard.stack, cardParams)).stack).toEqual(firstCard.stack);
  });

  it('does not modify its input', () => {
    const stack = deepFreeze(makeStack());
    const snapshot = deepCopy(stack);
    const params = deepFreeze({
      ownerId: 'btn-1',
      handler: [{ type: 'show_message', text: 'x' }],
    });
    accepted(setAction(stack, params));
    expect(stack).toEqual(snapshot);
  });
});

describe('set_action: rejected', () => {
  it('rejects a Field as owner with WRONG_REFERENCE_TYPE at /ownerId', () => {
    const errors = rejected(setAction(makeStack(), { ownerId: 'fld-1', handler: [] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'WRONG_REFERENCE_TYPE', path: '/ownerId' });
  });

  it('rejects a Link as owner with WRONG_REFERENCE_TYPE at /ownerId', () => {
    const errors = rejected(setAction(makeStack(), { ownerId: 'link-1', handler: [] }));
    expect(errors[0]).toMatchObject({ code: 'WRONG_REFERENCE_TYPE', path: '/ownerId' });
  });

  it('rejects an unknown owner with UNKNOWN_ENTITY at /ownerId', () => {
    const errors = rejected(setAction(makeStack(), { ownerId: 'nope', handler: [] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'UNKNOWN_ENTITY', path: '/ownerId' });
  });

  it('rejects an Action that names a missing Object, under /handler/0', () => {
    const stack = makeStack();
    const errors = rejected(
      setAction(stack, {
        ownerId: 'btn-1',
        handler: [{ type: 'set_value', targetObjectId: 'ghost', value: 'x' }],
      }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
    for (const error of errors) expect(error.path.startsWith('/handler/0')).toBe(true);
    expect(errors.some((error) => error.path === '/handler/0/targetObjectId')).toBe(true);
    expect(errors.some((error) => error.code === 'DANGLING_REFERENCE')).toBe(true);
    // The owner keeps its Handler: no Stack is returned and the input is unchanged.
    expect(stack).toEqual(makeStack());
  });

  it('rejects an Action that names a Card where an Object is needed', () => {
    const errors = rejected(
      setAction(makeStack(), {
        ownerId: 'card-1',
        handler: [{ type: 'set_value', targetObjectId: 'card-2', value: 'x' }],
      }),
    );
    expect(errors.some((error) => error.path === '/handler/0/targetObjectId')).toBe(true);
  });

  it('rejects an Action that breaks exactly-one-of, with an error under its own index', () => {
    const errors = rejected(
      setAction(makeStack(), {
        ownerId: 'btn-1',
        handler: [
          { type: 'show_message', text: 'fine' },
          { type: 'set_value', targetObjectId: 'fld-1', value: 'x', fromObjectId: 'lst-1' },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
    for (const error of errors) expect(error.path.startsWith('/handler/1')).toBe(true);
  });

  it('reports at least one error for each violating Action and leaves the rest alone', () => {
    const errors = rejected(
      setAction(makeStack(), {
        ownerId: 'btn-1',
        handler: [
          { type: 'set_value', targetObjectId: 'ghost-a', value: 'x' },
          { type: 'show_message', text: 'fine' },
          { type: 'go_to_card', cardId: 'ghost-b' },
        ],
      }),
    );
    expect(errors.some((error) => error.path.startsWith('/handler/0'))).toBe(true);
    expect(errors.some((error) => error.path.startsWith('/handler/2'))).toBe(true);
    expect(errors.some((error) => error.path.startsWith('/handler/1'))).toBe(false);
  });

  it('rejects a Handler of 21 Actions', () => {
    const handler = Array.from({ length: 21 }, () => ({ type: 'show_message', text: 'x' }));
    const errors = rejected(setAction(makeStack(), { ownerId: 'btn-1', handler }));
    expect(errors.some((error) => error.path.startsWith('/handler'))).toBe(true);
    expect(errors.some((error) => error.code === 'LIMIT_EXCEEDED')).toBe(true);
  });

  it('accepts a Handler of exactly 20 Actions', () => {
    const handler = Array.from({ length: 20 }, () => ({ type: 'show_message', text: 'x' }));
    accepted(setAction(makeStack(), { ownerId: 'btn-1', handler }));
  });

  it('rejects an unknown Action type at /handler/0/type (stage A)', () => {
    const errors = rejected(
      setAction(makeStack(), { ownerId: 'btn-1', handler: [{ type: 'explode' }] }),
    );
    expect(errors.some((error) => error.path === '/handler/0/type')).toBe(true);
  });

  it('rejects missing and unknown parameters at stage A', () => {
    expect(rejected(setAction(makeStack(), { handler: [] }))[0]?.code).toBe('MISSING_PROPERTY');
    expect(rejected(setAction(makeStack(), { ownerId: 'btn-1' }))[0]?.code).toBe(
      'MISSING_PROPERTY',
    );
    expect(
      rejected(setAction(makeStack(), { ownerId: 'btn-1', handler: [], extra: 1 }))[0]?.code,
    ).toBe('UNKNOWN_PROPERTY');
  });
});
