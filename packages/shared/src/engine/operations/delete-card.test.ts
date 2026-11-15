import { describe, expect, it } from 'vitest';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import { validateStack } from '../../format/index.ts';
import type { Stack } from '../../format/index.ts';
import { createStack } from '../create-stack.ts';
import type { OperationResult } from '../operation-result.ts';
import { deleteCardDefinition } from './delete-card.ts';
import { runDefinition } from './definition.ts';

const box = { name: '', x: 0, y: 0, width: 80, height: 24 };

function field(id: string) {
  return {
    ...box,
    id,
    type: 'field' as const,
    value: '',
    placeholder: '',
    multiline: false,
    readOnly: false,
  };
}

function list(id: string) {
  return { ...box, id, type: 'list' as const, items: [], ordered: false };
}

/**
 * Three Cards, start Card `card-1`.
 *
 * - card-1: Buttons `btn-go` (8 Actions, 5 of them refer to card-2 or its Objects) and
 *   `btn-keep`, Links to card-2 and card-3, `onOpen` with one Action that goes to card-2.
 * - card-2: `fld-b2`, `lst-b2`, ai-field `ai-b2` fed by `fld-b2`, Link `lnk-2-1` to card-1.
 * - card-3: Button `btn-3` with a go_to_card to card-2 and one to card-1, Links to card-2 and
 *   card-1, ai-field `ai-3` fed by `fld-3`.
 */
function makeStack(): Stack {
  return {
    ...singleCardStack(),
    cards: [
      {
        id: 'card-1',
        name: 'One',
        objects: [
          {
            ...box,
            id: 'btn-go',
            type: 'button',
            label: 'Go',
            onClick: [
              { type: 'go_to_card', cardId: 'card-2' },
              { type: 'show_message', text: 'keep' },
              { type: 'set_value', targetObjectId: 'fld-home', value: 'x' },
              { type: 'set_value', targetObjectId: 'fld-home', fromObjectId: 'fld-b2' },
              { type: 'append_item', targetObjectId: 'lst-b2', item: 'a' },
              { type: 'schedule_notification', message: 'm', atFromObjectId: 'fld-b2' },
              { type: 'set_value', targetObjectId: 'fld-b2', fromObjectId: 'lst-b2' },
              { type: 'remove_item', targetObjectId: 'lst-home', index: 0 },
            ],
          },
          { ...box, id: 'btn-keep', type: 'button', label: 'Keep', onClick: [] },
          field('fld-home'),
          list('lst-home'),
        ],
        links: [
          { id: 'lnk-1-2', label: 'To two', targetCardId: 'card-2' },
          { id: 'lnk-1-3', label: 'To three', targetCardId: 'card-3' },
        ],
        onOpen: [
          { type: 'go_to_card', cardId: 'card-2' },
          { type: 'show_message', text: 'welcome' },
        ],
      },
      {
        id: 'card-2',
        name: 'Two',
        objects: [
          field('fld-b2'),
          list('lst-b2'),
          {
            ...box,
            id: 'ai-b2',
            type: 'ai-field',
            prompt: 'p',
            inputObjectIds: ['fld-b2'],
            value: '',
          },
        ],
        links: [{ id: 'lnk-2-1', label: 'Back', targetCardId: 'card-1' }],
        onOpen: [],
      },
      {
        id: 'card-3',
        name: 'Three',
        objects: [
          {
            ...box,
            id: 'btn-3',
            type: 'button',
            label: 'Three',
            onClick: [
              { type: 'go_to_card', cardId: 'card-2' },
              { type: 'go_to_card', cardId: 'card-1' },
            ],
          },
          field('fld-3'),
          {
            ...box,
            id: 'ai-3',
            type: 'ai-field',
            prompt: 'p',
            inputObjectIds: ['fld-3'],
            value: '',
          },
        ],
        links: [
          { id: 'lnk-3-2', label: 'To two', targetCardId: 'card-2' },
          { id: 'lnk-3-1', label: 'To one', targetCardId: 'card-1' },
        ],
        onOpen: [],
      },
    ],
  };
}

function singleCardStack(): Stack {
  const result = createStack({ id: 'stack-1', name: 'Solo' });
  if (!result.ok) throw new Error('fixture stack must be valid');
  return result.stack;
}

function remove(stack: Stack, params: unknown): OperationResult {
  return runDefinition(deleteCardDefinition, stack, params);
}

function accepted(result: OperationResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function rejectedErrors(result: OperationResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect('stack' in result).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  return result.errors;
}

function cardIds(stack: Stack): string[] {
  return stack.cards.map((card) => card.id);
}

describe('delete_card: fixtures', () => {
  it('uses valid Stacks', () => {
    expect(validateStack(makeStack()).valid).toBe(true);
    expect(validateStack(singleCardStack()).valid).toBe(true);
  });
});

describe('delete_card: accepted', () => {
  it('deletes a Card that nothing refers to', () => {
    const base = makeStack();
    // card-3 is only the source of Links and Actions, never a target.
    const result = accepted(remove(base, { cardId: 'card-3' }));
    expect(cardIds(result.stack)).toEqual(['card-1', 'card-2']);
    expect(result.stack.startCardId).toBe('card-1');
    expect(result.summary.removed).toEqual([
      'card-3',
      'btn-3',
      'fld-3',
      'ai-3',
      'lnk-3-2',
      'lnk-3-1',
      'lnk-1-3',
    ]);
    expect(result.summary.created).toEqual([]);
    expect(result.summary.removedActions).toBe(0);
    expect(result.summary.updated).toEqual([]);
    // Untouched Cards keep their identity.
    expect(result.stack.cards[1]).toBe(base.cards[1]);
  });

  it('moves startCardId to the first remaining Card when the start Card is deleted', () => {
    const result = accepted(remove(makeStack(), { cardId: 'card-1' }));
    expect(cardIds(result.stack)).toEqual(['card-2', 'card-3']);
    expect(result.stack.startCardId).toBe('card-2');
  });

  it('keeps startCardId when another Card is deleted', () => {
    const result = accepted(remove(makeStack(), { cardId: 'card-2' }));
    expect(result.stack.startCardId).toBe('card-1');
  });

  it('removes Links of other Cards that target the Card, and orders removed ids per Requirement 2.8', () => {
    const result = accepted(remove(makeStack(), { cardId: 'card-2' }));
    expect(result.summary.removed).toEqual([
      'card-2',
      'fld-b2',
      'lst-b2',
      'ai-b2',
      'lnk-2-1',
      'lnk-1-2',
      'lnk-3-2',
    ]);
    expect(result.stack.cards[0]?.links.map((link) => link.id)).toEqual(['lnk-1-3']);
    expect(result.stack.cards[1]?.links.map((link) => link.id)).toEqual(['lnk-3-1']);
  });

  it('removes Actions that refer to the Card or to its Objects and counts each Action once', () => {
    const result = accepted(remove(makeStack(), { cardId: 'card-2' }));
    const [one, three] = result.stack.cards;
    const go = one?.objects.find((object) => object.id === 'btn-go');
    expect(go?.type === 'button' ? go.onClick : undefined).toEqual([
      { type: 'show_message', text: 'keep' },
      { type: 'set_value', targetObjectId: 'fld-home', value: 'x' },
      { type: 'remove_item', targetObjectId: 'lst-home', index: 0 },
    ]);
    expect(one?.onOpen).toEqual([{ type: 'show_message', text: 'welcome' }]);
    const three3 = three?.objects.find((object) => object.id === 'btn-3');
    expect(three3?.type === 'button' ? three3.onClick : undefined).toEqual([
      { type: 'go_to_card', cardId: 'card-1' },
    ]);
    // btn-go loses 5 (cardId, fromObjectId, targetObjectId, atFromObjectId, and one Action
    // with two removed references), card-1 onOpen loses 1, btn-3 loses 1.
    expect(result.summary.removedActions).toBe(7);
  });

  it('lists the owners that lost Actions in document order, each once', () => {
    const result = accepted(remove(makeStack(), { cardId: 'card-2' }));
    expect(result.summary.updated).toEqual(['btn-go', 'card-1', 'btn-3']);
  });

  it('leaves Handlers without references unchanged and keeps their identity', () => {
    const base = makeStack();
    const result = accepted(remove(base, { cardId: 'card-2' }));
    const keep = result.stack.cards[0]?.objects.find((object) => object.id === 'btn-keep');
    expect(keep).toBe(base.cards[0]?.objects.find((object) => object.id === 'btn-keep'));
  });

  it('leaves the ai-field inputObjectIds of remaining Cards unchanged on a valid Stack', () => {
    const base = makeStack();
    const result = accepted(remove(base, { cardId: 'card-2' }));
    const before = base.cards[2]?.objects.find((object) => object.id === 'ai-3');
    const after = result.stack.cards[1]?.objects.find((object) => object.id === 'ai-3');
    expect(after).toBe(before);
    expect(result.summary.updated).not.toContain('ai-3');
  });

  it('filters inputObjectIds that name a deleted Object when a Stack holds such an entry', () => {
    // Not a valid Stack (ai-field inputs must be on the same Card). It shows the filter works
    // as Requirement 2.5 states it.
    const base = makeStack();
    const withCross: Stack = {
      ...base,
      cards: base.cards.map((card) =>
        card.id === 'card-3'
          ? {
              ...card,
              objects: card.objects.map((object) =>
                object.id === 'ai-3' && object.type === 'ai-field'
                  ? { ...object, inputObjectIds: ['fld-b2', 'fld-3'] }
                  : object,
              ),
            }
          : card,
      ),
    };
    const result = accepted(remove(withCross, { cardId: 'card-2' }));
    const ai = result.stack.cards[1]?.objects.find((object) => object.id === 'ai-3');
    expect(ai?.type === 'ai-field' ? ai.inputObjectIds : undefined).toEqual(['fld-3']);
    expect(result.summary.updated).toContain('ai-3');
  });

  it('deletes the second-to-last Card and leaves a one-Card Stack', () => {
    const two: Stack = { ...makeStack(), cards: makeStack().cards.slice(0, 2) };
    const stack: Stack = {
      ...two,
      cards: two.cards.map((card) => ({
        ...card,
        objects: card.objects.filter((object) => object.type !== 'button'),
        links: card.links.filter((link) => link.targetCardId !== 'card-3'),
        onOpen: [],
      })),
    };
    expect(validateStack(stack).valid).toBe(true);
    const result = accepted(remove(stack, { cardId: 'card-1' }));
    expect(cardIds(result.stack)).toEqual(['card-2']);
    expect(result.stack.startCardId).toBe('card-2');
  });

  it('does not modify a frozen input Stack and is deterministic', () => {
    const stack = deepFreeze(makeStack());
    const copy = deepCopy(stack);
    const first = remove(stack, { cardId: 'card-2' });
    accepted(first);
    expect(stack).toEqual(copy);
    expect(remove(stack, { cardId: 'card-2' })).toEqual(first);
  });
});

describe('delete_card: rejected', () => {
  it('reports an unknown id as UNKNOWN_ENTITY at /cardId', () => {
    const [error] = rejectedErrors(remove(makeStack(), { cardId: 'nope' }));
    expect(error?.code).toBe('UNKNOWN_ENTITY');
    expect(error?.path).toBe('/cardId');
    expect(error?.hint).toContain('card-1');
  });

  it('reports the id of an Object or a Link as UNKNOWN_ENTITY at /cardId', () => {
    for (const cardId of ['fld-b2', 'lnk-2-1']) {
      const [error] = rejectedErrors(remove(makeStack(), { cardId }));
      expect(error?.code).toBe('UNKNOWN_ENTITY');
      expect(error?.path).toBe('/cardId');
    }
  });

  it('reports the only Card as LIMIT_EXCEEDED at /cardId', () => {
    const stack = singleCardStack();
    const [error] = rejectedErrors(remove(stack, { cardId: stack.startCardId }));
    expect(error?.code).toBe('LIMIT_EXCEEDED');
    expect(error?.path).toBe('/cardId');
  });

  it('reports an unknown id on a one-Card Stack as UNKNOWN_ENTITY', () => {
    const [error] = rejectedErrors(remove(singleCardStack(), { cardId: 'nope' }));
    expect(error?.code).toBe('UNKNOWN_ENTITY');
  });

  it('reports a missing, mistyped or extra parameter from the schema', () => {
    const [missing] = rejectedErrors(remove(makeStack(), {}));
    expect(missing?.code).toBe('MISSING_PROPERTY');
    const [wrong] = rejectedErrors(remove(makeStack(), { cardId: 5 }));
    expect(wrong?.code).toBe('WRONG_TYPE');
    expect(wrong?.path).toBe('/cardId');
    const [extra] = rejectedErrors(remove(makeStack(), { cardId: 'card-2', extra: true }));
    expect(extra?.code).toBe('UNKNOWN_PROPERTY');
  });

  it('leaves a frozen input Stack unchanged on rejection', () => {
    const stack = deepFreeze(singleCardStack());
    const copy = deepCopy(stack);
    rejectedErrors(remove(stack, { cardId: stack.startCardId }));
    expect(stack).toEqual(copy);
  });
});
