import { describe, expect, it } from 'vitest';
import {
  ActionSchema,
  ButtonSchema,
  CardSchema,
  FieldSchema,
  HandlerSchema,
  LinkSchema,
  ListSchema,
  ObjectSchema,
  StackSchema,
} from './schemas.ts';

function validStack(): Record<string, unknown> {
  return {
    formatVersion: 1,
    id: 'demo',
    name: 'Demo',
    cardWidth: 512,
    cardHeight: 342,
    startCardId: 'c1',
    cards: [
      {
        id: 'c1',
        name: 'One',
        objects: [
          {
            id: 'f1',
            type: 'field',
            name: 'Input',
            x: 0,
            y: 0,
            width: 100,
            height: 24,
            value: '',
            placeholder: 'Type',
            multiline: false,
            readOnly: false,
          },
          {
            id: 'l1',
            type: 'list',
            name: 'Items',
            x: 0,
            y: 40,
            width: 100,
            height: 100,
            items: ['a', 'b'],
            ordered: true,
          },
          {
            id: 'b1',
            type: 'button',
            name: 'Add',
            x: 0,
            y: 150,
            width: 60,
            height: 24,
            label: 'Add',
            onClick: [
              { type: 'append_item', targetObjectId: 'l1', fromObjectId: 'f1' },
              { type: 'set_value', targetObjectId: 'f1', value: '' },
              { type: 'show_message', text: 'Added.' },
              { type: 'go_to_card', cardId: 'c1' },
            ],
          },
        ],
        links: [{ id: 'k1', label: 'Self', targetCardId: 'c1' }],
        onOpen: [],
      },
    ],
  };
}

function firstCard(stack: Record<string, unknown>): Record<string, unknown> {
  const cards = stack['cards'] as Record<string, unknown>[];
  return cards[0] as Record<string, unknown>;
}

function firstObject(stack: Record<string, unknown>, index: number): Record<string, unknown> {
  const objects = firstCard(stack)['objects'] as Record<string, unknown>[];
  return objects[index] as Record<string, unknown>;
}

describe('StackSchema', () => {
  it('parses a valid stack and keeps property order', () => {
    const result = StackSchema.safeParse(validStack());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).toEqual([
        'formatVersion',
        'id',
        'name',
        'cardWidth',
        'cardHeight',
        'startCardId',
        'cards',
      ]);
    }
  });

  it('accepts remixedFrom', () => {
    expect(StackSchema.safeParse({ ...validStack(), remixedFrom: 'orig' }).success).toBe(true);
  });

  it('rejects an unknown key at every level', () => {
    const stack = validStack();
    expect(StackSchema.safeParse({ ...stack, extra: 1 }).success).toBe(false);

    const withCardExtra = validStack();
    firstCard(withCardExtra)['extra'] = 1;
    expect(StackSchema.safeParse(withCardExtra).success).toBe(false);

    const withObjectExtra = validStack();
    firstObject(withObjectExtra, 0)['extra'] = 1;
    expect(StackSchema.safeParse(withObjectExtra).success).toBe(false);

    const withLinkExtra = validStack();
    const links = firstCard(withLinkExtra)['links'] as Record<string, unknown>[];
    Object.assign(links[0] as Record<string, unknown>, { extra: 1 });
    expect(StackSchema.safeParse(withLinkExtra).success).toBe(false);

    const withActionExtra = validStack();
    const onClick = firstObject(withActionExtra, 2)['onClick'] as Record<string, unknown>[];
    Object.assign(onClick[2] as Record<string, unknown>, { extra: 1 });
    expect(StackSchema.safeParse(withActionExtra).success).toBe(false);
  });

  it('rejects wrong types', () => {
    expect(StackSchema.safeParse({ ...validStack(), name: 5 }).success).toBe(false);
    expect(StackSchema.safeParse({ ...validStack(), cardWidth: '512' }).success).toBe(false);
    expect(StackSchema.safeParse({ ...validStack(), cards: {} }).success).toBe(false);
    expect(StackSchema.safeParse({ ...validStack(), formatVersion: '1' }).success).toBe(false);
  });

  it('rejects a missing required property', () => {
    const stack = validStack();
    delete stack['startCardId'];
    expect(StackSchema.safeParse(stack).success).toBe(false);
  });

  it('enforces formatVersion 1 and a non-integer size', () => {
    expect(StackSchema.safeParse({ ...validStack(), formatVersion: 2 }).success).toBe(false);
    expect(StackSchema.safeParse({ ...validStack(), cardWidth: 512.5 }).success).toBe(false);
  });

  it('enforces card size bounds inclusively', () => {
    expect(StackSchema.safeParse({ ...validStack(), cardWidth: 64 }).success).toBe(true);
    expect(StackSchema.safeParse({ ...validStack(), cardWidth: 63 }).success).toBe(false);
    expect(StackSchema.safeParse({ ...validStack(), cardHeight: 4096 }).success).toBe(true);
    expect(StackSchema.safeParse({ ...validStack(), cardHeight: 4097 }).success).toBe(false);
  });

  it('enforces the name length in code points, not UTF-16 units', () => {
    const astral100 = '\u{1F600}'.repeat(100);
    expect(StackSchema.safeParse({ ...validStack(), name: astral100 }).success).toBe(true);
    expect(StackSchema.safeParse({ ...validStack(), name: `${astral100}x` }).success).toBe(false);
    expect(StackSchema.safeParse({ ...validStack(), name: '' }).success).toBe(false);
  });

  it('enforces the entity id pattern', () => {
    for (const id of ['', 'Demo', '-a', 'a b', 'a'.repeat(65)]) {
      expect(StackSchema.safeParse({ ...validStack(), id }).success).toBe(false);
    }
    expect(StackSchema.safeParse({ ...validStack(), id: 'a'.repeat(64) }).success).toBe(true);
  });

  it('requires 1 to 200 cards', () => {
    const card = firstCard(validStack());
    expect(StackSchema.safeParse({ ...validStack(), cards: [] }).success).toBe(false);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...card, id: `c${String(i)}` }));
    expect(StackSchema.safeParse({ ...validStack(), cards: many(200) }).success).toBe(true);
    expect(StackSchema.safeParse({ ...validStack(), cards: many(201) }).success).toBe(false);
  });
});

describe('CardSchema and LinkSchema', () => {
  it('limits objects to 100 and links to 50', () => {
    const card = firstCard(validStack());
    const object = firstObject(validStack(), 0);
    const objects = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...object, id: `o${String(i)}` }));
    const links = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `k${String(i)}`,
        label: 'L',
        targetCardId: 'c1',
      }));
    expect(CardSchema.safeParse({ ...card, objects: objects(100) }).success).toBe(true);
    expect(CardSchema.safeParse({ ...card, objects: objects(101) }).success).toBe(false);
    expect(CardSchema.safeParse({ ...card, links: links(50) }).success).toBe(true);
    expect(CardSchema.safeParse({ ...card, links: links(51) }).success).toBe(false);
  });

  it('requires a non-empty link label and rejects unknown keys', () => {
    expect(LinkSchema.safeParse({ id: 'k', label: '', targetCardId: 'c1' }).success).toBe(false);
    expect(LinkSchema.safeParse({ id: 'k', label: 'x', targetCardId: 'c1', z: 1 }).success).toBe(
      false,
    );
  });
});

describe('ObjectSchema', () => {
  it('picks the member by type', () => {
    const stack = validStack();
    expect(ObjectSchema.safeParse(firstObject(stack, 0)).success).toBe(true);
    expect(ButtonSchema.safeParse(firstObject(stack, 2)).success).toBe(true);
    expect(FieldSchema.safeParse(firstObject(stack, 0)).success).toBe(true);
    expect(ListSchema.safeParse(firstObject(stack, 1)).success).toBe(true);
  });

  it('rejects unsupported and unknown types', () => {
    const base = firstObject(validStack(), 0);
    for (const type of ['image', 'ai-field', 'nope']) {
      expect(ObjectSchema.safeParse({ ...base, type }).success).toBe(false);
    }
    expect(ObjectSchema.safeParse({ ...base, type: 5 }).success).toBe(false);
  });

  it('enforces position and size bounds inclusively', () => {
    const base = firstObject(validStack(), 0);
    expect(ObjectSchema.safeParse({ ...base, x: 4096, y: 0, width: 8, height: 4096 }).success).toBe(
      true,
    );
    expect(ObjectSchema.safeParse({ ...base, x: 4097 }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...base, x: -1 }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...base, width: 7 }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...base, height: 4097 }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...base, y: 1.5 }).success).toBe(false);
  });

  it('allows an empty object name but not a name over 100 code points', () => {
    const base = firstObject(validStack(), 0);
    expect(ObjectSchema.safeParse({ ...base, name: '' }).success).toBe(true);
    expect(ObjectSchema.safeParse({ ...base, name: 'n'.repeat(101) }).success).toBe(false);
  });

  it('checks button, field, and list specific bounds', () => {
    const stack = validStack();
    const button = firstObject(stack, 2);
    expect(ObjectSchema.safeParse({ ...button, label: '' }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...button, label: 'x'.repeat(101) }).success).toBe(false);

    const field = firstObject(stack, 0);
    expect(ObjectSchema.safeParse({ ...field, value: 'v'.repeat(10_000) }).success).toBe(true);
    expect(ObjectSchema.safeParse({ ...field, value: 'v'.repeat(10_001) }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...field, placeholder: 'p'.repeat(201) }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...field, multiline: 'yes' }).success).toBe(false);

    const list = firstObject(stack, 1);
    expect(ObjectSchema.safeParse({ ...list, items: Array(500).fill('i') }).success).toBe(true);
    expect(ObjectSchema.safeParse({ ...list, items: Array(501).fill('i') }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...list, items: ['i'.repeat(501)] }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...list, items: [1] }).success).toBe(false);
  });
});

describe('ActionSchema and HandlerSchema', () => {
  it('parses each action type', () => {
    const actions = [
      { type: 'go_to_card', cardId: 'c1' },
      { type: 'set_value', targetObjectId: 'f1', value: 'x' },
      { type: 'set_value', targetObjectId: 'f1', fromObjectId: 'l1' },
      { type: 'append_item', targetObjectId: 'l1', item: 'x' },
      { type: 'append_item', targetObjectId: 'l1', fromObjectId: 'f1' },
      { type: 'show_message', text: 'hi' },
    ];
    for (const action of actions) {
      expect(ActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('leaves both exactly-one-of properties optional for the semantic pass', () => {
    expect(ActionSchema.safeParse({ type: 'set_value', targetObjectId: 'f1' }).success).toBe(true);
    expect(
      ActionSchema.safeParse({
        type: 'append_item',
        targetObjectId: 'l1',
        item: 'x',
        fromObjectId: 'f1',
      }).success,
    ).toBe(true);
  });

  it('rejects unsupported types, unknown keys, and bad values', () => {
    for (const type of [
      'remove_item',
      'run_ai_field',
      'fetch_news',
      'transcribe_audio',
      'schedule_notification',
      'bogus',
    ]) {
      expect(ActionSchema.safeParse({ type, text: 'x' }).success).toBe(false);
    }
    expect(ActionSchema.safeParse({ type: 'go_to_card', cardId: 'c1', extra: 1 }).success).toBe(
      false,
    );
    expect(ActionSchema.safeParse({ type: 'go_to_card', cardId: 'Bad Id' }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'show_message', text: '' }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'show_message', text: 'x'.repeat(501) }).success).toBe(
      false,
    );
    expect(ActionSchema.safeParse({ type: 'show_message', text: 7 }).success).toBe(false);
    expect(
      ActionSchema.safeParse({
        type: 'append_item',
        targetObjectId: 'l1',
        item: 'x'.repeat(501),
      }).success,
    ).toBe(false);
    expect(
      ActionSchema.safeParse({
        type: 'set_value',
        targetObjectId: 'f1',
        value: 'x'.repeat(10_001),
      }).success,
    ).toBe(false);
  });

  it('limits a handler to 20 actions', () => {
    const action = { type: 'show_message', text: 'hi' };
    expect(HandlerSchema.safeParse(Array(20).fill(action)).success).toBe(true);
    expect(HandlerSchema.safeParse(Array(21).fill(action)).success).toBe(false);
    expect(HandlerSchema.safeParse([]).success).toBe(true);
    expect(HandlerSchema.safeParse('nope').success).toBe(false);
  });
});
