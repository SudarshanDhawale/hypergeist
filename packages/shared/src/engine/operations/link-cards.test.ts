import { describe, expect, it } from 'vitest';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import type { Link, Stack } from '../../format/index.ts';
import { createStack } from '../create-stack.ts';
import type { OperationResult } from '../operation-result.ts';
import { runDefinition } from './definition.ts';
import { linkCardsDefinition } from './link-cards.ts';

function emptyCard(id: string, name: string) {
  return { id, name, objects: [], links: [] as Link[], onOpen: [] };
}

/** Cards card-1, card-2, card-3. card-2 has the Object `obj-1` and the Link `link-1` to card-1. */
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

/**
 * Same Stack plus 48 Cards, so 51 Cards in all. card-3 has 50 Links, one to each of the first 50
 * Cards (itself included), because a Card may have only one Link per target. `extra-47` is the
 * 50th target and `extra-48` is not linked yet.
 */
function makeStackWithFullCard(): Stack {
  const base = makeStack();
  const extra = Array.from({ length: 48 }, (_, i) => emptyCard(`extra-${i + 1}`, `Extra ${i + 1}`));
  const cards = [...base.cards, ...extra];
  const links: Link[] = cards.slice(0, 50).map((card, i) => ({
    id: `fill-${i + 1}`,
    label: `To ${card.id}`,
    targetCardId: card.id,
  }));
  return {
    ...base,
    cards: cards.map((card) => (card.id === 'card-3' ? { ...card, links } : card)),
  };
}

function link(stack: Stack, params: unknown): OperationResult {
  return runDefinition(linkCardsDefinition, stack, params);
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

function linksOf(stack: Stack, cardId: string): readonly Link[] {
  return stack.cards.find((card) => card.id === cardId)?.links ?? [];
}

describe('link_cards: accepted', () => {
  it('appends the Link last with the next free link-<n> id', () => {
    const result = link(makeStack(), { fromCardId: 'card-2', toCardId: 'card-3', label: 'Next' });
    const stack = expectAccepted(result);
    expect(linksOf(stack, 'card-2')).toEqual([
      { id: 'link-1', label: 'Back', targetCardId: 'card-1' },
      { id: 'link-2', label: 'Next', targetCardId: 'card-3' },
    ]);
    if (!result.ok) return;
    expect(result.summary).toEqual({
      created: ['link-2'],
      updated: [],
      removed: [],
      removedActions: 0,
    });
  });

  it('assigns link-1 on a Card without Links and leaves the other Cards unchanged', () => {
    const before = makeStack();
    const after = expectAccepted(
      link(before, { fromCardId: 'card-1', toCardId: 'card-2', label: 'Go' }),
    );
    expect(linksOf(after, 'card-1')).toEqual([
      { id: 'link-2', label: 'Go', targetCardId: 'card-2' },
    ]);
    expect(after.cards[1]).toBe(before.cards[1]);
    expect(after.cards[2]).toBe(before.cards[2]);
    expect(after.startCardId).toBe(before.startCardId);
  });

  it('skips link ids held by other kinds of entity', () => {
    const base = makeStack();
    const stack: Stack = {
      ...base,
      cards: base.cards.map((card) =>
        card.id === 'card-2'
          ? { ...card, objects: card.objects.map((object) => ({ ...object, id: 'link-2' })) }
          : card,
      ),
    };
    const after = expectAccepted(
      link(stack, { fromCardId: 'card-1', toCardId: 'card-3', label: 'Skip' }),
    );
    expect(linksOf(after, 'card-1')[0]?.id).toBe('link-3');
  });

  it('allows a Link from a Card to itself', () => {
    const after = expectAccepted(
      link(makeStack(), { fromCardId: 'card-3', toCardId: 'card-3', label: 'Loop' }),
    );
    expect(linksOf(after, 'card-3')).toEqual([
      { id: 'link-2', label: 'Loop', targetCardId: 'card-3' },
    ]);
  });

  it('uses a supplied id', () => {
    const result = link(makeStack(), {
      fromCardId: 'card-1',
      toCardId: 'card-3',
      label: 'Custom',
      id: 'my-link',
    });
    const stack = expectAccepted(result);
    expect(linksOf(stack, 'card-1')[0]?.id).toBe('my-link');
    if (result.ok) expect(result.summary.created).toEqual(['my-link']);
  });

  it('accepts labels of 1 and 100 characters', () => {
    for (const label of ['x', 'y'.repeat(100)]) {
      const stack = expectAccepted(
        link(makeStack(), { fromCardId: 'card-1', toCardId: 'card-2', label }),
      );
      expect(linksOf(stack, 'card-1')[0]?.label).toBe(label);
    }
  });

  it('accepts the 50th Link', () => {
    const full = makeStackWithFullCard();
    const card = full.cards.find((c) => c.id === 'card-3');
    const almost: Stack = {
      ...full,
      cards: full.cards.map((c) =>
        c.id === 'card-3' ? { ...c, links: (card?.links ?? []).slice(0, 49) } : c,
      ),
    };
    const stack = expectAccepted(
      link(almost, { fromCardId: 'card-3', toCardId: 'extra-47', label: 'Last' }),
    );
    expect(linksOf(stack, 'card-3')).toHaveLength(50);
  });

  it('does not modify a frozen input Stack and is deterministic', () => {
    const stack = deepFreeze(makeStack());
    const copy = deepCopy(stack);
    const params = { fromCardId: 'card-1', toCardId: 'card-2', label: 'Go' };
    const first = link(stack, params);
    expectAccepted(first);
    expect(stack).toEqual(copy);
    expect(link(stack, params)).toEqual(first);
  });
});

describe('link_cards: rejected', () => {
  it('reports an unknown fromCardId as UNKNOWN_ENTITY at /fromCardId', () => {
    const stack = makeStack();
    const copy = deepCopy(stack);
    const errors = expectRejected(
      link(stack, { fromCardId: 'nope', toCardId: 'card-1', label: 'X' }),
    );
    expect(errors.map((e) => `${e.code}@${e.path}`)).toEqual(['UNKNOWN_ENTITY@/fromCardId']);
    expect(stack).toEqual(copy);
  });

  it('reports an unknown toCardId as UNKNOWN_ENTITY at /toCardId', () => {
    const errors = expectRejected(
      link(makeStack(), { fromCardId: 'card-1', toCardId: 'nope', label: 'X' }),
    );
    expect(errors.map((e) => `${e.code}@${e.path}`)).toEqual(['UNKNOWN_ENTITY@/toCardId']);
  });

  it('reports both unknown Cards together', () => {
    const errors = expectRejected(
      link(makeStack(), { fromCardId: 'a', toCardId: 'b', label: 'X' }),
    );
    expect(errors.map((e) => `${e.code}@${e.path}`)).toEqual([
      'UNKNOWN_ENTITY@/fromCardId',
      'UNKNOWN_ENTITY@/toCardId',
    ]);
  });

  it('reports an Object id as toCardId (and a Link id as fromCardId) as UNKNOWN_ENTITY', () => {
    const errors = expectRejected(
      link(makeStack(), { fromCardId: 'link-1', toCardId: 'obj-1', label: 'X' }),
    );
    expect(errors.map((e) => `${e.code}@${e.path}`)).toEqual([
      'UNKNOWN_ENTITY@/fromCardId',
      'UNKNOWN_ENTITY@/toCardId',
    ]);
  });

  it('reports a second Link to the same Card as DUPLICATE_LINK at /toCardId', () => {
    const errors = expectRejected(
      link(makeStack(), { fromCardId: 'card-2', toCardId: 'card-1', label: 'Again' }),
    );
    expect(errors.map((e) => `${e.code}@${e.path}`)).toEqual(['DUPLICATE_LINK@/toCardId']);
  });

  it('reports applying the same call twice as DUPLICATE_LINK', () => {
    const params = { fromCardId: 'card-1', toCardId: 'card-1', label: 'Loop' };
    const once = expectAccepted(link(makeStack(), params));
    const errors = expectRejected(link(once, params));
    expect(errors[0]?.code).toBe('DUPLICATE_LINK');
  });

  it('reports a source Card with 50 Links as LIMIT_EXCEEDED at /fromCardId', () => {
    const full = makeStackWithFullCard();
    expect(linksOf(full, 'card-3')).toHaveLength(50);
    const errors = expectRejected(
      link(full, { fromCardId: 'card-3', toCardId: 'extra-48', label: 'One more' }),
    );
    expect(errors.map((e) => `${e.code}@${e.path}`)).toEqual(['LIMIT_EXCEEDED@/fromCardId']);
  });

  it('reports an empty label as INVALID_VALUE at /label', () => {
    const [error] = expectRejected(
      link(makeStack(), { fromCardId: 'card-1', toCardId: 'card-2', label: '' }),
    );
    expect(error?.code).toBe('INVALID_VALUE');
    expect(error?.path).toBe('/label');
  });

  it('reports a label of 101 characters as LIMIT_EXCEEDED at /label', () => {
    const [error] = expectRejected(
      link(makeStack(), { fromCardId: 'card-1', toCardId: 'card-2', label: 'y'.repeat(101) }),
    );
    expect(error?.code).toBe('LIMIT_EXCEEDED');
    expect(error?.path).toBe('/label');
  });

  it('reports an id used by a Card, an Object or a Link as DUPLICATE_ID at /id', () => {
    for (const id of ['card-3', 'obj-1', 'link-1']) {
      const errors = expectRejected(
        link(makeStack(), { fromCardId: 'card-1', toCardId: 'card-2', label: 'X', id }),
      );
      expect(errors.map((e) => `${e.code}@${e.path}`)).toEqual(['DUPLICATE_ID@/id']);
    }
  });

  it('collects precondition errors together', () => {
    const errors = expectRejected(
      link(makeStack(), { fromCardId: 'card-2', toCardId: 'card-1', label: 'X', id: 'link-1' }),
    );
    expect(errors.map((e) => `${e.code}@${e.path}`)).toEqual([
      'DUPLICATE_LINK@/toCardId',
      'DUPLICATE_ID@/id',
    ]);
  });

  it('reports missing and unknown parameters at the schema stage', () => {
    const [missing] = expectRejected(link(makeStack(), { fromCardId: 'card-1', label: 'X' }));
    expect(missing?.code).toBe('MISSING_PROPERTY');
    const [unknown] = expectRejected(
      link(makeStack(), { fromCardId: 'card-1', toCardId: 'card-2', label: 'X', extra: 1 }),
    );
    expect(unknown?.code).toBe('UNKNOWN_PROPERTY');
  });
});
