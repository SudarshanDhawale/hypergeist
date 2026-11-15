import { describe, expect, it } from 'vitest';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import type { Stack } from '../../format/index.ts';
import { createStack } from '../create-stack.ts';
import type { OperationResult } from '../operation-result.ts';
import { createCardDefinition } from './create-card.ts';
import { runDefinition } from './definition.ts';

function emptyCard(id: string, name: string) {
  return { id, name, objects: [], links: [], onOpen: [] };
}

/** Stack with cards card-1, card-2, card-3. card-2 owns the Object `obj-1` and the Link `link-1`. */
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
        objects: [
          {
            id: 'obj-1',
            type: 'button' as const,
            name: '',
            x: 0,
            y: 0,
            width: 80,
            height: 24,
            label: 'Go',
            onClick: [],
          },
        ],
        links: [{ id: 'link-1', label: 'Back', targetCardId: 'card-1' }],
      },
      emptyCard('card-3', 'Three'),
    ],
  };
}

function makeFullStack(): Stack {
  const base = makeStack();
  const cards = [...base.cards];
  for (let n = cards.length + 1; n <= 200; n += 1) {
    cards.push(emptyCard(`card-${n}`, `Card ${n}`));
  }
  return { ...base, cards };
}

function create(stack: Stack, params: unknown): OperationResult {
  return runDefinition(createCardDefinition, stack, params);
}

function ids(stack: Stack): string[] {
  return stack.cards.map((card) => card.id);
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

describe('create_card: accepted', () => {
  it('inserts at the start and shifts the other Cards later', () => {
    const stack = expectAccepted(create(makeStack(), { name: 'New', id: 'first', index: 0 }));
    expect(ids(stack)).toEqual(['first', 'card-1', 'card-2', 'card-3']);
    expect(stack.cards[0]).toEqual(emptyCard('first', 'New'));
  });

  it('inserts in the middle', () => {
    const stack = expectAccepted(create(makeStack(), { name: 'New', id: 'mid', index: 1 }));
    expect(ids(stack)).toEqual(['card-1', 'mid', 'card-2', 'card-3']);
  });

  it('inserts at the end when index equals the Card count', () => {
    const stack = expectAccepted(create(makeStack(), { name: 'New', id: 'last', index: 3 }));
    expect(ids(stack)).toEqual(['card-1', 'card-2', 'card-3', 'last']);
  });

  it('adds at the end when index is omitted', () => {
    const stack = expectAccepted(create(makeStack(), { name: 'New', id: 'last' }));
    expect(ids(stack)).toEqual(['card-1', 'card-2', 'card-3', 'last']);
  });

  it('creates an empty Card and reports it in the summary', () => {
    const result = create(makeStack(), { name: 'New', id: 'fresh' });
    const stack = expectAccepted(result);
    if (!result.ok) return;
    expect(stack.cards[3]).toEqual({
      id: 'fresh',
      name: 'New',
      objects: [],
      links: [],
      onOpen: [],
    });
    expect(result.summary).toEqual({
      created: ['fresh'],
      updated: [],
      removed: [],
      removedActions: 0,
    });
  });

  it('assigns the smallest unused card-<n> when id is omitted, including ids held by other kinds', () => {
    const base = makeStack();
    // card-1..card-3 are Cards. Remove card-2 from the Card ids by renaming it to something else,
    // so card-2 is free, and make the free-slot search skip ids used by an Object or Link.
    const stack: Stack = {
      ...base,
      cards: base.cards.map((card) =>
        card.id === 'card-2'
          ? {
              ...card,
              id: 'other',
              objects: card.objects.map((object) => ({ ...object, id: 'card-4' })),
              links: card.links.map((link) => ({ ...link, id: 'card-2' })),
            }
          : card,
      ),
    };
    const created = expectAccepted(create(stack, { name: 'New' }));
    expect(ids(created)).toEqual(['card-1', 'other', 'card-3', 'card-5']);
  });

  it('assigns card-<n> in the default case', () => {
    const stack = expectAccepted(create(makeStack(), { name: 'New' }));
    expect(ids(stack)).toEqual(['card-1', 'card-2', 'card-3', 'card-4']);
  });

  it('leaves startCardId and the other Cards unchanged', () => {
    const before = makeStack();
    const after = expectAccepted(create(before, { name: 'New', index: 0 }));
    expect(after.startCardId).toBe(before.startCardId);
    expect(after.cards.slice(1)).toEqual(before.cards);
  });

  it('accepts a name of 100 characters and the 200th Card', () => {
    const base = makeFullStack();
    const almostFull: Stack = { ...base, cards: base.cards.slice(0, 199) };
    const stack = expectAccepted(create(almostFull, { name: 'n'.repeat(100) }));
    expect(stack.cards).toHaveLength(200);
  });

  it('does not modify a frozen input Stack', () => {
    const stack = deepFreeze(makeStack());
    const copy = deepCopy(stack);
    expectAccepted(create(stack, { name: 'New', index: 1 }));
    expect(stack).toEqual(copy);
  });

  it('is deterministic', () => {
    const stack = makeStack();
    expect(create(stack, { name: 'New' })).toEqual(create(stack, { name: 'New' }));
  });
});

describe('create_card: rejected', () => {
  it('reports a missing name as MISSING_PROPERTY at the parameters root', () => {
    const [error] = expectRejected(create(makeStack(), {}));
    expect(error?.code).toBe('MISSING_PROPERTY');
    expect(error?.path).toBe('');
  });

  it('reports an empty name as INVALID_VALUE', () => {
    const [error] = expectRejected(create(makeStack(), { name: '' }));
    expect(error?.code).toBe('INVALID_VALUE');
    expect(error?.path).toBe('/name');
  });

  it('reports a name of 101 characters as LIMIT_EXCEEDED', () => {
    const [error] = expectRejected(create(makeStack(), { name: 'n'.repeat(101) }));
    expect(error?.code).toBe('LIMIT_EXCEEDED');
    expect(error?.path).toBe('/name');
  });

  it('reports an id with a bad pattern as INVALID_VALUE', () => {
    const [error] = expectRejected(create(makeStack(), { name: 'New', id: 'Bad Id' }));
    expect(error?.code).toBe('INVALID_VALUE');
    expect(error?.path).toBe('/id');
  });

  it('reports an id used by a Card as DUPLICATE_ID at /id and keeps the existing Card', () => {
    const stack = makeStack();
    const copy = deepCopy(stack);
    const [error] = expectRejected(create(stack, { name: 'New', id: 'card-2' }));
    expect(error?.code).toBe('DUPLICATE_ID');
    expect(error?.path).toBe('/id');
    expect(error?.actual).toBe('"card-2"');
    expect(stack).toEqual(copy);
  });

  it('reports an id used by an Object or a Link as DUPLICATE_ID', () => {
    for (const id of ['obj-1', 'link-1']) {
      const [error] = expectRejected(create(makeStack(), { name: 'New', id }));
      expect(error?.code).toBe('DUPLICATE_ID');
      expect(error?.path).toBe('/id');
    }
  });

  it('reports index -1 and 1.5 as OUT_OF_RANGE at /index', () => {
    for (const index of [-1, 1.5]) {
      const [error] = expectRejected(create(makeStack(), { name: 'New', index }));
      expect(error?.code).toBe('OUT_OF_RANGE');
      expect(error?.path).toBe('/index');
    }
  });

  it('reports an index above the Card count as OUT_OF_RANGE at /index', () => {
    const [error] = expectRejected(create(makeStack(), { name: 'New', index: 4 }));
    expect(error?.code).toBe('OUT_OF_RANGE');
    expect(error?.path).toBe('/index');
    expect(error?.actual).toBe('4');
  });

  it('reports an index that is a string as WRONG_TYPE', () => {
    const [error] = expectRejected(create(makeStack(), { name: 'New', index: '1' }));
    expect(error?.code).toBe('WRONG_TYPE');
    expect(error?.path).toBe('/index');
  });

  it('reports an unknown parameter as UNKNOWN_PROPERTY', () => {
    const [error] = expectRejected(create(makeStack(), { name: 'New', extra: true }));
    expect(error?.code).toBe('UNKNOWN_PROPERTY');
  });

  it('reports a Stack with 200 Cards as LIMIT_EXCEEDED at the parameters root', () => {
    const stack = makeFullStack();
    expect(stack.cards).toHaveLength(200);
    const [error] = expectRejected(create(stack, { name: 'New' }));
    expect(error?.code).toBe('LIMIT_EXCEEDED');
    expect(error?.path).toBe('');
  });

  it('collects the precondition errors together', () => {
    const errors = expectRejected(
      create(makeFullStack(), { name: 'New', id: 'card-1', index: 201 }),
    );
    expect(errors.map((error) => `${error.code}@${error.path}`).sort()).toEqual([
      'DUPLICATE_ID@/id',
      'LIMIT_EXCEEDED@',
      'OUT_OF_RANGE@/index',
    ]);
  });
});
