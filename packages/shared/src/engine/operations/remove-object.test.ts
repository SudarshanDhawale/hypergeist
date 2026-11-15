import { describe, expect, it } from 'vitest';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import type { Card, Stack, StackObject } from '../../format/index.ts';
import { validateStack } from '../../format/index.ts';
import type { OperationResult } from '../operation-result.ts';
import { runDefinition } from './definition.ts';
import { removeObjectDefinition } from './remove-object.ts';

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

function aiField(id: string, inputObjectIds: string[]): StackObject {
  return { id, type: 'ai-field', name: '', ...BOX, prompt: 'Summarize', inputObjectIds, value: '' };
}

/**
 * card-1 holds fld-1, lst-1, btn-1, btn-2, ai-1 (inputs fld-1, lst-1), ai-2 (input lst-1) and an
 * onOpen that touches fld-1. card-2 holds btn-3 and an onOpen that touches fld-1.
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
            { type: 'set_value', targetObjectId: 'fld-1', value: 'x' },
            { type: 'show_message', text: 'hi' },
            { type: 'append_item', targetObjectId: 'lst-1', fromObjectId: 'fld-1' },
            { type: 'schedule_notification', message: 'ping', atFromObjectId: 'fld-1' },
            { type: 'append_item', targetObjectId: 'lst-1', item: 'kept' },
          ]),
          button('btn-2', [{ type: 'go_to_card', cardId: 'card-2' }]),
          aiField('ai-1', ['fld-1', 'lst-1']),
          aiField('ai-2', ['lst-1']),
        ],
        links: [{ id: 'link-1', label: 'Next', targetCardId: 'card-2' }],
        onOpen: [
          { type: 'set_value', targetObjectId: 'fld-1', value: 'open' },
          { type: 'show_message', text: 'welcome' },
        ],
      },
      {
        id: 'card-2',
        name: 'Two',
        objects: [button('btn-3', [{ type: 'set_value', targetObjectId: 'fld-1', value: 'y' }])],
        links: [],
        onOpen: [{ type: 'run_ai_field', targetObjectId: 'ai-1' }],
      },
    ],
  };
}

function remove(stack: Stack, params: unknown): OperationResult {
  return runDefinition(removeObjectDefinition, stack, params);
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

function objectIds(stack: Stack, cardId: string): string[] {
  const card = stack.cards.find((candidate) => candidate.id === cardId);
  return card === undefined ? [] : card.objects.map((object) => object.id);
}

function findObject(stack: Stack, id: string): StackObject {
  for (const card of stack.cards) {
    const found = card.objects.find((object) => object.id === id);
    if (found !== undefined) return found;
  }
  throw new Error(`no Object ${id}`);
}

describe('remove_object: accepted', () => {
  it('removes a plain Object that nothing refers to', () => {
    const result = accepted(remove(makeStack(), { objectId: 'btn-2' }));
    expect(objectIds(result.stack, 'card-1')).toEqual(['fld-1', 'lst-1', 'btn-1', 'ai-1', 'ai-2']);
    expect(result.summary).toEqual({
      created: [],
      updated: [],
      removed: ['btn-2'],
      removedActions: 0,
    });
    expect(validateStack(result.stack).valid).toBe(true);
  });

  it('removes a Field and prunes every Action that refers to it, in every Handler', () => {
    const result = accepted(remove(makeStack(), { objectId: 'fld-1' }));
    const btn1 = findObject(result.stack, 'btn-1');
    expect(btn1.type === 'button' && btn1.onClick).toEqual([
      { type: 'show_message', text: 'hi' },
      { type: 'append_item', targetObjectId: 'lst-1', item: 'kept' },
    ]);
    const [card1, card2] = result.stack.cards;
    expect(card1?.onOpen).toEqual([{ type: 'show_message', text: 'welcome' }]);
    const btn3 = findObject(result.stack, 'btn-3');
    expect(btn3.type === 'button' && btn3.onClick).toEqual([]);
    expect(card2?.onOpen).toEqual([{ type: 'run_ai_field', targetObjectId: 'ai-1' }]);
    expect(validateStack(result.stack).valid).toBe(true);
  });

  it('counts each pruned Action once and lists the owners that changed', () => {
    const result = accepted(remove(makeStack(), { objectId: 'fld-1' }));
    // btn-1 loses set_value, append_item (fromObjectId) and schedule_notification; card-1 onOpen
    // loses one; btn-3 loses one.
    expect(result.summary.removedActions).toBe(5);
    expect(result.summary.removed).toEqual(['fld-1']);
    expect(result.summary.created).toEqual([]);
    expect(result.summary.updated).toEqual(['btn-1', 'ai-1', 'card-1', 'btn-3']);
  });

  it('removes the id from the inputObjectIds of every ai-field', () => {
    const result = accepted(remove(makeStack(), { objectId: 'lst-1' }));
    const ai1 = findObject(result.stack, 'ai-1');
    const ai2 = findObject(result.stack, 'ai-2');
    expect(ai1.type === 'ai-field' && ai1.inputObjectIds).toEqual(['fld-1']);
    expect(ai2.type === 'ai-field' && ai2.inputObjectIds).toEqual([]);
    expect(result.summary.updated).toContain('ai-1');
    expect(result.summary.updated).toContain('ai-2');
    expect(validateStack(result.stack).valid).toBe(true);
  });

  it('removes a Button and its own Handler without counting it as pruned', () => {
    const result = accepted(remove(makeStack(), { objectId: 'btn-1' }));
    expect(objectIds(result.stack, 'card-1')).not.toContain('btn-1');
    expect(result.summary).toEqual({
      created: [],
      updated: [],
      removed: ['btn-1'],
      removedActions: 0,
    });
  });

  it('removes an ai-field that another Handler runs', () => {
    const result = accepted(remove(makeStack(), { objectId: 'ai-1' }));
    expect(result.stack.cards[1]?.onOpen).toEqual([]);
    expect(result.summary).toEqual({
      created: [],
      updated: ['card-2'],
      removed: ['ai-1'],
      removedActions: 1,
    });
  });

  it('keeps the identity of Cards and Objects that lose nothing', () => {
    const stack = makeStack();
    const result = accepted(remove(stack, { objectId: 'btn-3' }));
    expect(result.stack.cards[0]).toBe(stack.cards[0]);
    expect(result.stack.cards[1]?.links).toBe(stack.cards[1]?.links);
  });

  it('leaves the Cards, Links and start Card as they were', () => {
    const stack = makeStack();
    const result = accepted(remove(stack, { objectId: 'fld-1' }));
    expect(result.stack.cards.map((card) => card.id)).toEqual(['card-1', 'card-2']);
    expect(result.stack.cards[0]?.links).toEqual(stack.cards[0]?.links);
    expect(result.stack.startCardId).toBe('card-1');
  });

  it('accepts every existing Object', () => {
    const stack = makeStack();
    for (const card of stack.cards) {
      for (const object of card.objects) {
        expect(remove(stack, { objectId: object.id }).ok).toBe(true);
      }
    }
  });

  it('does not modify its input', () => {
    const stack = deepFreeze(makeStack());
    const before = deepCopy(stack);
    accepted(remove(stack, { objectId: 'fld-1' }));
    expect(stack).toEqual(before);
  });
});

describe('remove_object: rejected', () => {
  it('rejects an unknown id with UNKNOWN_ENTITY at /objectId', () => {
    const errors = rejected(remove(makeStack(), { objectId: 'nope' }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('UNKNOWN_ENTITY');
    expect(errors[0]?.path).toBe('/objectId');
    expect(errors[0]?.actual).toBe('"nope"');
    expect(errors[0]?.hint).toContain('fld-1');
  });

  it('rejects a Card id with UNKNOWN_ENTITY at /objectId', () => {
    const errors = rejected(remove(makeStack(), { objectId: 'card-1' }));
    expect(errors[0]?.code).toBe('UNKNOWN_ENTITY');
    expect(errors[0]?.path).toBe('/objectId');
  });

  it('rejects a Link id with UNKNOWN_ENTITY at /objectId', () => {
    const errors = rejected(remove(makeStack(), { objectId: 'link-1' }));
    expect(errors[0]?.code).toBe('UNKNOWN_ENTITY');
    expect(errors[0]?.path).toBe('/objectId');
  });

  it('rejects a missing objectId and an unknown parameter at stage A', () => {
    const missing = rejected(remove(makeStack(), {}));
    expect(missing[0]?.code).toBe('MISSING_PROPERTY');
    const extra = rejected(remove(makeStack(), { objectId: 'fld-1', extra: 1 }));
    expect(extra[0]?.code).toBe('UNKNOWN_PROPERTY');
  });
});
