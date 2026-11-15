import { describe, expect, it } from 'vitest';
import { ACTION_TYPES, OBJECT_TYPES } from './limits.ts';
import { StackSchema } from './schemas.ts';
import { validateHandler, validateStack } from './validate.ts';

// End-to-end through `validateStack` and `validateHandler`, with the real schemas.
// Requirements 5.1 to 5.5.

type Raw = Record<string, unknown>;

const field = (id: string): Raw => ({
  id,
  type: 'field',
  name: '',
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  value: '',
  placeholder: '',
  multiline: false,
  readOnly: false,
});

const list = (id: string): Raw => ({
  id,
  type: 'list',
  name: '',
  x: 0,
  y: 30,
  width: 100,
  height: 100,
  items: [],
  ordered: false,
});

const image = (id: string): Raw => ({
  id,
  type: 'image',
  name: '',
  x: 0,
  y: 170,
  width: 100,
  height: 100,
  src: 'https://example.com/a.png',
  alt: 'A picture',
});

const aiField = (id: string, inputObjectIds: string[] = []): Raw => ({
  id,
  type: 'ai-field',
  name: '',
  x: 0,
  y: 260,
  width: 100,
  height: 40,
  prompt: 'Summarize',
  inputObjectIds,
  value: '',
});

const button = (id: string, onClick: unknown[] = []): Raw => ({
  id,
  type: 'button',
  name: '',
  x: 0,
  y: 140,
  width: 60,
  height: 20,
  label: 'Go',
  onClick,
});

/** A valid one-Card stack whose Card holds `objects` and runs `onOpen`. */
function stackWith(objects: unknown[], onOpen: unknown[] = []): Raw {
  return {
    formatVersion: 1,
    id: 'demo',
    name: 'Demo',
    cardWidth: 400,
    cardHeight: 300,
    startCardId: 'home',
    cards: [{ id: 'home', name: 'Home', objects, links: [], onOpen }],
  };
}

function summary(result: {
  errors: readonly { code: string; path: string }[];
}): [string, string][] {
  return result.errors.map((error) => [error.code, error.path]);
}

const objectTypeMessage = (type: string): string => `The object type "${type}" is unknown.`;
const actionTypeMessage = (type: string): string => `The action type "${type}" is unknown.`;

/** One complete Action of each of the five types that the engine only validates. */
const newActions: readonly [string, Raw][] = [
  ['remove_item', { type: 'remove_item', targetObjectId: 'l', index: 0 }],
  ['run_ai_field', { type: 'run_ai_field', targetObjectId: 'answer' }],
  ['fetch_news', { type: 'fetch_news', targetObjectId: 'l', topics: ['technology'] }],
  ['transcribe_audio', { type: 'transcribe_audio', targetObjectId: 'f' }],
  [
    'schedule_notification',
    { type: 'schedule_notification', message: 'Time', at: '2026-12-01T09:00:00Z' },
  ],
];

/** The Objects that the references of `newActions` point at. */
const referenced = (): Raw[] => [field('f'), list('l'), aiField('answer', ['f'])];

describe('Object types are valid when complete (3.2, 4.3, 4.6)', () => {
  it.each([
    ['image', image('pic')],
    ['ai-field', aiField('answer')],
  ] as const)('accepts a complete %s Object', (_type, object) => {
    const result = validateStack(stackWith([field('first'), object]));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('accepts every Object type together on one Card', () => {
    const result = validateStack(
      stackWith([button('go'), field('f'), image('pic'), list('l'), aiField('answer', ['f'])]),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('lists all five Object types in the hint for an unknown type', () => {
    expect(OBJECT_TYPES).toEqual(['button', 'field', 'image', 'list', 'ai-field']);
    const result = validateStack(stackWith([{ type: 'nope' }]));
    expect(result.errors[0]?.hint).toBe(`Use one of: ${OBJECT_TYPES.join(', ')}.`);
  });

  it('reports a property error, not a type error, for an incomplete image or ai-field', () => {
    const result = validateStack(stackWith([{ type: 'image' }, { type: 'ai-field' }]));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    for (const error of result.errors) {
      expect(error.code).toBe('MISSING_PROPERTY');
      expect(error.path).toMatch(/^\/cards\/0\/objects\/[01]$/);
    }
  });

  it('reports an Object type that is only valid for Actions as unknown', () => {
    const result = validateStack(stackWith([{ type: 'remove_item' }]));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe(objectTypeMessage('remove_item'));
  });
});

describe('new Action types are valid when complete (6.2, 6.13)', () => {
  const placements: readonly [string, (action: unknown) => Raw][] = [
    ['a Card onOpen Handler', (action) => stackWith(referenced(), [action])],
    [
      'a Button onClick Handler',
      (action) => stackWith([...referenced(), button('go', [action])], []),
    ],
  ];

  describe.each(placements)('in %s', (_name, build) => {
    it.each(newActions)('accepts a complete %s Action', (_type, action) => {
      const result = validateStack(build(action));
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  });

  it('accepts all nine Action types together in one Handler', () => {
    const handler: unknown[] = [
      { type: 'go_to_card', cardId: 'home' },
      { type: 'set_value', targetObjectId: 'f', value: 'x' },
      { type: 'append_item', targetObjectId: 'l', item: 'x' },
      ...newActions.map(([, action]) => action),
      { type: 'show_message', text: 'hi' },
    ];
    expect(handler.map((action) => (action as Raw)['type']).sort()).toEqual(
      [...ACTION_TYPES].sort(),
    );
    expect(validateStack(stackWith(referenced(), handler)).errors).toEqual([]);
  });

  it('lists all nine Action types in the hint for an unknown type', () => {
    expect(ACTION_TYPES).toHaveLength(9);
    const result = validateStack(stackWith([], [{ type: 'nope' }]));
    expect(result.errors[0]?.hint).toBe(`Use one of: ${ACTION_TYPES.join(', ')}.`);
  });

  it('reports a property error, not a type error, for an incomplete new Action', () => {
    const result = validateStack(stackWith([], [{ type: 'remove_item' }]));
    expect(result.valid).toBe(false);
    expect(summary(result)).toEqual([
      ['MISSING_PROPERTY', '/cards/0/onOpen/0'],
      ['MISSING_PROPERTY', '/cards/0/onOpen/0'],
    ]);
  });
});

describe('unknown Action types (5.2, 5.4, 5.5)', () => {
  const placements: readonly [string, (action: unknown) => Raw, string][] = [
    ['a Card onOpen Handler', (action) => stackWith([], [action]), '/cards/0/onOpen/0/type'],
    [
      'a Button onClick Handler',
      (action) => stackWith([button('go', [action])], []),
      '/cards/0/objects/0/onClick/0/type',
    ],
  ];

  describe.each(placements)('in %s', (_name, build, path) => {
    it('rejects an unknown Action type at .../type, with nothing else reported', () => {
      const result = validateStack(
        build({ type: 'nope', targetObjectId: 'NOT AN ID', bogus: 1, text: 5 }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      const [error] = result.errors;
      expect(error).toMatchObject({
        code: 'INVALID_VALUE',
        path,
        actual: JSON.stringify('nope'),
        message: actionTypeMessage('nope'),
        hint: `Use one of: ${ACTION_TYPES.join(', ')}.`,
      });
      expect(error?.message).not.toContain('not supported in this release');
    });
  });

  it('reports only the unknown Action in a Handler that mixes valid and invalid Actions', () => {
    const result = validateStack(
      stackWith(
        [],
        [
          { type: 'show_message', text: 'hi' },
          { type: 'nope' },
          { type: 'go_to_card', cardId: 'home' },
        ],
      ),
    );
    expect(summary(result)).toEqual([['INVALID_VALUE', '/cards/0/onOpen/1/type']]);
  });

  it('does not run semantic checks on an unknown Action', () => {
    // "gone" would be DANGLING_REFERENCE if the Action were treated as go_to_card.
    const result = validateStack(stackWith([], [{ type: 'nope', cardId: 'gone' }]));
    expect(summary(result)).toEqual([['INVALID_VALUE', '/cards/0/onOpen/0/type']]);
  });

  it('reports an Action type that is only valid for Objects as unknown', () => {
    const result = validateStack(stackWith([], [{ type: 'image' }]));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe('The action type "image" is unknown.');
  });

  it.each(newActions)('validateHandler accepts a complete %s Action', (_type, action) => {
    const stack = StackSchema.parse(stackWith(referenced()));
    expect(validateHandler(stack, [action])).toEqual({ valid: true, errors: [], truncated: false });
  });

  it('validateHandler rejects an unknown Action type at /0/type', () => {
    const stack = StackSchema.parse(stackWith([field('f')]));
    const result = validateHandler(stack, [{ type: 'nope' }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'INVALID_VALUE',
      path: '/0/type',
      message: actionTypeMessage('nope'),
    });
  });
});

describe('unknown, absent, and non-string types (5.3)', () => {
  it('reports an unknown Object type as unknown, at .../type', () => {
    const result = validateStack(stackWith([{ type: 'widget', id: 'w', bogus: 1 }]));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'INVALID_VALUE',
      path: '/cards/0/objects/0/type',
      message: 'The object type "widget" is unknown.',
      actual: '"widget"',
      hint: `Use one of: ${OBJECT_TYPES.join(', ')}.`,
    });
  });

  it('reports an unknown Action type as unknown, at .../type', () => {
    const result = validateStack(stackWith([], [{ type: 'dance' }]));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'INVALID_VALUE',
      path: '/cards/0/onOpen/0/type',
      message: 'The action type "dance" is unknown.',
      hint: `Use one of: ${ACTION_TYPES.join(', ')}.`,
    });
  });

  it('treats the empty string and a wrong-case supported name as unknown', () => {
    for (const type of ['', 'Button', 'FIELD', ' list']) {
      const result = validateStack(stackWith([{ type }]));
      expect(summary(result)).toEqual([['INVALID_VALUE', '/cards/0/objects/0/type']]);
      expect(result.errors[0]?.message).toBe(`The object type "${type}" is unknown.`);
    }
  });

  it('treats names that exist on Object.prototype as plain unknown types', () => {
    for (const type of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const object = validateStack(stackWith([JSON.parse(`{"type":${JSON.stringify(type)}}`)]));
      expect(summary(object)).toEqual([['INVALID_VALUE', '/cards/0/objects/0/type']]);
      expect(object.errors[0]?.message).toBe(`The object type "${type}" is unknown.`);

      const action = validateStack(stackWith([], [JSON.parse(`{"type":${JSON.stringify(type)}}`)]));
      expect(summary(action)).toEqual([['INVALID_VALUE', '/cards/0/onOpen/0/type']]);
      expect(action.errors[0]?.message).toBe(`The action type "${type}" is unknown.`);
    }
  });

  it('reports an absent Object type as MISSING_PROPERTY at the Object', () => {
    const withoutType = Object.fromEntries(
      Object.entries(field('f')).filter(([key]) => key !== 'type'),
    );
    const result = validateStack(stackWith([withoutType]));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'MISSING_PROPERTY',
      path: '/cards/0/objects/0',
      actual: null,
    });
    expect(result.errors[0]?.message).toContain('"type"');
  });

  it('reports an absent Action type as MISSING_PROPERTY at the Action', () => {
    const result = validateStack(stackWith([], [{ text: 'hi' }]));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'MISSING_PROPERTY',
      path: '/cards/0/onOpen/0',
      actual: null,
    });
    expect(result.errors[0]?.message).toContain('"type"');
  });

  it('reports a non-string Object type as WRONG_TYPE at .../type', () => {
    for (const type of [5, null, true, ['button'], { a: 1 }]) {
      const result = validateStack(stackWith([{ type, id: 'x' }]));
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        code: 'WRONG_TYPE',
        path: '/cards/0/objects/0/type',
        actual: JSON.stringify(type),
      });
    }
  });

  it('reports a non-string Action type as WRONG_TYPE at .../type', () => {
    for (const type of [0, null, false, ['go_to_card'], {}]) {
      const result = validateStack(stackWith([], [{ type }]));
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        code: 'WRONG_TYPE',
        path: '/cards/0/onOpen/0/type',
        actual: JSON.stringify(type),
      });
    }
  });

  it('reports a non-object Object or Action as WRONG_TYPE at the element', () => {
    const result = validateStack(stackWith(['button', null], [7, []]));
    expect(summary(result)).toEqual([
      ['WRONG_TYPE', '/cards/0/objects/0'],
      ['WRONG_TYPE', '/cards/0/objects/1'],
      ['WRONG_TYPE', '/cards/0/onOpen/0'],
      ['WRONG_TYPE', '/cards/0/onOpen/1'],
    ]);
  });

  it('cuts a very long unknown type name in the message but not in actual', () => {
    const type = 'x'.repeat(500);
    const result = validateStack(stackWith([{ type }]));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message.length).toBeLessThan(120);
    expect([...(result.errors[0]?.actual ?? '')]).toHaveLength(200);
  });
});

describe('Object types combined with the semantic pass', () => {
  it('counts the id of an image as taken (DUPLICATE_ID)', () => {
    const result = validateStack(stackWith([image('pic'), field('pic')]));
    expect(summary(result)).toEqual([['DUPLICATE_ID', '/cards/0/objects/1/id']]);
  });

  it('reports a set_value that targets an image as WRONG_REFERENCE_TYPE', () => {
    const result = validateStack(
      stackWith([image('pic')], [{ type: 'set_value', targetObjectId: 'pic', value: '' }]),
    );
    expect(summary(result)).toEqual([['WRONG_REFERENCE_TYPE', '/cards/0/onOpen/0/targetObjectId']]);
  });

  it('accepts a set_value that targets an ai-field', () => {
    const result = validateStack(
      stackWith([aiField('answer')], [{ type: 'set_value', targetObjectId: 'answer', value: 'x' }]),
    );
    expect(result.errors).toEqual([]);
  });
});
