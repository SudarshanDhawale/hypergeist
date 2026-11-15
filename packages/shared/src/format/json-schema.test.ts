import { describe, expect, it } from 'vitest';
import { ACTION_TYPES, IMAGE_SRC_PATTERN, LIMITS, OBJECT_TYPES } from './limits.ts';
import { stackJsonSchema } from './json-schema.ts';

type Json = Record<string, unknown>;

function asRecord(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object at ${what}`);
  }
  return value as Json;
}

/** The `properties` entry `name` of a schema node. */
function prop(node: Json, name: string): Json {
  return asRecord(asRecord(node['properties'], 'properties')[name], `properties.${name}`);
}

/** The option of a `oneOf` list whose `type` property is the constant `typeName`. */
function variant(listNode: Json, typeName: string): Json {
  const options = asRecord(listNode['items'], 'items')['oneOf'];
  if (!Array.isArray(options)) throw new Error('Expected oneOf');
  const found = options
    .map((option) => asRecord(option, 'oneOf option'))
    .find((option) => prop(option, 'type')['const'] === typeName);
  if (found === undefined) throw new Error(`No variant ${typeName}`);
  return found;
}

/** Every `maxLength` and `maxItems` value found anywhere in the document. */
function collectBounds(node: unknown, found: { key: string; value: unknown }[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectBounds(child, found);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      if (key === 'maxLength' || key === 'maxItems') found.push({ key, value: child });
      else collectBounds(child, found);
    }
  }
  return found;
}

describe('stackJsonSchema', () => {
  const schema = asRecord(stackJsonSchema(), 'schema');
  const card = asRecord(asRecord(prop(schema, 'cards')['items'], 'cards.items'), 'card');
  const button = variant(prop(card, 'objects'), 'button');
  const field = variant(prop(card, 'objects'), 'field');
  const list = variant(prop(card, 'objects'), 'list');
  const image = variant(prop(card, 'objects'), 'image');
  const aiField = variant(prop(card, 'objects'), 'ai-field');
  const action = (type: string) => variant(prop(button, 'onClick'), type);

  it('does not throw', () => {
    expect(() => stackJsonSchema()).not.toThrow();
  });

  it('names draft 2020-12 in $schema', () => {
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('rejects unknown properties on the Stack, Cards, Objects, Links, and Actions', () => {
    expect(schema['additionalProperties']).toBe(false);
    expect(card['additionalProperties']).toBe(false);
    expect(button['additionalProperties']).toBe(false);
    expect(field['additionalProperties']).toBe(false);
    expect(list['additionalProperties']).toBe(false);
    expect(image['additionalProperties']).toBe(false);
    expect(aiField['additionalProperties']).toBe(false);
    const link = asRecord(prop(card, 'links')['items'], 'links.items');
    expect(link['additionalProperties']).toBe(false);
    expect(action('go_to_card')['additionalProperties']).toBe(false);
  });

  it('requires the Stack properties except remixedFrom', () => {
    expect(schema['required']).toEqual([
      'formatVersion',
      'id',
      'name',
      'cardWidth',
      'cardHeight',
      'startCardId',
      'cards',
    ]);
  });

  it('fixes formatVersion to the constant 1', () => {
    expect(prop(schema, 'formatVersion')['const']).toBe(1);
  });

  it('keeps the required minimum of one Card', () => {
    expect(prop(schema, 'cards')['minItems']).toBe(LIMITS.cards.min);
  });

  // Each row: where the bound sits in the schema, its keyword, and the LIMITS row it must equal.
  const boundRows: readonly {
    readonly name: string;
    readonly node: () => Json;
    readonly keyword: 'maxLength' | 'maxItems';
    readonly expected: number;
  }[] = [
    {
      name: 'stackName',
      node: () => prop(schema, 'name'),
      keyword: 'maxLength',
      expected: LIMITS.stackName.max,
    },
    {
      name: 'cards',
      node: () => prop(schema, 'cards'),
      keyword: 'maxItems',
      expected: LIMITS.cards.max,
    },
    {
      name: 'cardName',
      node: () => prop(card, 'name'),
      keyword: 'maxLength',
      expected: LIMITS.cardName.max,
    },
    {
      name: 'objectsPerCard',
      node: () => prop(card, 'objects'),
      keyword: 'maxItems',
      expected: LIMITS.objectsPerCard.max,
    },
    {
      name: 'linksPerCard',
      node: () => prop(card, 'links'),
      keyword: 'maxItems',
      expected: LIMITS.linksPerCard.max,
    },
    {
      name: 'linkLabel',
      node: () => prop(asRecord(prop(card, 'links')['items'], 'links.items'), 'label'),
      keyword: 'maxLength',
      expected: LIMITS.linkLabel.max,
    },
    {
      name: 'cardOnOpen handlerActions',
      node: () => prop(card, 'onOpen'),
      keyword: 'maxItems',
      expected: LIMITS.handlerActions.max,
    },
    {
      name: 'objectName',
      node: () => prop(button, 'name'),
      keyword: 'maxLength',
      expected: LIMITS.objectName.max,
    },
    {
      name: 'buttonLabel',
      node: () => prop(button, 'label'),
      keyword: 'maxLength',
      expected: LIMITS.buttonLabel.max,
    },
    {
      name: 'button onClick handlerActions',
      node: () => prop(button, 'onClick'),
      keyword: 'maxItems',
      expected: LIMITS.handlerActions.max,
    },
    {
      name: 'fieldValue',
      node: () => prop(field, 'value'),
      keyword: 'maxLength',
      expected: LIMITS.fieldValue.max,
    },
    {
      name: 'fieldPlaceholder',
      node: () => prop(field, 'placeholder'),
      keyword: 'maxLength',
      expected: LIMITS.fieldPlaceholder.max,
    },
    {
      name: 'listItems',
      node: () => prop(list, 'items'),
      keyword: 'maxItems',
      expected: LIMITS.listItems.max,
    },
    {
      name: 'listItemText',
      node: () => asRecord(prop(list, 'items')['items'], 'list.items.items'),
      keyword: 'maxLength',
      expected: LIMITS.listItemText.max,
    },
    {
      name: 'imageAlt',
      node: () => prop(image, 'alt'),
      keyword: 'maxLength',
      expected: LIMITS.imageAlt.max,
    },
    {
      // The schema carries only the overall maximum; the 2,000 limit for https: sources is a
      // separate check that JSON Schema output cannot express (see the test below).
      name: 'imageDataSrc',
      node: () => prop(image, 'src'),
      keyword: 'maxLength',
      expected: LIMITS.imageDataSrc.max,
    },
    {
      name: 'aiPrompt',
      node: () => prop(aiField, 'prompt'),
      keyword: 'maxLength',
      expected: LIMITS.aiPrompt.max,
    },
    {
      name: 'aiInputObjects',
      node: () => prop(aiField, 'inputObjectIds'),
      keyword: 'maxItems',
      expected: LIMITS.aiInputObjects.max,
    },
    {
      name: 'aiFieldValue',
      node: () => prop(aiField, 'value'),
      keyword: 'maxLength',
      expected: LIMITS.aiFieldValue.max,
    },
    {
      name: 'setValueText',
      node: () => prop(action('set_value'), 'value'),
      keyword: 'maxLength',
      expected: LIMITS.setValueText.max,
    },
    {
      name: 'appendItemText',
      node: () => prop(action('append_item'), 'item'),
      keyword: 'maxLength',
      expected: LIMITS.appendItemText.max,
    },
    {
      name: 'messageText',
      node: () => prop(action('show_message'), 'text'),
      keyword: 'maxLength',
      expected: LIMITS.messageText.max,
    },
    {
      name: 'newsTopics',
      node: () => prop(action('fetch_news'), 'topics'),
      keyword: 'maxItems',
      expected: LIMITS.newsTopics.max,
    },
    {
      name: 'newsTopicText',
      node: () => asRecord(prop(action('fetch_news'), 'topics')['items'], 'topics.items'),
      keyword: 'maxLength',
      expected: LIMITS.newsTopicText.max,
    },
    {
      name: 'notificationMessage',
      node: () => prop(action('schedule_notification'), 'message'),
      keyword: 'maxLength',
      expected: LIMITS.notificationMessage.max,
    },
  ];

  it.each(boundRows)('$name: $keyword equals the LIMITS row', ({ node, keyword, expected }) => {
    expect(node()[keyword]).toBe(expected);
  });

  it('has no maxLength or maxItems that is not a LIMITS maximum', () => {
    const allowed = new Set<unknown>(boundRows.map((row) => row.expected));
    const bounds = collectBounds(schema);
    expect(bounds.length).toBeGreaterThan(0);
    for (const bound of bounds) expect(allowed.has(bound.value)).toBe(true);
  });

  it('imageHttpsSrc: the https: maximum is not a schema bound, and no bound on src undercuts it', () => {
    // A single maxLength cannot depend on the scheme, so src carries only the larger maximum.
    expect(LIMITS.imageHttpsSrc.max).toBeLessThan(LIMITS.imageDataSrc.max);
    expect(prop(image, 'src')['maxLength']).toBe(LIMITS.imageDataSrc.max);
    expect(prop(image, 'src')['maxLength']).not.toBe(LIMITS.imageHttpsSrc.max);
  });

  it('has the image src pattern from IMAGE_SRC_PATTERN', () => {
    const src = prop(image, 'src');
    expect(src['type']).toBe('string');
    expect(src['pattern']).toBe(IMAGE_SRC_PATTERN.source);
  });

  it('requires unique inputObjectIds of at most 10 Entity_ID strings', () => {
    const ids = prop(aiField, 'inputObjectIds');
    expect(ids['type']).toBe('array');
    expect(ids['maxItems']).toBe(10);
    expect(ids['uniqueItems']).toBe(true);
    expect(asRecord(ids['items'], 'inputObjectIds.items')).toMatchObject({
      type: 'string',
      pattern: prop(card, 'id')['pattern'],
    });
  });

  it('keeps the minimum of one character for the ai-field prompt and none for alt and value', () => {
    expect(prop(aiField, 'prompt')['minLength']).toBe(LIMITS.aiPrompt.min);
    expect(prop(image, 'alt')['minLength']).toBe(LIMITS.imageAlt.min);
    expect(prop(aiField, 'value')['minLength']).toBe(LIMITS.aiFieldValue.min);
  });

  it('fixes type to a const for each of the five Object types', () => {
    const options = asRecord(prop(card, 'objects')['items'], 'objects.items')['oneOf'];
    if (!Array.isArray(options)) throw new Error('Expected oneOf');
    expect(options).toHaveLength(OBJECT_TYPES.length);
    const consts = options.map((option) => {
      const type = prop(asRecord(option, 'oneOf option'), 'type');
      expect(type['type']).toBe('string');
      return type['const'];
    });
    expect(new Set(consts)).toEqual(new Set(OBJECT_TYPES));
    for (const typeName of OBJECT_TYPES) {
      expect(prop(variant(prop(card, 'objects'), typeName), 'type')['const']).toBe(typeName);
    }
  });

  it('fixes type to a const for each of the nine Action types', () => {
    const options = asRecord(prop(button, 'onClick')['items'], 'onClick.items')['oneOf'];
    if (!Array.isArray(options)) throw new Error('Expected oneOf');
    expect(options).toHaveLength(ACTION_TYPES.length);
    const consts = options.map((option) => {
      const type = prop(asRecord(option, 'oneOf option'), 'type');
      expect(type['type']).toBe('string');
      return type['const'];
    });
    expect(new Set(consts)).toEqual(new Set(ACTION_TYPES));
    for (const typeName of ACTION_TYPES) {
      expect(action(typeName)['additionalProperties']).toBe(false);
      expect(action(typeName)['required']).toContain('type');
    }
  });

  it('requires at least one and at most 10 fetch_news topics of 1 to 100 characters', () => {
    const topics = prop(action('fetch_news'), 'topics');
    expect(topics['type']).toBe('array');
    expect(topics['minItems']).toBe(LIMITS.newsTopics.min);
    expect(topics['minItems']).toBe(1);
    expect(topics['maxItems']).toBe(10);
    expect(asRecord(topics['items'], 'topics.items')).toMatchObject({
      type: 'string',
      minLength: LIMITS.newsTopicText.min,
      maxLength: LIMITS.newsTopicText.max,
    });
    expect(action('fetch_news')['required']).toContain('topics');
  });

  it('keeps the non-empty text of show_message and the message of schedule_notification', () => {
    expect(prop(action('show_message'), 'text')).toMatchObject({
      type: 'string',
      minLength: LIMITS.messageText.min,
      maxLength: LIMITS.messageText.max,
    });
    expect(prop(action('schedule_notification'), 'message')).toMatchObject({
      type: 'string',
      minLength: LIMITS.notificationMessage.min,
      maxLength: LIMITS.notificationMessage.max,
    });
    expect(action('schedule_notification')['required']).toContain('message');
  });

  it('gives remove_item an integer index with minimum 0', () => {
    const remove = action('remove_item');
    expect(prop(remove, 'index')).toMatchObject({
      type: 'integer',
      minimum: LIMITS.removeItemIndex.min,
    });
    expect(prop(remove, 'index')['minimum']).toBe(0);
    expect(remove['required']).toEqual(['type', 'targetObjectId', 'index']);
  });

  describe('schedule_notification at', () => {
    const at = () => prop(action('schedule_notification'), 'at');
    const atPattern = () => {
      const pattern = at()['pattern'];
      if (typeof pattern !== 'string') throw new Error('Expected a string pattern on at');
      return new RegExp(pattern);
    };

    it('has the date-time format and a pattern', () => {
      expect(at()['type']).toBe('string');
      expect(at()['format']).toBe('date-time');
      expect(typeof at()['pattern']).toBe('string');
    });

    it('has a pattern that accepts UTC timestamps and rejects the other shapes', () => {
      const pattern = atPattern();
      for (const good of [
        '2026-12-01T09:00:00Z',
        '2026-12-01T09:00:00.5Z',
        '2028-02-29T23:59:59.999Z',
      ]) {
        expect(pattern.test(good), good).toBe(true);
      }
      for (const bad of [
        '2026-12-01T09:00:00+01:00',
        '2026-12-01T09:00Z',
        '2026-12-01T09:00:00z',
        '2026-12-01T09:00:00',
        '2027-02-29T00:00:00Z',
        '2026-12-01T24:00:00Z',
        '2026-13-01T09:00:00Z',
        'tomorrow',
      ]) {
        expect(pattern.test(bad), bad).toBe(false);
      }
    });
  });

  describe('exactly-one-of pairs', () => {
    // Each row: the Action type and its two optional members, one of which must be present.
    const pairs: readonly { readonly type: string; readonly pair: readonly [string, string] }[] = [
      { type: 'set_value', pair: ['value', 'fromObjectId'] },
      { type: 'append_item', pair: ['item', 'fromObjectId'] },
      { type: 'schedule_notification', pair: ['at', 'atFromObjectId'] },
    ];

    it.each(pairs)('$type: oneOf holds two required lists, $pair', ({ type, pair }) => {
      const node = action(type);
      expect(node['oneOf']).toEqual([{ required: [pair[0]] }, { required: [pair[1]] }]);
      // Both members stay optional at the top level; only the oneOf makes one of them required.
      expect(node['required']).not.toContain(pair[0]);
      expect(node['required']).not.toContain(pair[1]);
      expect(prop(node, pair[0])).toBeDefined();
      expect(prop(node, pair[1])).toBeDefined();
    });

    it('puts oneOf on no other Action', () => {
      const withPairs = new Set(pairs.map((row) => row.type));
      for (const typeName of ACTION_TYPES) {
        if (!withPairs.has(typeName)) expect(action(typeName)['oneOf']).toBeUndefined();
      }
    });
  });

  it('keeps the integer ranges of the card size and Object geometry', () => {
    expect(prop(schema, 'cardWidth')).toMatchObject({
      type: 'integer',
      minimum: LIMITS.cardSize.min,
      maximum: LIMITS.cardSize.max,
    });
    expect(prop(button, 'x')).toMatchObject({
      type: 'integer',
      minimum: LIMITS.objectPosition.min,
      maximum: LIMITS.objectPosition.max,
    });
    expect(prop(button, 'width')).toMatchObject({
      type: 'integer',
      minimum: LIMITS.objectSize.min,
      maximum: LIMITS.objectSize.max,
    });
  });

  it('returns a fresh, equal object on every call', () => {
    const first = stackJsonSchema();
    const second = stackJsonSchema();
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    (first as Json)['$schema'] = 'changed';
    expect(stackJsonSchema()['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
  });
});
