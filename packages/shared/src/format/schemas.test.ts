import { describe, expect, it } from 'vitest';
import {
  ActionSchema,
  AiFieldSchema,
  AppendItemActionSchema,
  ButtonSchema,
  CardSchema,
  FieldSchema,
  HandlerSchema,
  ImageSchema,
  LinkSchema,
  ListSchema,
  ObjectSchema,
  ScheduleNotificationActionSchema,
  SetValueActionSchema,
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

const COMMON_KEYS = ['id', 'type', 'name', 'x', 'y', 'width', 'height'];

function validImage(): Record<string, unknown> {
  return {
    id: 'i1',
    type: 'image',
    name: 'Logo',
    x: 0,
    y: 0,
    width: 64,
    height: 64,
    src: 'https://example.com/logo.png',
    alt: 'A logo',
  };
}

function validAiField(): Record<string, unknown> {
  return {
    id: 'a1',
    type: 'ai-field',
    name: 'Summary',
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    prompt: 'Summarize the notes.',
    inputObjectIds: ['f1', 'l1'],
    value: '',
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

  it('requires at least 1 card (the 200-card maximum is checked by the semantic pass)', () => {
    const card = firstCard(validStack());
    expect(StackSchema.safeParse({ ...validStack(), cards: [] }).success).toBe(false);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...card, id: `c${String(i)}` }));
    expect(StackSchema.safeParse({ ...validStack(), cards: many(200) }).success).toBe(true);
    expect(StackSchema.safeParse({ ...validStack(), cards: many(201) }).success).toBe(true);
  });
});

describe('CardSchema and LinkSchema', () => {
  it('leaves the 100-object and 50-link maximums to the semantic pass', () => {
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
    expect(CardSchema.safeParse({ ...card, objects: objects(101) }).success).toBe(true);
    expect(CardSchema.safeParse({ ...card, links: links(50) }).success).toBe(true);
    expect(CardSchema.safeParse({ ...card, links: links(51) }).success).toBe(true);
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

  it('rejects unknown types', () => {
    const base = firstObject(validStack(), 0);
    expect(ObjectSchema.safeParse({ ...base, type: 'nope' }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...base, type: 5 }).success).toBe(false);
    // A field's properties do not make an image or an ai-field.
    expect(ObjectSchema.safeParse({ ...base, type: 'image' }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...base, type: 'ai-field' }).success).toBe(false);
  });

  it('accepts complete image and ai-field objects, keeping canonical property order', () => {
    const image = ObjectSchema.safeParse(validImage());
    const aiField = ObjectSchema.safeParse(validAiField());
    expect(image.success).toBe(true);
    expect(aiField.success).toBe(true);
    if (image.success && aiField.success) {
      expect(Object.keys(image.data)).toEqual([...COMMON_KEYS, 'src', 'alt']);
      expect(Object.keys(aiField.data)).toEqual([
        ...COMMON_KEYS,
        'prompt',
        'inputObjectIds',
        'value',
      ]);
    }
    expect(ImageSchema.safeParse(validImage()).success).toBe(true);
    expect(AiFieldSchema.safeParse(validAiField()).success).toBe(true);
  });

  it('rejects unknown keys and missing properties on image and ai-field', () => {
    expect(ImageSchema.safeParse({ ...validImage(), extra: 1 }).success).toBe(false);
    expect(AiFieldSchema.safeParse({ ...validAiField(), extra: 1 }).success).toBe(false);
    const noSrc = validImage();
    delete noSrc['src'];
    expect(ImageSchema.safeParse(noSrc).success).toBe(false);
    const noIds = validAiField();
    delete noIds['inputObjectIds'];
    expect(AiFieldSchema.safeParse(noIds).success).toBe(false);
  });

  it('accepts https and data image sources and rejects other sources', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    for (const src of ['https://example.com', 'https://example.com/a.png?x=1#y', png]) {
      expect(ImageSchema.safeParse({ ...validImage(), src }).success).toBe(true);
    }
    const bad = [
      '',
      'http://example.com/a.png',
      'HTTPS://example.com/a.png',
      'https://user@example.com/a.png',
      'https://',
      'https://example.com/a b',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,AAAA',
      'data:image/png;base64,',
      'data:image/png;base64,abc',
      'data:image/png,AAAA',
      'data:text/html;base64,AAAA',
    ];
    for (const src of bad) {
      expect(ImageSchema.safeParse({ ...validImage(), src }).success, src).toBe(false);
    }
  });

  it('limits an https image source to 2,000 characters and a data source to 1,000,000', () => {
    const https = (length: number) => `https://e.com/${'a'.repeat(length - 14)}`;
    expect(ImageSchema.safeParse({ ...validImage(), src: https(2000) }).success).toBe(true);
    const over = ImageSchema.safeParse({ ...validImage(), src: https(2001) });
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(over.error.issues).toHaveLength(1);
      expect(over.error.issues[0]).toMatchObject({
        code: 'too_big',
        origin: 'string',
        maximum: 2000,
        path: ['src'],
      });
    }

    // The prefix has 22 characters and the payload comes in groups of four, so the
    // longest well-formed source is 999,998 characters and the next one is 1,000,002.
    const data = (payloadLength: number) => `data:image/png;base64,${'A'.repeat(payloadLength)}`;
    expect(data(999_976)).toHaveLength(999_998);
    expect(ImageSchema.safeParse({ ...validImage(), src: data(999_976) }).success).toBe(true);
    const tooLong = ImageSchema.safeParse({ ...validImage(), src: data(999_980) });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(tooLong.error.issues).toHaveLength(1);
      expect(tooLong.error.issues[0]).toMatchObject({ code: 'too_big', maximum: 1_000_000 });
    }
  });

  it('reports a pattern issue and a size issue for a source that is too long and malformed', () => {
    const src = `https://e.com/${'a'.repeat(2000)} `;
    const result = ImageSchema.safeParse({ ...validImage(), src });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.code).sort()).toEqual([
        'invalid_format',
        'too_big',
      ]);
    }
  });

  it('checks image alt and ai-field bounds inclusively', () => {
    expect(ImageSchema.safeParse({ ...validImage(), alt: '' }).success).toBe(true);
    expect(ImageSchema.safeParse({ ...validImage(), alt: 'a'.repeat(200) }).success).toBe(true);
    expect(ImageSchema.safeParse({ ...validImage(), alt: 'a'.repeat(201) }).success).toBe(false);

    expect(AiFieldSchema.safeParse({ ...validAiField(), prompt: '' }).success).toBe(false);
    expect(AiFieldSchema.safeParse({ ...validAiField(), prompt: 'p'.repeat(2000) }).success).toBe(
      true,
    );
    expect(AiFieldSchema.safeParse({ ...validAiField(), prompt: 'p'.repeat(2001) }).success).toBe(
      false,
    );
    expect(AiFieldSchema.safeParse({ ...validAiField(), value: 'v'.repeat(10_000) }).success).toBe(
      true,
    );
    expect(AiFieldSchema.safeParse({ ...validAiField(), value: 'v'.repeat(10_001) }).success).toBe(
      false,
    );
  });

  it('checks ai-field input ids: entity ids only, maximum of 10 left to the semantic pass', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `f${String(i)}`);
    expect(AiFieldSchema.safeParse({ ...validAiField(), inputObjectIds: [] }).success).toBe(true);
    expect(AiFieldSchema.safeParse({ ...validAiField(), inputObjectIds: ids(10) }).success).toBe(
      true,
    );
    expect(AiFieldSchema.safeParse({ ...validAiField(), inputObjectIds: ids(11) }).success).toBe(
      true,
    );
    expect(AiFieldSchema.safeParse({ ...validAiField(), inputObjectIds: ['Bad Id'] }).success).toBe(
      false,
    );
    expect(AiFieldSchema.safeParse({ ...validAiField(), inputObjectIds: [1] }).success).toBe(false);
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
    // The 500-item maximum is checked by the semantic pass, not by Zod.
    expect(ObjectSchema.safeParse({ ...list, items: Array(501).fill('i') }).success).toBe(true);
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

  it('rejects unknown types, unknown keys, and bad values', () => {
    for (const type of ['nope', 'bogus', 'RUN_AI_FIELD']) {
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

  it('parses the five new action types and keeps the canonical property order', () => {
    const cases: [Record<string, unknown>, string[]][] = [
      [
        { index: 0, targetObjectId: 'l1', type: 'remove_item' },
        ['type', 'targetObjectId', 'index'],
      ],
      [{ targetObjectId: 'a1', type: 'run_ai_field' }, ['type', 'targetObjectId']],
      [
        { topics: ['ai', 'space'], targetObjectId: 'l1', type: 'fetch_news' },
        ['type', 'targetObjectId', 'topics'],
      ],
      [{ targetObjectId: 'f1', type: 'transcribe_audio' }, ['type', 'targetObjectId']],
      [
        { at: '2026-12-01T09:00:00Z', message: 'Stand up', type: 'schedule_notification' },
        ['type', 'message', 'at'],
      ],
      [
        { atFromObjectId: 'f1', message: 'Stand up', type: 'schedule_notification' },
        ['type', 'message', 'atFromObjectId'],
      ],
    ];
    for (const [input, keys] of cases) {
      const result = ActionSchema.safeParse(input);
      expect(result.success, String(input['type'])).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data)).toEqual(keys);
      }
    }
  });

  it('checks remove_item index, fetch_news topics, and the new targets', () => {
    const remove = { type: 'remove_item', targetObjectId: 'l1' };
    expect(ActionSchema.safeParse({ ...remove, index: 0 }).success).toBe(true);
    expect(ActionSchema.safeParse({ ...remove, index: 7 }).success).toBe(true);
    expect(ActionSchema.safeParse({ ...remove, index: -1 }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...remove, index: 1.5 }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...remove, index: '1' }).success).toBe(false);
    expect(ActionSchema.safeParse(remove).success).toBe(false);

    const news = { type: 'fetch_news', targetObjectId: 'l1' };
    const topics = (n: number) => Array.from({ length: n }, (_, i) => `t${String(i)}`);
    expect(ActionSchema.safeParse({ ...news, topics: [] }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...news, topics: topics(1) }).success).toBe(true);
    expect(ActionSchema.safeParse({ ...news, topics: topics(10) }).success).toBe(true);
    // The 10-topic maximum is checked by the semantic pass, not by Zod.
    expect(ActionSchema.safeParse({ ...news, topics: topics(11) }).success).toBe(true);
    expect(ActionSchema.safeParse({ ...news, topics: [''] }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...news, topics: ['t'.repeat(100)] }).success).toBe(true);
    expect(ActionSchema.safeParse({ ...news, topics: ['t'.repeat(101)] }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...news, topics: [1] }).success).toBe(false);
    expect(ActionSchema.safeParse(news).success).toBe(false);

    for (const type of ['run_ai_field', 'transcribe_audio']) {
      expect(ActionSchema.safeParse({ type, targetObjectId: 'x1' }).success).toBe(true);
      expect(ActionSchema.safeParse({ type, targetObjectId: 'Bad Id' }).success).toBe(false);
      expect(ActionSchema.safeParse({ type }).success).toBe(false);
      expect(ActionSchema.safeParse({ type, targetObjectId: 'x1', extra: 1 }).success).toBe(false);
    }
  });

  it('checks schedule_notification message and the UTC timestamp', () => {
    const base = { type: 'schedule_notification', message: 'Go' };
    const at = (value: unknown) => ActionSchema.safeParse({ ...base, at: value }).success;
    expect(at('2026-12-01T09:00:00Z')).toBe(true);
    expect(at('2028-02-29T23:59:59Z')).toBe(true);
    expect(at('2026-12-01T09:00:00+01:00')).toBe(false);
    expect(at('2026-12-01T09:00Z')).toBe(false);
    expect(at('2026-12-01')).toBe(false);
    expect(at('2027-02-29T09:00:00Z')).toBe(false);
    expect(at('2026-12-01T24:00:00Z')).toBe(false);
    expect(at('2026-12-01T09:00:60Z')).toBe(false);
    expect(at(1_700_000_000)).toBe(false);

    const message = (value: string) =>
      ActionSchema.safeParse({ ...base, message: value, at: '2026-12-01T09:00:00Z' }).success;
    expect(message('')).toBe(false);
    expect(message('m'.repeat(500))).toBe(true);
    expect(message('m'.repeat(501))).toBe(false);
    expect(ActionSchema.safeParse({ type: 'schedule_notification', at: 'x' }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...base, atFromObjectId: 'Bad Id' }).success).toBe(false);
  });

  it('leaves each exactly-one-of pair optional in Zod and states it as oneOf metadata', () => {
    expect(ActionSchema.safeParse({ type: 'schedule_notification', message: 'Go' }).success).toBe(
      true,
    );
    expect(
      ActionSchema.safeParse({
        type: 'schedule_notification',
        message: 'Go',
        at: '2026-12-01T09:00:00Z',
        atFromObjectId: 'f1',
      }).success,
    ).toBe(true);
    const pairs: [{ meta: () => unknown }, string, string][] = [
      [SetValueActionSchema, 'value', 'fromObjectId'],
      [AppendItemActionSchema, 'item', 'fromObjectId'],
      [ScheduleNotificationActionSchema, 'at', 'atFromObjectId'],
    ];
    for (const [schema, a, b] of pairs) {
      expect(schema.meta()).toMatchObject({ oneOf: [{ required: [a] }, { required: [b] }] });
    }
  });

  it('leaves the 20-action maximum of a handler to the semantic pass', () => {
    const action = { type: 'show_message', text: 'hi' };
    expect(HandlerSchema.safeParse(Array(20).fill(action)).success).toBe(true);
    expect(HandlerSchema.safeParse(Array(21).fill(action)).success).toBe(true);
    expect(HandlerSchema.safeParse([]).success).toBe(true);
    expect(HandlerSchema.safeParse('nope').success).toBe(false);
  });
});
