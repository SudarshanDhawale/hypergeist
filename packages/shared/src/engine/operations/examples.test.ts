import { describe, expect, it } from 'vitest';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import { LIMITS, validateStack } from '../../format/index.ts';
import type { Card, Stack, StackObject, ValidationError } from '../../format/index.ts';
import { createStack } from '../create-stack.ts';
import type { OperationResult, OperationSummary } from '../operation-result.ts';
import { buildRenderModel } from '../render-model.ts';
import { OPERATION_NAMES, applyOperation } from './index.ts';

/*
 * Consolidated examples through the public `applyOperation`: one accepted and one rejected
 * example per Operation, a to-do Stack built step by step, the engine-only codes, and the
 * container and text limits. The per-Operation files hold the detailed cases.
 */

const GEOMETRY = { x: 10, y: 10, width: 120, height: 24 };

function emptyCard(id: string, name = id): Card {
  return { id, name, objects: [], links: [], onOpen: [] };
}

function smallButton(id: string): StackObject {
  return {
    id,
    type: 'button',
    name: '',
    x: 0,
    y: 0,
    width: 8,
    height: 8,
    label: 'Go',
    onClick: [],
  };
}

/** A valid one-Card Stack from `createStack`. */
function newStack(params: Record<string, unknown> = {}): Stack {
  const created = createStack({ id: 'todo', name: 'To-do', ...params });
  if (!created.ok)
    throw new Error(`fixture stack must be valid: ${JSON.stringify(created.errors)}`);
  return created.stack;
}

/** A Stack built directly (for the container limits) that must itself be valid. */
function validStack(stack: Stack): Stack {
  const checked = validateStack(stack);
  if (!checked.valid)
    throw new Error(`fixture stack must be valid: ${JSON.stringify(checked.errors)}`);
  return stack;
}

/** Applies a call that must be accepted. The result Stack must pass `validateStack`. */
function accept(stack: Stack, name: string, params: unknown) {
  const result = applyOperation(stack, name, params);
  if (!result.ok) throw new Error(`${name} was rejected: ${JSON.stringify(result.errors)}`);
  expect(validateStack(result.stack).valid).toBe(true);
  return result;
}

/** The `[code, path]` pairs of a rejected result, which must carry no Stack. */
function rejections(result: OperationResult): [string, string][] {
  if (result.ok) throw new Error('expected the operation to be rejected');
  expect(result).not.toHaveProperty('stack');
  return result.errors.map((error): [string, string] => [error.code, error.path]);
}

/** Applies a call that must be rejected, on a frozen Stack that must stay unchanged. */
function reject(stack: Stack, name: string, params: unknown): [string, string][] {
  const before = deepCopy(stack);
  const pairs = rejections(applyOperation(deepFreeze(deepCopy(stack)), name, params));
  expect(stack).toEqual(before);
  return pairs;
}

function emptySummary(): OperationSummary {
  return { created: [], updated: [], removed: [], removedActions: 0 };
}

function cardOf(stack: Stack, id: string): Card {
  const card = stack.cards.find((candidate) => candidate.id === id);
  if (card === undefined) throw new Error(`no card ${id}`);
  return card;
}

describe('one accepted and one rejected example per Operation', () => {
  const base = (): Stack => {
    let stack = newStack();
    stack = accept(stack, 'create_card', { name: 'Two' }).stack;
    stack = accept(stack, 'add_object', {
      cardId: 'card-1',
      type: 'button',
      label: 'Go',
      ...GEOMETRY,
    }).stack;
    return stack;
  };

  it('create_card: inserts an empty Card at the index', () => {
    const result = accept(base(), 'create_card', { name: 'Zero', index: 0 });
    expect(result.stack.cards.map((card) => card.id)).toEqual(['card-3', 'card-1', 'card-2']);
    expect(cardOf(result.stack, 'card-3')).toEqual(emptyCard('card-3', 'Zero'));
    expect(result.stack.startCardId).toBe('card-1');
    expect(result.summary).toEqual({ ...emptySummary(), created: ['card-3'] });
  });

  it('create_card: rejects a duplicate id at /id', () => {
    expect(reject(base(), 'create_card', { name: 'X', id: 'obj-1' })).toEqual([
      ['DUPLICATE_ID', '/id'],
    ]);
  });

  it('delete_card: removes the Card and everything that referred to it', () => {
    let stack = base();
    stack = accept(stack, 'link_cards', {
      fromCardId: 'card-1',
      toCardId: 'card-2',
      label: 'Two',
    }).stack;
    const result = accept(stack, 'delete_card', { cardId: 'card-2' });
    expect(result.stack.cards.map((card) => card.id)).toEqual(['card-1']);
    expect(cardOf(result.stack, 'card-1').links).toEqual([]);
    expect(result.summary).toEqual({ ...emptySummary(), removed: ['card-2', 'link-1'] });
  });

  it('delete_card: rejects a missing Card at /cardId', () => {
    expect(reject(base(), 'delete_card', { cardId: 'card-9' })).toEqual([
      ['UNKNOWN_ENTITY', '/cardId'],
    ]);
  });

  it('add_object: stores the defaults of the type and returns the new id', () => {
    const result = accept(base(), 'add_object', { cardId: 'card-2', type: 'list', ...GEOMETRY });
    expect(cardOf(result.stack, 'card-2').objects).toEqual([
      { id: 'obj-2', type: 'list', name: '', items: [], ordered: false, ...GEOMETRY },
    ]);
    expect(result.summary).toEqual({ ...emptySummary(), created: ['obj-2'] });
  });

  it('add_object: rejects a button without a label as MISSING_PROPERTY at the root', () => {
    expect(reject(base(), 'add_object', { cardId: 'card-2', type: 'button', ...GEOMETRY })).toEqual(
      [['MISSING_PROPERTY', '']],
    );
  });

  it('update_object: replaces the named properties and keeps the others', () => {
    const result = accept(base(), 'update_object', {
      objectId: 'obj-1',
      changes: { label: 'Add', x: 20 },
    });
    expect(cardOf(result.stack, 'card-1').objects).toEqual([
      expect.objectContaining({ id: 'obj-1', type: 'button', label: 'Add', x: 20, y: 10 }),
    ]);
    expect(result.summary).toEqual({ ...emptySummary(), updated: ['obj-1'] });
  });

  it('update_object: rejects a change of id at /changes/id', () => {
    expect(
      reject(base(), 'update_object', { objectId: 'obj-1', changes: { id: 'obj-9' } }),
    ).toEqual([['INVALID_VALUE', '/changes/id']]);
  });

  it('remove_object: removes the Object', () => {
    const result = accept(base(), 'remove_object', { objectId: 'obj-1' });
    expect(cardOf(result.stack, 'card-1').objects).toEqual([]);
    expect(result.summary).toEqual({ ...emptySummary(), removed: ['obj-1'] });
  });

  it('remove_object: rejects a Card id at /objectId', () => {
    expect(reject(base(), 'remove_object', { objectId: 'card-1' })).toEqual([
      ['UNKNOWN_ENTITY', '/objectId'],
    ]);
  });

  it('link_cards: appends a Link to the source Card', () => {
    const result = accept(base(), 'link_cards', {
      fromCardId: 'card-1',
      toCardId: 'card-2',
      label: 'Next',
    });
    expect(cardOf(result.stack, 'card-1').links).toEqual([
      { id: 'link-1', label: 'Next', targetCardId: 'card-2' },
    ]);
    expect(result.summary).toEqual({ ...emptySummary(), created: ['link-1'] });
  });

  it('link_cards: rejects a second Link to the same Card at /toCardId', () => {
    const stack = accept(base(), 'link_cards', {
      fromCardId: 'card-1',
      toCardId: 'card-2',
      label: 'Next',
    }).stack;
    expect(
      reject(stack, 'link_cards', { fromCardId: 'card-1', toCardId: 'card-2', label: 'Again' }),
    ).toEqual([['DUPLICATE_LINK', '/toCardId']]);
  });

  it('set_action: replaces the Handler of a Button', () => {
    const handler = [{ type: 'go_to_card', cardId: 'card-2' }];
    const result = accept(base(), 'set_action', { ownerId: 'obj-1', handler });
    expect(cardOf(result.stack, 'card-1').objects).toEqual([
      expect.objectContaining({ id: 'obj-1', onClick: handler }),
    ]);
    expect(result.summary).toEqual({ ...emptySummary(), updated: ['obj-1'] });
  });

  it('set_action: rejects an Action that refers to a missing Card at /handler/0/cardId', () => {
    expect(
      reject(base(), 'set_action', {
        ownerId: 'obj-1',
        handler: [{ type: 'go_to_card', cardId: 'card-9' }],
      }),
    ).toEqual([['DANGLING_REFERENCE', '/handler/0/cardId']]);
  });

  it('covers all seven Operation names above', () => {
    expect([...OPERATION_NAMES].sort()).toEqual([
      'add_object',
      'create_card',
      'delete_card',
      'link_cards',
      'remove_object',
      'set_action',
      'update_object',
    ]);
  });
});

describe('a to-do Stack built through the Operations', () => {
  it('stays valid after every step and cascades on remove and delete', () => {
    let stack = newStack({ firstCardName: 'Tasks' });
    expect(validateStack(stack).valid).toBe(true);

    // Two Cards.
    stack = accept(stack, 'create_card', { name: 'Done' }).stack;

    // Objects of several types on card-1.
    const field = accept(stack, 'add_object', {
      cardId: 'card-1',
      type: 'field',
      name: 'New task',
      placeholder: 'What to do?',
      ...GEOMETRY,
    });
    expect(field.summary.created).toEqual(['obj-1']);
    const list = accept(field.stack, 'add_object', {
      cardId: 'card-1',
      type: 'list',
      items: ['Milk'],
      x: 10,
      y: 50,
      width: 200,
      height: 120,
    });
    expect(list.summary.created).toEqual(['obj-2']);
    const button = accept(list.stack, 'add_object', {
      cardId: 'card-1',
      type: 'button',
      label: 'Add',
      x: 140,
      y: 10,
      width: 60,
      height: 24,
    });
    expect(button.summary.created).toEqual(['obj-3']);
    const aiField = accept(button.stack, 'add_object', {
      cardId: 'card-1',
      type: 'ai-field',
      prompt: 'Summarise the tasks.',
      inputObjectIds: ['obj-1', 'obj-2'],
      x: 10,
      y: 180,
      width: 200,
      height: 60,
    });
    expect(aiField.summary.created).toEqual(['obj-4']);
    const image = accept(aiField.stack, 'add_object', {
      cardId: 'card-1',
      type: 'image',
      src: 'https://example.com/check.png',
      alt: 'A check mark',
      index: 0,
      x: 300,
      y: 10,
      width: 32,
      height: 32,
    });
    expect(image.summary.created).toEqual(['obj-5']);
    stack = image.stack;
    expect(cardOf(stack, 'card-1').objects.map((object) => object.id)).toEqual([
      'obj-5',
      'obj-1',
      'obj-2',
      'obj-3',
      'obj-4',
    ]);

    // Links in both directions.
    stack = accept(stack, 'link_cards', {
      fromCardId: 'card-1',
      toCardId: 'card-2',
      label: 'Done',
    }).stack;
    stack = accept(stack, 'link_cards', {
      fromCardId: 'card-2',
      toCardId: 'card-1',
      label: 'Back',
    }).stack;
    expect(cardOf(stack, 'card-1').links).toEqual([
      { id: 'link-1', label: 'Done', targetCardId: 'card-2' },
    ]);
    expect(cardOf(stack, 'card-2').links).toEqual([
      { id: 'link-2', label: 'Back', targetCardId: 'card-1' },
    ]);

    // Handlers: the button adds the field text to the list, clears the field and opens card-2.
    const buttonHandler = [
      { type: 'append_item', targetObjectId: 'obj-2', fromObjectId: 'obj-1' },
      { type: 'set_value', targetObjectId: 'obj-1', value: '' },
      { type: 'go_to_card', cardId: 'card-2' },
    ];
    const handlerResult = accept(stack, 'set_action', { ownerId: 'obj-3', handler: buttonHandler });
    stack = handlerResult.stack;
    stack = accept(stack, 'set_action', {
      ownerId: 'card-2',
      handler: [{ type: 'show_message', text: 'Well done' }],
    }).stack;
    expect(cardOf(stack, 'card-2').onOpen).toEqual([{ type: 'show_message', text: 'Well done' }]);

    // update_object keeps the id, the type and the place in the Card.
    const updated = accept(stack, 'update_object', {
      objectId: 'obj-1',
      changes: { value: 'Eggs', multiline: true },
    });
    stack = updated.stack;
    expect(cardOf(stack, 'card-1').objects[1]).toEqual(
      expect.objectContaining({ id: 'obj-1', type: 'field', value: 'Eggs', multiline: true }),
    );

    // remove_object: the two Actions that name obj-1 go, the go_to_card stays, and the ai-field
    // loses the input.
    const removed = accept(stack, 'remove_object', { objectId: 'obj-1' });
    stack = removed.stack;
    expect(removed.summary).toEqual({
      created: [],
      updated: ['obj-3', 'obj-4'],
      removed: ['obj-1'],
      removedActions: 2,
    });
    expect(cardOf(stack, 'card-1').objects.find((object) => object.id === 'obj-3')).toEqual(
      expect.objectContaining({ onClick: [{ type: 'go_to_card', cardId: 'card-2' }] }),
    );
    expect(cardOf(stack, 'card-1').objects.find((object) => object.id === 'obj-4')).toEqual(
      expect.objectContaining({ inputObjectIds: ['obj-2'] }),
    );

    // delete_card with cascades: the Link to card-2 and the Action that opens it go, and the
    // Link of the deleted Card is listed after the Card.
    const deleted = accept(stack, 'delete_card', { cardId: 'card-2' });
    stack = deleted.stack;
    expect(deleted.summary).toEqual({
      created: [],
      updated: ['obj-3'],
      removed: ['card-2', 'link-2', 'link-1'],
      removedActions: 1,
    });
    expect(stack.cards.map((card) => card.id)).toEqual(['card-1']);
    expect(cardOf(stack, 'card-1').links).toEqual([]);
    expect(cardOf(stack, 'card-1').objects.find((object) => object.id === 'obj-3')).toEqual(
      expect.objectContaining({ onClick: [] }),
    );

    // The last Card cannot be deleted.
    expect(reject(stack, 'delete_card', { cardId: 'card-1' })).toEqual([
      ['LIMIT_EXCEEDED', '/cardId'],
    ]);
  });

  it('moves the start Card to the first remaining Card when the start Card is deleted', () => {
    let stack = newStack();
    stack = accept(stack, 'create_card', { name: 'Two' }).stack;
    stack = accept(stack, 'create_card', { name: 'Three' }).stack;
    const result = accept(stack, 'delete_card', { cardId: 'card-1' });
    expect(result.stack.startCardId).toBe('card-2');
    expect(result.stack.cards.map((card) => card.id)).toEqual(['card-2', 'card-3']);
  });

  it('lists an owner once in the summary however many of its Actions are removed', () => {
    let stack = newStack();
    stack = accept(stack, 'create_card', { name: 'Two' }).stack;
    stack = accept(stack, 'add_object', {
      cardId: 'card-1',
      type: 'button',
      label: 'Go',
      ...GEOMETRY,
    }).stack;
    stack = accept(stack, 'set_action', {
      ownerId: 'obj-1',
      handler: [
        { type: 'go_to_card', cardId: 'card-2' },
        { type: 'go_to_card', cardId: 'card-2' },
        { type: 'go_to_card', cardId: 'card-2' },
      ],
    }).stack;
    const result = accept(stack, 'delete_card', { cardId: 'card-2' });
    expect(result.summary).toEqual({
      created: [],
      updated: ['obj-1'],
      removed: ['card-2'],
      removedActions: 3,
    });
  });
});

describe('UNKNOWN_ENTITY examples', () => {
  const stack = (): Stack => {
    let built = newStack();
    built = accept(built, 'create_card', { name: 'Two' }).stack;
    built = accept(built, 'add_object', {
      cardId: 'card-1',
      type: 'button',
      label: 'Go',
      ...GEOMETRY,
    }).stack;
    return accept(built, 'link_cards', { fromCardId: 'card-1', toCardId: 'card-2', label: 'Two' })
      .stack;
  };

  it('names a missing Card in four Operations', () => {
    const built = stack();
    expect(reject(built, 'delete_card', { cardId: 'nope' })).toEqual([
      ['UNKNOWN_ENTITY', '/cardId'],
    ]);
    expect(reject(built, 'add_object', { cardId: 'nope', type: 'list', ...GEOMETRY })).toEqual([
      ['UNKNOWN_ENTITY', '/cardId'],
    ]);
    expect(
      reject(built, 'link_cards', { fromCardId: 'nope', toCardId: 'card-2', label: 'X' }),
    ).toEqual([['UNKNOWN_ENTITY', '/fromCardId']]);
    expect(
      reject(built, 'link_cards', { fromCardId: 'card-1', toCardId: 'nope', label: 'X' }),
    ).toEqual([['UNKNOWN_ENTITY', '/toCardId']]);
  });

  it('reports both ends of a Link when neither Card exists', () => {
    expect(
      reject(stack(), 'link_cards', { fromCardId: 'no-1', toCardId: 'no-2', label: 'X' }),
    ).toEqual([
      ['UNKNOWN_ENTITY', '/fromCardId'],
      ['UNKNOWN_ENTITY', '/toCardId'],
    ]);
  });

  it('names a missing Object, or an id that is a Card or a Link, as an Object', () => {
    const built = stack();
    for (const objectId of ['nope', 'card-1', 'link-1']) {
      expect(reject(built, 'remove_object', { objectId })).toEqual([
        ['UNKNOWN_ENTITY', '/objectId'],
      ]);
      expect(reject(built, 'update_object', { objectId, changes: { x: 1 } })).toEqual([
        ['UNKNOWN_ENTITY', '/objectId'],
      ]);
    }
  });

  it('names a missing owner for set_action', () => {
    expect(reject(stack(), 'set_action', { ownerId: 'nope', handler: [] })).toEqual([
      ['UNKNOWN_ENTITY', '/ownerId'],
    ]);
  });

  it('lists the valid ids in the hint', () => {
    const result = applyOperation(stack(), 'delete_card', { cardId: 'nope' });
    if (result.ok) throw new Error('expected a rejection');
    const [error] = result.errors;
    expect(JSON.parse(String(error?.actual))).toBe('nope');
    expect(error?.hint).toContain('card-1');
    expect(error?.hint).toContain('card-2');
  });

  it('buildRenderModel gives UNKNOWN_ENTITY at /cardId for a missing Card id', () => {
    const built = stack();
    for (const cardId of ['nope', 'obj-1', 'link-1']) {
      const result = buildRenderModel(built, cardId);
      if (result.ok) throw new Error('expected a rejection');
      expect(result.errors.map((error) => [error.code, error.path])).toEqual([
        ['UNKNOWN_ENTITY', '/cardId'],
      ]);
    }
  });
});

describe('OUT_OF_RANGE examples', () => {
  const twoCards = (): Stack => accept(newStack(), 'create_card', { name: 'Two' }).stack;

  it('create_card: an index above the number of Cards is rejected at /index', () => {
    expect(reject(twoCards(), 'create_card', { name: 'X', index: 3 })).toEqual([
      ['OUT_OF_RANGE', '/index'],
    ]);
    // The number of Cards itself is the last valid index.
    expect(accept(twoCards(), 'create_card', { name: 'X', index: 2 }).stack.cards).toHaveLength(3);
  });

  it('create_card: a negative index is rejected at /index', () => {
    expect(reject(twoCards(), 'create_card', { name: 'X', index: -1 })).toEqual([
      ['OUT_OF_RANGE', '/index'],
    ]);
  });

  it('add_object: an index above the number of Objects is rejected at /index', () => {
    const stack = accept(twoCards(), 'add_object', {
      cardId: 'card-1',
      type: 'list',
      ...GEOMETRY,
    }).stack;
    expect(
      reject(stack, 'add_object', { cardId: 'card-1', type: 'list', index: 2, ...GEOMETRY }),
    ).toEqual([['OUT_OF_RANGE', '/index']]);
    expect(
      accept(stack, 'add_object', { cardId: 'card-1', type: 'list', index: 1, ...GEOMETRY }).stack
        .cards[0]?.objects,
    ).toHaveLength(2);
  });

  it('createStack: a size outside 64 to 4096 is OUT_OF_RANGE at the parameter', () => {
    for (const [key, value] of [
      ['cardWidth', 63],
      ['cardWidth', 4097],
      ['cardHeight', 63],
      ['cardHeight', 4097],
    ] as const) {
      const result = createStack({ id: 'todo', name: 'To-do', [key]: value });
      if (result.ok) throw new Error('expected a rejection');
      expect(result.errors.map((error) => [error.code, error.path])).toEqual([
        ['OUT_OF_RANGE', `/${key}`],
      ]);
    }
    const edge = createStack({ id: 'todo', name: 'To-do', cardWidth: 64, cardHeight: 4096 });
    expect(edge.ok).toBe(true);
  });
});

describe('unknown Operation name', () => {
  it('is rejected with INVALID_VALUE at /operation and does not touch the Stack', () => {
    const stack = newStack();
    for (const name of ['nope', '', 'CREATE_CARD', 'create_card ', 'constructor', '__proto__']) {
      expect(reject(stack, name, { name: 'X' })).toEqual([['INVALID_VALUE', '/operation']]);
    }
  });

  it('lists the seven names in the hint', () => {
    const result = applyOperation(newStack(), 'nope', {});
    if (result.ok) throw new Error('expected a rejection');
    for (const name of OPERATION_NAMES) {
      expect(result.errors[0]?.hint).toContain(name);
    }
  });
});

describe('container limits', () => {
  it('create_card: a Stack with 200 Cards rejects another Card, and 199 accepts one', () => {
    const cards = (count: number): Card[] =>
      Array.from({ length: count }, (_, n) => emptyCard(`c-${n + 1}`));
    const full = validStack({ ...newStack(), startCardId: 'c-1', cards: cards(LIMITS.cards.max) });
    expect(reject(full, 'create_card', { name: 'X' })).toEqual([['LIMIT_EXCEEDED', '']]);

    const almost = validStack({
      ...newStack(),
      startCardId: 'c-1',
      cards: cards(LIMITS.cards.max - 1),
    });
    expect(accept(almost, 'create_card', { name: 'X' }).stack.cards).toHaveLength(200);
  });

  it('delete_card: the only Card of a Stack cannot be deleted', () => {
    expect(reject(newStack(), 'delete_card', { cardId: 'card-1' })).toEqual([
      ['LIMIT_EXCEEDED', '/cardId'],
    ]);
  });

  it('add_object: a Card with 100 Objects rejects another, and 99 accepts one', () => {
    const objects = (count: number): StackObject[] =>
      Array.from({ length: count }, (_, n) => smallButton(`b-${n + 1}`));
    const base = newStack();
    const full = validStack({
      ...base,
      cards: [{ ...emptyCard('card-1'), objects: objects(LIMITS.objectsPerCard.max) }],
    });
    expect(reject(full, 'add_object', { cardId: 'card-1', type: 'list', ...GEOMETRY })).toEqual([
      ['LIMIT_EXCEEDED', '/cardId'],
    ]);

    const almost = validStack({
      ...base,
      cards: [{ ...emptyCard('card-1'), objects: objects(LIMITS.objectsPerCard.max - 1) }],
    });
    expect(
      accept(almost, 'add_object', { cardId: 'card-1', type: 'list', ...GEOMETRY }).stack.cards[0]
        ?.objects,
    ).toHaveLength(100);
  });

  it('link_cards: a Card with 50 Links rejects another, and 49 accepts one', () => {
    const build = (linkCount: number): Stack => {
      const targets = Array.from({ length: LIMITS.linksPerCard.max + 1 }, (_, n) =>
        emptyCard(`t-${n + 1}`),
      );
      const [first, ...rest] = targets;
      if (first === undefined) throw new Error('unreachable');
      const links = targets.slice(0, linkCount).map((target, n) => ({
        id: `l-${n + 1}`,
        label: `To ${target.id}`,
        targetCardId: target.id,
      }));
      return validStack({
        ...newStack(),
        startCardId: first.id,
        cards: [{ ...first, links }, ...rest],
      });
    };

    const full = build(LIMITS.linksPerCard.max);
    expect(reject(full, 'link_cards', { fromCardId: 't-1', toCardId: 't-51', label: 'X' })).toEqual(
      [['LIMIT_EXCEEDED', '/fromCardId']],
    );

    const almost = build(LIMITS.linksPerCard.max - 1);
    expect(
      accept(almost, 'link_cards', { fromCardId: 't-1', toCardId: 't-50', label: 'X' }).stack
        .cards[0]?.links,
    ).toHaveLength(50);
  });
});

describe('text boundaries at 1, 100 and 101 code points', () => {
  const texts: [string, string][] = [
    ['ASCII', 'a'],
    ['astral', '\u{1F600}'],
  ];

  it.each(texts)('create_card.name, %s', (_, unit) => {
    const stack = newStack();
    for (const length of [1, 100]) {
      const name = unit.repeat(length);
      expect(cardOf(accept(stack, 'create_card', { name }).stack, 'card-2').name).toBe(name);
    }
    expect(reject(stack, 'create_card', { name: unit.repeat(101) })).toEqual([
      ['LIMIT_EXCEEDED', '/name'],
    ]);
    expect(reject(stack, 'create_card', { name: '' })).toEqual([['INVALID_VALUE', '/name']]);
  });

  it.each(texts)('link_cards.label, %s', (_, unit) => {
    const stack = accept(newStack(), 'create_card', { name: 'Two' }).stack;
    const params = { fromCardId: 'card-1', toCardId: 'card-2' };
    for (const length of [1, 100]) {
      const label = unit.repeat(length);
      const result = accept(stack, 'link_cards', { ...params, label });
      expect(cardOf(result.stack, 'card-1').links[0]?.label).toBe(label);
    }
    expect(reject(stack, 'link_cards', { ...params, label: unit.repeat(101) })).toEqual([
      ['LIMIT_EXCEEDED', '/label'],
    ]);
    expect(reject(stack, 'link_cards', { ...params, label: '' })).toEqual([
      ['INVALID_VALUE', '/label'],
    ]);
  });
});

describe('created ids and summaries', () => {
  it('assigns the smallest unused number, across kinds', () => {
    let stack = newStack({ firstCardId: 'home' });
    // An Object with the id card-1 holds that number for Cards.
    stack = accept(stack, 'add_object', {
      cardId: 'home',
      type: 'list',
      id: 'card-1',
      ...GEOMETRY,
    }).stack;
    const second = accept(stack, 'create_card', { name: 'Second' });
    expect(second.summary.created).toEqual(['card-2']);
    const third = accept(second.stack, 'create_card', { name: 'Third' });
    expect(third.summary.created).toEqual(['card-3']);

    // A gap is reused: delete card-2, and the next Card takes card-2 again.
    const gap = accept(third.stack, 'delete_card', { cardId: 'card-2' }).stack;
    expect(accept(gap, 'create_card', { name: 'Again' }).summary.created).toEqual(['card-2']);

    // Links and Objects count separately: obj-1 is free although card-1 is an Object.
    expect(
      accept(gap, 'add_object', { cardId: 'home', type: 'list', ...GEOMETRY }).summary.created,
    ).toEqual(['obj-1']);
    expect(
      accept(gap, 'link_cards', { fromCardId: 'home', toCardId: 'card-3', label: 'L' }).summary
        .created,
    ).toEqual(['link-1']);
  });

  it('rejects a supplied id that is already used by any kind of Entity', () => {
    let stack = newStack();
    stack = accept(stack, 'create_card', { name: 'Two' }).stack;
    stack = accept(stack, 'add_object', {
      cardId: 'card-1',
      type: 'list',
      ...GEOMETRY,
    }).stack;
    stack = accept(stack, 'link_cards', {
      fromCardId: 'card-1',
      toCardId: 'card-2',
      label: 'L',
    }).stack;
    for (const id of ['card-1', 'obj-1', 'link-1']) {
      expect(reject(stack, 'create_card', { name: 'X', id })).toEqual([['DUPLICATE_ID', '/id']]);
      expect(
        reject(stack, 'add_object', { cardId: 'card-1', type: 'list', id, ...GEOMETRY }),
      ).toEqual([['DUPLICATE_ID', '/id']]);
      expect(
        reject(stack, 'link_cards', { fromCardId: 'card-2', toCardId: 'card-1', label: 'X', id }),
      ).toEqual([['DUPLICATE_ID', '/id']]);
    }
  });

  it('leaves the arrays empty when nothing of that kind happened', () => {
    let stack = newStack();
    stack = accept(stack, 'create_card', { name: 'Two' }).stack;
    stack = accept(stack, 'add_object', {
      cardId: 'card-1',
      type: 'button',
      label: 'Go',
      ...GEOMETRY,
    }).stack;

    expect(accept(stack, 'create_card', { name: 'X' }).summary).toEqual({
      ...emptySummary(),
      created: ['card-3'],
    });
    expect(accept(stack, 'remove_object', { objectId: 'obj-1' }).summary).toEqual({
      ...emptySummary(),
      removed: ['obj-1'],
    });
    expect(accept(stack, 'delete_card', { cardId: 'card-2' }).summary).toEqual({
      ...emptySummary(),
      removed: ['card-2'],
    });
    expect(accept(stack, 'set_action', { ownerId: 'card-2', handler: [] }).summary).toEqual({
      ...emptySummary(),
      updated: ['card-2'],
    });
    // An empty `changes` is accepted and changes nothing.
    const noop = accept(stack, 'update_object', { objectId: 'obj-1', changes: {} });
    expect(noop.summary).toEqual(emptySummary());
    expect(noop.stack).toEqual(stack);
  });
});

describe('UNKNOWN_ENTITY and OUT_OF_RANGE come only from the engine', () => {
  const brokenInputs: unknown[] = [
    null,
    42,
    'text',
    [],
    {},
    { ...newStack(), cardWidth: 63 },
    { ...newStack(), cardWidth: 4097, cardHeight: -1 },
    { ...newStack(), startCardId: 'nope' },
    { ...newStack(), cards: [] },
    {
      ...newStack(),
      cards: [
        {
          ...emptyCard('card-1'),
          objects: [
            { ...smallButton('b'), x: 5000, onClick: [{ type: 'go_to_card', cardId: 'x' }] },
          ],
          links: [{ id: 'l', label: '', targetCardId: 'missing' }],
        },
      ],
    },
  ];

  it('validateStack never returns them, even for badly broken input', () => {
    for (const input of brokenInputs) {
      const result = validateStack(input);
      expect(result.valid).toBe(false);
      const codes: string[] = result.valid
        ? []
        : result.errors.map((error: ValidationError) => error.code);
      expect(codes).not.toContain('UNKNOWN_ENTITY');
      expect(codes).not.toContain('OUT_OF_RANGE');
    }
  });

  it('applyOperation does return them for the same kinds of mistake', () => {
    const stack = newStack();
    const codes = [
      reject(stack, 'delete_card', { cardId: 'nope' }),
      reject(stack, 'create_card', { name: 'X', index: 5 }),
    ].flat();
    expect(codes.map(([code]) => code)).toEqual(['UNKNOWN_ENTITY', 'OUT_OF_RANGE']);
  });
});
