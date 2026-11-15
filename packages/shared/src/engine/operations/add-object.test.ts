import { describe, expect, it } from 'vitest';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import { validateStack } from '../../format/index.ts';
import type { Stack, StackObject } from '../../format/index.ts';
import { createStack } from '../create-stack.ts';
import type { OperationResult } from '../operation-result.ts';
import { addObjectDefinition } from './add-object.ts';
import { runDefinition } from './definition.ts';
import { OBJECT_DEFAULTS } from './object-defaults.ts';

function emptyCard(id: string, name: string) {
  return { id, name, objects: [], links: [], onOpen: [] };
}

function button(id: string): StackObject {
  return {
    id,
    type: 'button',
    name: '',
    x: 0,
    y: 0,
    width: 80,
    height: 24,
    label: 'Go',
    onClick: [],
  };
}

/** Cards card-1 (empty), card-2 (objects obj-1, obj-2 and the Link link-1) and card-3 (empty). */
function makeStack(): Stack {
  const result = createStack({ id: 'stack-1', name: 'Test' });
  if (!result.ok) throw new Error('fixture stack must be valid');
  const [first] = result.stack.cards;
  if (first === undefined) throw new Error('fixture stack must have a card');
  return {
    ...result.stack,
    cards: [
      first,
      {
        ...emptyCard('card-2', 'Two'),
        objects: [button('obj-1'), button('obj-2')],
        links: [{ id: 'link-1', label: 'Back', targetCardId: 'card-1' }],
      },
      emptyCard('card-3', 'Three'),
    ],
  };
}

function stackWithObjects(count: number): Stack {
  const base = makeStack();
  const objects = Array.from({ length: count }, (_, n) => button(`full-${n + 1}`));
  return {
    ...base,
    cards: base.cards.map((card) => (card.id === 'card-3' ? { ...card, objects } : card)),
  };
}

const GEOMETRY = { x: 10, y: 20, width: 100, height: 40 };

function add(stack: Stack, params: unknown): OperationResult {
  return runDefinition(addObjectDefinition, stack, params);
}

function objectIds(stack: Stack, cardId: string): string[] {
  return (stack.cards.find((card) => card.id === cardId)?.objects ?? []).map((o) => o.id);
}

function expectAccepted(result: OperationResult): Stack {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  expect(validateStack(result.stack).valid).toBe(true);
  return result.stack;
}

function expectRejected(result: OperationResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect('stack' in result).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  return result.errors;
}

describe('add_object: accepted', () => {
  const cases: ReadonlyArray<{ type: string; extra: Record<string, unknown> }> = [
    { type: 'button', extra: { label: 'Go' } },
    { type: 'field', extra: {} },
    { type: 'image', extra: { src: 'https://example.com/a.png' } },
    { type: 'list', extra: {} },
    { type: 'ai-field', extra: { prompt: 'Summarize' } },
  ];

  for (const { type, extra } of cases) {
    it(`adds a ${type} with the defaults for every omitted optional property`, () => {
      const result = add(makeStack(), {
        cardId: 'card-1',
        type,
        id: 'new-obj',
        ...GEOMETRY,
        ...extra,
      });
      const stack = expectAccepted(result);
      const added = stack.cards[0]?.objects[0];
      const defaults = OBJECT_DEFAULTS[type as keyof typeof OBJECT_DEFAULTS];
      expect(added).toEqual({ id: 'new-obj', type, ...GEOMETRY, ...defaults, ...extra });
      if (result.ok) {
        expect(result.summary).toEqual({
          created: ['new-obj'],
          updated: [],
          removed: [],
          removedActions: 0,
        });
      }
    });
  }

  it('keeps supplied optional properties instead of the defaults', () => {
    const stack = expectAccepted(
      add(makeStack(), {
        cardId: 'card-1',
        type: 'list',
        ...GEOMETRY,
        name: 'Todo',
        items: ['a', 'b'],
        ordered: true,
      }),
    );
    expect(stack.cards[0]?.objects[0]).toMatchObject({
      name: 'Todo',
      items: ['a', 'b'],
      ordered: true,
    });
  });

  it('assigns the smallest unused obj-<n> when id is omitted', () => {
    const stack = expectAccepted(
      add(makeStack(), { cardId: 'card-1', type: 'field', ...GEOMETRY }),
    );
    expect(objectIds(stack, 'card-1')).toEqual(['obj-3']);
  });

  it('fills a gap in the obj-<n> sequence', () => {
    const base = makeStack();
    const gapped: Stack = {
      ...base,
      cards: base.cards.map((card) =>
        card.id === 'card-2' ? { ...card, objects: [button('obj-1'), button('obj-3')] } : card,
      ),
    };
    const stack = expectAccepted(add(gapped, { cardId: 'card-1', type: 'field', ...GEOMETRY }));
    expect(objectIds(stack, 'card-1')).toEqual(['obj-2']);
  });

  it('inserts at the start, in the middle, and at the end', () => {
    const at = (index: number) =>
      objectIds(
        expectAccepted(
          add(makeStack(), { cardId: 'card-2', type: 'field', id: 'new', index, ...GEOMETRY }),
        ),
        'card-2',
      );
    expect(at(0)).toEqual(['new', 'obj-1', 'obj-2']);
    expect(at(1)).toEqual(['obj-1', 'new', 'obj-2']);
    expect(at(2)).toEqual(['obj-1', 'obj-2', 'new']);
  });

  it('adds at the end when index is omitted', () => {
    const stack = expectAccepted(
      add(makeStack(), { cardId: 'card-2', type: 'field', id: 'new', ...GEOMETRY }),
    );
    expect(objectIds(stack, 'card-2')).toEqual(['obj-1', 'obj-2', 'new']);
  });

  it('leaves the other Cards and Objects unchanged', () => {
    const before = makeStack();
    const after = expectAccepted(
      add(before, { cardId: 'card-2', type: 'field', id: 'new', ...GEOMETRY }),
    );
    expect(after.cards[0]).toBe(before.cards[0]);
    expect(after.cards[2]).toBe(before.cards[2]);
    expect(after.cards[1]?.objects.slice(0, 2)).toEqual(before.cards[1]?.objects);
    expect(after.cards[1]?.links).toEqual(before.cards[1]?.links);
  });

  it('does not share defaults arrays with the frozen table or between calls', () => {
    const first = expectAccepted(add(makeStack(), { cardId: 'card-1', type: 'list', ...GEOMETRY }));
    const second = expectAccepted(
      add(makeStack(), { cardId: 'card-1', type: 'list', ...GEOMETRY }),
    );
    const a = first.cards[0]?.objects[0];
    const b = second.cards[0]?.objects[0];
    if (a?.type !== 'list' || b?.type !== 'list') throw new Error('expected lists');
    expect(a.items).not.toBe(OBJECT_DEFAULTS.list.items);
    expect(a.items).not.toBe(b.items);
    expect(Object.isFrozen(a.items)).toBe(false);

    const btn = expectAccepted(
      add(makeStack(), { cardId: 'card-1', type: 'button', label: 'x', ...GEOMETRY }),
    ).cards[0]?.objects[0];
    if (btn?.type !== 'button') throw new Error('expected button');
    expect(btn.onClick).not.toBe(OBJECT_DEFAULTS.button.onClick);
  });

  it('accepts an Object that touches the Card edge and the 100th Object', () => {
    const edge = expectAccepted(
      add(makeStack(), { cardId: 'card-1', type: 'field', x: 412, y: 302, width: 100, height: 40 }),
    );
    expect(objectIds(edge, 'card-1')).toHaveLength(1);
    const hundred = expectAccepted(
      add(stackWithObjects(99), { cardId: 'card-3', type: 'field', ...GEOMETRY }),
    );
    expect(objectIds(hundred, 'card-3')).toHaveLength(100);
  });

  it('does not modify a frozen input Stack and is deterministic', () => {
    const stack = deepFreeze(makeStack());
    const copy = deepCopy(stack);
    const params = { cardId: 'card-2', type: 'button', label: 'x', index: 1, ...GEOMETRY };
    const first = add(stack, params);
    expectAccepted(first);
    expect(stack).toEqual(copy);
    expect(add(stack, params)).toEqual(first);
  });
});

describe('add_object: rejected', () => {
  it('reports an unknown type as INVALID_VALUE at /type', () => {
    const [error] = expectRejected(
      add(makeStack(), { cardId: 'card-1', type: 'slider', ...GEOMETRY }),
    );
    expect(error?.code).toBe('INVALID_VALUE');
    expect(error?.path).toBe('/type');
  });

  it('reports a missing label for a button as MISSING_PROPERTY', () => {
    const [error] = expectRejected(
      add(makeStack(), { cardId: 'card-1', type: 'button', ...GEOMETRY }),
    );
    expect(error?.code).toBe('MISSING_PROPERTY');
    expect(error?.message).toContain('label');
  });

  it('reports a missing src for an image as MISSING_PROPERTY', () => {
    const [error] = expectRejected(
      add(makeStack(), { cardId: 'card-1', type: 'image', ...GEOMETRY }),
    );
    expect(error?.code).toBe('MISSING_PROPERTY');
    expect(error?.message).toContain('src');
  });

  it('reports a missing prompt for an ai-field as MISSING_PROPERTY', () => {
    const [error] = expectRejected(
      add(makeStack(), { cardId: 'card-1', type: 'ai-field', ...GEOMETRY }),
    );
    expect(error?.code).toBe('MISSING_PROPERTY');
    expect(error?.message).toContain('prompt');
  });

  it('reports a property of another type as UNKNOWN_PROPERTY at that property', () => {
    const [error] = expectRejected(
      add(makeStack(), { cardId: 'card-1', type: 'field', label: 'x', ...GEOMETRY }),
    );
    expect(error?.code).toBe('UNKNOWN_PROPERTY');
    expect(error?.path).toBe('/label');
  });

  it('reports a bad value of a type property as INVALID_VALUE or LIMIT_EXCEEDED at that property', () => {
    const [error] = expectRejected(
      add(makeStack(), {
        cardId: 'card-1',
        type: 'image',
        src: 'http://example.com/a.png',
        ...GEOMETRY,
      }),
    );
    expect(error?.path).toBe('/src');
    expect(['INVALID_VALUE', 'LIMIT_EXCEEDED']).toContain(error?.code);
  });

  it('reports an unknown Card as UNKNOWN_ENTITY at /cardId, also for an Object id', () => {
    for (const cardId of ['nope', 'obj-1']) {
      const [error] = expectRejected(add(makeStack(), { cardId, type: 'field', ...GEOMETRY }));
      expect(error?.code).toBe('UNKNOWN_ENTITY');
      expect(error?.path).toBe('/cardId');
    }
  });

  it('reports a Card with 100 Objects as LIMIT_EXCEEDED at /cardId', () => {
    const [error] = expectRejected(
      add(stackWithObjects(100), { cardId: 'card-3', type: 'field', ...GEOMETRY }),
    );
    expect(error?.code).toBe('LIMIT_EXCEEDED');
    expect(error?.path).toBe('/cardId');
  });

  it('reports an index above the Object count as OUT_OF_RANGE at /index', () => {
    const [error] = expectRejected(
      add(makeStack(), { cardId: 'card-2', type: 'field', index: 3, ...GEOMETRY }),
    );
    expect(error?.code).toBe('OUT_OF_RANGE');
    expect(error?.path).toBe('/index');
    expect(error?.actual).toBe('3');
  });

  it('reports a negative or fractional index as OUT_OF_RANGE and a string index as WRONG_TYPE', () => {
    for (const index of [-1, 0.5]) {
      const [error] = expectRejected(
        add(makeStack(), { cardId: 'card-2', type: 'field', index, ...GEOMETRY }),
      );
      expect(error?.code).toBe('OUT_OF_RANGE');
      expect(error?.path).toBe('/index');
    }
    const [wrong] = expectRejected(
      add(makeStack(), { cardId: 'card-2', type: 'field', index: '1', ...GEOMETRY }),
    );
    expect(wrong?.code).toBe('WRONG_TYPE');
    expect(wrong?.path).toBe('/index');
  });

  it('reports an id used by a Card, an Object or a Link as DUPLICATE_ID at /id', () => {
    for (const id of ['card-1', 'obj-1', 'link-1']) {
      const [error] = expectRejected(
        add(makeStack(), { cardId: 'card-1', type: 'field', id, ...GEOMETRY }),
      );
      expect(error?.code).toBe('DUPLICATE_ID');
      expect(error?.path).toBe('/id');
    }
  });

  it('maps an Object that does not fit the Card to the parameters root', () => {
    const [error] = expectRejected(
      add(makeStack(), { cardId: 'card-1', type: 'field', x: 500, y: 0, width: 100, height: 40 }),
    );
    expect(error?.code).toBe('OUT_OF_BOUNDS');
    expect(error?.path).toBe('');
  });

  it('maps an ai-field input on another Card to /inputObjectIds', () => {
    const errors = expectRejected(
      add(makeStack(), {
        cardId: 'card-1',
        type: 'ai-field',
        prompt: 'Summarize',
        inputObjectIds: ['obj-1'],
        ...GEOMETRY,
      }),
    );
    expect(errors.some((error) => error.path.startsWith('/inputObjectIds'))).toBe(true);
  });

  it('maps a dangling Handler reference to /onClick', () => {
    const errors = expectRejected(
      add(makeStack(), {
        cardId: 'card-1',
        type: 'button',
        label: 'Go',
        onClick: [{ type: 'go_to_card', cardId: 'missing' }],
        ...GEOMETRY,
      }),
    );
    expect(errors.some((error) => error.path.startsWith('/onClick'))).toBe(true);
  });

  it('collects precondition and candidate errors together and leaves the input unchanged', () => {
    const stack = deepFreeze(makeStack());
    const copy = deepCopy(stack);
    const errors = expectRejected(
      add(stack, { cardId: 'card-2', type: 'button', id: 'obj-1', index: 9, ...GEOMETRY }),
    );
    expect(errors.map((error) => `${error.code}@${error.path}`).sort()).toEqual([
      'DUPLICATE_ID@/id',
      'MISSING_PROPERTY@',
      'OUT_OF_RANGE@/index',
    ]);
    expect(stack).toEqual(copy);
  });
});
