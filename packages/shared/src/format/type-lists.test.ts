import { describe, expect, it } from 'vitest';
import { executeHandler } from '../engine/index.ts';
import { ACTION_TYPES, OBJECT_TYPES } from './limits.ts';
import { stackJsonSchema } from './json-schema.ts';
import { ActionSchema, ObjectSchema } from './schemas.ts';
import type { Handler, Stack } from './schemas.ts';
import { runSemanticPass } from './semantic.ts';
import { validateHandler, validateStack } from './validate.ts';

/*
 * The Object and Action type names appear in several places: the constants, the Zod unions,
 * the JSON Schema, the semantic pass, the hint text of the issue mapper, and the engine.
 * These tests fail when one place is changed and another is forgotten.
 * The literal lists below are the documented order, written out on purpose.
 */

const DOCUMENTED_OBJECT_TYPES = ['button', 'field', 'image', 'list', 'ai-field'];
const DOCUMENTED_ACTION_TYPES = [
  'go_to_card',
  'set_value',
  'append_item',
  'remove_item',
  'show_message',
  'run_ai_field',
  'fetch_news',
  'transcribe_audio',
  'schedule_notification',
];

type Json = Record<string, unknown>;

function asRecord(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object at ${what}`);
  }
  return value as Json;
}

/** The `type` constants of the `oneOf` options under `node.items`, in order. */
function itemTypeConsts(node: unknown, what: string): unknown[] {
  const options = asRecord(node, what)['items'];
  const oneOf = asRecord(options, `${what}.items`)['oneOf'];
  if (!Array.isArray(oneOf)) throw new Error(`Expected oneOf at ${what}.items`);
  return oneOf.map((option, index) => {
    const properties = asRecord(asRecord(option, `${what}.oneOf[${index}]`)['properties'], what);
    return asRecord(properties['type'], `${what}.oneOf[${index}].type`)['const'];
  });
}

describe('constants', () => {
  it('OBJECT_TYPES is the documented list, in the documented order', () => {
    expect([...OBJECT_TYPES]).toEqual(DOCUMENTED_OBJECT_TYPES);
  });

  it('ACTION_TYPES is the documented list, in the documented order', () => {
    expect([...ACTION_TYPES]).toEqual(DOCUMENTED_ACTION_TYPES);
  });
});

describe('Zod discriminated unions', () => {
  it("OBJECT_TYPES equals the `type` literals of ObjectSchema's options, in order", () => {
    const literals = ObjectSchema.options.map((option) => option.shape.type.value);
    expect(literals).toEqual([...OBJECT_TYPES]);
  });

  it("ACTION_TYPES equals the `type` literals of ActionSchema's options, in order", () => {
    const literals = ActionSchema.options.map((option) => option.shape.type.value);
    expect(literals).toEqual([...ACTION_TYPES]);
  });
});

describe('JSON Schema consts', () => {
  const schema = asRecord(stackJsonSchema(), 'schema');
  const card = asRecord(
    asRecord(asRecord(schema['properties'], 'properties')['cards'], 'cards')['items'],
    'cards.items',
  );
  const cardProperties = asRecord(card['properties'], 'card.properties');
  const objectOptions = asRecord(cardProperties['objects'], 'card.objects');

  it('lists exactly the Object types under cards[].objects, in order', () => {
    expect(itemTypeConsts(objectOptions, 'objects')).toEqual([...OBJECT_TYPES]);
  });

  it('lists exactly the Action types under cards[].onOpen, in order', () => {
    expect(itemTypeConsts(cardProperties['onOpen'], 'onOpen')).toEqual([...ACTION_TYPES]);
  });

  it('lists exactly the Action types under a Button onClick, in order', () => {
    const oneOf = asRecord(objectOptions['items'], 'objects.items')['oneOf'];
    if (!Array.isArray(oneOf)) throw new Error('Expected oneOf at objects.items');
    const button = oneOf
      .map((option) => asRecord(option, 'object option'))
      .find(
        (option) =>
          asRecord(asRecord(option['properties'], 'p')['type'], 't')['const'] === 'button',
      );
    if (button === undefined) throw new Error('No button variant');
    const onClick = asRecord(button['properties'], 'button.properties')['onClick'];
    expect(itemTypeConsts(onClick, 'onClick')).toEqual([...ACTION_TYPES]);
  });
});

/** A Stack-shaped candidate with one button that holds `action`. Passed to the semantic pass raw. */
function candidateWithAction(action: unknown): unknown {
  return {
    formatVersion: 1,
    id: 's1',
    name: 'S',
    cardWidth: 640,
    cardHeight: 480,
    startCardId: 'c1',
    cards: [
      {
        id: 'c1',
        name: 'C',
        objects: [
          {
            id: 'b1',
            type: 'button',
            name: '',
            x: 0,
            y: 0,
            width: 100,
            height: 30,
            label: 'Go',
            onClick: [action],
          },
        ],
        links: [],
        onOpen: [],
      },
    ],
  };
}

/** Per Action type: the properties that name another entity (the ones the semantic pass resolves). */
const REFERENCE_PROPERTIES: Record<(typeof ACTION_TYPES)[number], readonly string[]> = {
  go_to_card: ['cardId'],
  set_value: ['targetObjectId', 'fromObjectId'],
  append_item: ['targetObjectId', 'fromObjectId'],
  remove_item: ['targetObjectId'],
  show_message: [],
  run_ai_field: ['targetObjectId'],
  fetch_news: ['targetObjectId'],
  transcribe_audio: ['targetObjectId'],
  schedule_notification: ['atFromObjectId'],
};

describe("the semantic pass's known types", () => {
  it('has a reference table row for every Action type and nothing else', () => {
    expect(Object.keys(REFERENCE_PROPERTIES)).toEqual([...ACTION_TYPES]);
  });

  it.each([...ACTION_TYPES])('walks the references of the %s Action', (type) => {
    const properties = REFERENCE_PROPERTIES[type];
    const action = {
      type,
      ...Object.fromEntries(properties.map((name) => [name, 'ghost'])),
      ...(type === 'fetch_news' ? { topics: ['news'] } : {}),
    };
    const dangling = runSemanticPass(candidateWithAction(action)).filter(
      (error) => error.code === 'DANGLING_REFERENCE',
    );
    expect(dangling.map((error) => error.segments)).toEqual(
      properties.map((name) => ['cards', 0, 'objects', 0, 'onClick', 0, name]),
    );
  });

  it('skips an Action of an unknown type', () => {
    const action = { type: 'bogus', targetObjectId: 'ghost', cardId: 'ghost' };
    expect(runSemanticPass(candidateWithAction(action))).toEqual([]);
  });

  it.each([...OBJECT_TYPES])('checks the bounds of the %s Object', (type) => {
    const candidate = {
      formatVersion: 1,
      id: 's1',
      name: 'S',
      cardWidth: 64,
      cardHeight: 64,
      startCardId: 'c1',
      cards: [
        {
          id: 'c1',
          name: 'C',
          objects: [{ id: 'o1', type, x: 60, y: 0, width: 8, height: 8 }],
          links: [],
          onOpen: [],
        },
      ],
    };
    const errors = runSemanticPass(candidate).filter((error) => error.code === 'OUT_OF_BOUNDS');
    expect(errors.map((error) => error.segments)).toEqual([['cards', 0, 'objects', 0]]);
  });

  it('skips an Object of an unknown type', () => {
    const candidate = {
      formatVersion: 1,
      id: 's1',
      name: 'S',
      cardWidth: 64,
      cardHeight: 64,
      startCardId: 'c1',
      cards: [
        {
          id: 'c1',
          name: 'C',
          objects: [{ id: 'o1', type: 'bogus', x: 60, y: 0, width: 8, height: 8 }],
          links: [],
          onOpen: [],
        },
      ],
    };
    expect(runSemanticPass(candidate)).toEqual([]);
  });
});

describe('the hint lists of the issue mapper', () => {
  const stackWith = (objectType: string, actionType: string) => ({
    formatVersion: 1,
    id: 's1',
    name: 'S',
    cardWidth: 640,
    cardHeight: 480,
    startCardId: 'c1',
    cards: [
      {
        id: 'c1',
        name: 'C',
        objects: [{ id: 'o1', type: objectType }],
        links: [],
        onOpen: [{ type: actionType }],
      },
    ],
  });

  const result = validateStack(stackWith('bogus', 'bogus'));
  const objectError = result.errors.find((error) => error.path === '/cards/0/objects/0/type');
  const actionError = result.errors.find((error) => error.path === '/cards/0/onOpen/0/type');

  it('names every Object type, in the documented order', () => {
    const list = DOCUMENTED_OBJECT_TYPES.join(', ');
    expect(objectError?.code).toBe('INVALID_VALUE');
    expect(objectError?.expected).toBe(`one of: ${list}`);
    expect(objectError?.hint).toBe(`Use one of: ${list}.`);
  });

  it('names every Action type, in the documented order', () => {
    const list = DOCUMENTED_ACTION_TYPES.join(', ');
    expect(actionError?.code).toBe('INVALID_VALUE');
    expect(actionError?.expected).toBe(`one of: ${list}`);
    expect(actionError?.hint).toBe(`Use one of: ${list}.`);
  });
});

describe("the engine's executable subset", () => {
  const EXECUTABLE = ['go_to_card', 'set_value', 'append_item', 'show_message'];
  const NOT_EXECUTABLE = DOCUMENTED_ACTION_TYPES.filter((type) => !EXECUTABLE.includes(type));

  const base = { x: 0, y: 0, width: 100, height: 30 };
  const stack: Stack = {
    formatVersion: 1,
    id: 's1',
    name: 'S',
    cardWidth: 640,
    cardHeight: 480,
    startCardId: 'c1',
    cards: [
      {
        id: 'c1',
        name: 'One',
        objects: [
          {
            ...base,
            id: 'f1',
            type: 'field',
            name: '',
            value: '',
            placeholder: '',
            multiline: false,
            readOnly: false,
          },
          { ...base, id: 'l1', type: 'list', name: '', items: [], ordered: false },
          {
            ...base,
            id: 'a1',
            type: 'ai-field',
            name: '',
            prompt: 'Say hi',
            inputObjectIds: [],
            value: '',
          },
        ],
        links: [],
        onOpen: [],
      },
      { id: 'c2', name: 'Two', objects: [], links: [], onOpen: [] },
    ],
  };

  const handlers: Record<(typeof ACTION_TYPES)[number], Handler> = {
    go_to_card: [{ type: 'go_to_card', cardId: 'c2' }],
    set_value: [{ type: 'set_value', targetObjectId: 'f1', value: 'x' }],
    append_item: [{ type: 'append_item', targetObjectId: 'l1', item: 'x' }],
    remove_item: [{ type: 'remove_item', targetObjectId: 'l1', index: 0 }],
    show_message: [{ type: 'show_message', text: 'hi' }],
    run_ai_field: [{ type: 'run_ai_field', targetObjectId: 'a1' }],
    fetch_news: [{ type: 'fetch_news', targetObjectId: 'l1', topics: ['tech'] }],
    transcribe_audio: [{ type: 'transcribe_audio', targetObjectId: 'f1' }],
    schedule_notification: [
      { type: 'schedule_notification', message: 'm', at: '2026-12-01T09:00:00Z' },
    ],
  };

  it('uses a valid test stack and a valid Handler for every Action type', () => {
    expect(validateStack(stack).valid).toBe(true);
    expect(Object.keys(handlers)).toEqual([...ACTION_TYPES]);
    for (const type of ACTION_TYPES) {
      expect(validateHandler(stack, handlers[type]).valid).toBe(true);
    }
  });

  it('only names Action types that exist', () => {
    for (const type of EXECUTABLE) expect(ACTION_TYPES as readonly string[]).toContain(type);
  });

  it.each(NOT_EXECUTABLE)('skips the %s Action with a "not supported" message', (type) => {
    const handler = handlers[type as (typeof ACTION_TYPES)[number]];
    const result = executeHandler(stack, handler);
    expect(result.stack).toEqual(stack);
    expect(result.effects).toEqual([]);
    expect(result.navigateTo).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toContain(`(${type})`);
    expect(result.messages[0]).toContain('not supported');
  });

  it.each(EXECUTABLE)('runs the %s Action', (type) => {
    const result = executeHandler(stack, handlers[type as (typeof ACTION_TYPES)[number]]);
    expect(result.messages.some((message) => message.includes('not supported'))).toBe(false);
    if (type === 'go_to_card') expect(result.navigateTo).toBe('c2');
    if (type === 'show_message') expect(result.messages).toEqual(['hi']);
    if (type === 'set_value' || type === 'append_item') expect(result.stack).not.toEqual(stack);
  });
});
