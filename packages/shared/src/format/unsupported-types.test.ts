import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_ACTION_TYPES,
  SUPPORTED_OBJECT_TYPES,
  UNSUPPORTED_ACTION_TYPES,
  UNSUPPORTED_OBJECT_TYPES,
} from './limits.ts';
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

const objectTypeMessage = (type: string): string =>
  `The object type "${type}" is not supported in this release.`;
const actionTypeMessage = (type: string): string =>
  `The action type "${type}" is not supported in this release.`;

describe('unsupported Object types (5.1, 5.4, 5.5)', () => {
  it.each(UNSUPPORTED_OBJECT_TYPES)(
    'rejects the Object type %s at .../type, with nothing else reported',
    (type) => {
      // The extra property and the bad id would be property-level errors on a supported type.
      const candidate = stackWith([
        field('first'),
        { type, id: 'NOT AN ID', x: -5, bogus: true, name: 7 },
      ]);
      const result = validateStack(candidate);
      expect(result.valid).toBe(false);
      expect(result.truncated).toBe(false);
      expect(result.errors).toHaveLength(1);
      const [error] = result.errors;
      expect(error).toMatchObject({
        code: 'INVALID_VALUE',
        path: '/cards/0/objects/1/type',
        actual: JSON.stringify(type),
        message: objectTypeMessage(type),
        hint: `Use one of: ${SUPPORTED_OBJECT_TYPES.join(', ')}.`,
      });
      expect(error?.message).toContain('not supported in this release');
      expect(error?.expected.length).toBeGreaterThan(0);
    },
  );

  it('rejects an unsupported Object type that carries no other property', () => {
    const result = validateStack(stackWith([{ type: 'image' }]));
    expect(summary(result)).toEqual([['INVALID_VALUE', '/cards/0/objects/0/type']]);
  });

  it('reports each unsupported Object in its own position, in document order', () => {
    const result = validateStack(
      stackWith([{ type: 'ai-field' }, field('f'), { type: 'image' }, list('l')]),
    );
    expect(summary(result)).toEqual([
      ['INVALID_VALUE', '/cards/0/objects/0/type'],
      ['INVALID_VALUE', '/cards/0/objects/2/type'],
    ]);
    expect(result.errors.map((e) => e.message)).toEqual([
      objectTypeMessage('ai-field'),
      objectTypeMessage('image'),
    ]);
  });

  it('reports an Object type that is only valid for Actions as unknown, not unsupported', () => {
    const result = validateStack(stackWith([{ type: 'remove_item' }]));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe('The object type "remove_item" is unknown.');
  });
});

describe('unsupported Action types (5.2, 5.4, 5.5)', () => {
  const placements: readonly [string, (action: unknown) => Raw, string][] = [
    ['a Card onOpen Handler', (action) => stackWith([], [action]), '/cards/0/onOpen/0/type'],
    [
      'a Button onClick Handler',
      (action) => stackWith([button('go', [action])], []),
      '/cards/0/objects/0/onClick/0/type',
    ],
  ];

  describe.each(placements)('in %s', (_name, build, path) => {
    it.each(UNSUPPORTED_ACTION_TYPES)(
      'rejects the Action type %s at .../type, with nothing else reported',
      (type) => {
        const result = validateStack(
          build({ type, targetObjectId: 'NOT AN ID', bogus: 1, text: 5 }),
        );
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        const [error] = result.errors;
        expect(error).toMatchObject({
          code: 'INVALID_VALUE',
          path,
          actual: JSON.stringify(type),
          message: actionTypeMessage(type),
          hint: `Use one of: ${SUPPORTED_ACTION_TYPES.join(', ')}.`,
        });
        expect(error?.message).toContain('not supported in this release');
      },
    );
  });

  it('reports only the unsupported Action in a Handler that mixes valid and invalid Actions', () => {
    const result = validateStack(
      stackWith(
        [],
        [
          { type: 'show_message', text: 'hi' },
          { type: 'run_ai_field' },
          { type: 'go_to_card', cardId: 'home' },
        ],
      ),
    );
    expect(summary(result)).toEqual([['INVALID_VALUE', '/cards/0/onOpen/1/type']]);
  });

  it('does not run semantic checks on an unsupported Action', () => {
    // "gone" would be DANGLING_REFERENCE if the Action were treated as go_to_card.
    const result = validateStack(stackWith([], [{ type: 'fetch_news', cardId: 'gone' }]));
    expect(summary(result)).toEqual([['INVALID_VALUE', '/cards/0/onOpen/0/type']]);
  });

  it('reports an Action type that is only valid for Objects as unknown, not unsupported', () => {
    const result = validateStack(stackWith([], [{ type: 'image' }]));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe('The action type "image" is unknown.');
  });

  it.each(UNSUPPORTED_ACTION_TYPES)('validateHandler rejects %s at /0/type', (type) => {
    const stack = StackSchema.parse(stackWith([field('f')]));
    const result = validateHandler(stack, [{ type }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'INVALID_VALUE',
      path: '/0/type',
      message: actionTypeMessage(type),
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
      hint: `Use one of: ${SUPPORTED_OBJECT_TYPES.join(', ')}.`,
    });
  });

  it('reports an unknown Action type as unknown, at .../type', () => {
    const result = validateStack(stackWith([], [{ type: 'dance' }]));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'INVALID_VALUE',
      path: '/cards/0/onOpen/0/type',
      message: 'The action type "dance" is unknown.',
      hint: `Use one of: ${SUPPORTED_ACTION_TYPES.join(', ')}.`,
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

describe('unsupported types combined with the semantic pass', () => {
  it('still counts the id of an unsupported Object as taken (DUPLICATE_ID)', () => {
    const result = validateStack(stackWith([{ type: 'image', id: 'pic' }, field('pic')]));
    expect(summary(result)).toEqual([
      ['INVALID_VALUE', '/cards/0/objects/0/type'],
      ['DUPLICATE_ID', '/cards/0/objects/1/id'],
    ]);
  });

  it('reports a reference to an unsupported Object as WRONG_REFERENCE_TYPE after the type error', () => {
    const result = validateStack(
      stackWith(
        [{ type: 'ai-field', id: 'pic' }],
        [{ type: 'set_value', targetObjectId: 'pic', value: '' }],
      ),
    );
    expect(summary(result)).toEqual([
      ['INVALID_VALUE', '/cards/0/objects/0/type'],
      ['WRONG_REFERENCE_TYPE', '/cards/0/onOpen/0/targetObjectId'],
    ]);
  });
});
