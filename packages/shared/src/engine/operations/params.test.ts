import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LIMITS, OBJECT_TYPES } from '../../format/index.ts';
import {
  AddObjectParamsSchema,
  CreateCardParamsSchema,
  DeleteCardParamsSchema,
  LinkCardsParamsSchema,
  RemoveObjectParamsSchema,
  SetActionParamsSchema,
  UpdateObjectParamsSchema,
} from './params.ts';

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
  return value as Json;
}

const SCHEMAS = {
  create_card: CreateCardParamsSchema,
  delete_card: DeleteCardParamsSchema,
  remove_object: RemoveObjectParamsSchema,
  link_cards: LinkCardsParamsSchema,
  set_action: SetActionParamsSchema,
} as const;

type Case = { minimal: unknown; full: unknown; required: string };

const CASES: Record<keyof typeof SCHEMAS, Case> = {
  create_card: {
    minimal: { name: 'Home' },
    full: { name: 'Home', id: 'card-9', index: 0 },
    required: 'name',
  },
  delete_card: { minimal: { cardId: 'card-1' }, full: { cardId: 'card-1' }, required: 'cardId' },
  remove_object: {
    minimal: { objectId: 'obj-1' },
    full: { objectId: 'obj-1' },
    required: 'objectId',
  },
  link_cards: {
    minimal: { fromCardId: 'card-1', toCardId: 'card-2', label: 'Next' },
    full: { fromCardId: 'card-1', toCardId: 'card-1', label: 'Next', id: 'link-9' },
    required: 'label',
  },
  set_action: {
    minimal: { ownerId: 'obj-1', handler: [] },
    full: {
      ownerId: 'card-1',
      handler: [
        { type: 'go_to_card', cardId: 'card-2' },
        { type: 'show_message', text: 'Hi' },
      ],
    },
    required: 'handler',
  },
};

const NAMES = Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[];

describe.each(NAMES)('%s parameters', (name) => {
  const schema = SCHEMAS[name];
  const sample = CASES[name];

  it('accepts a minimal and a full parameter object', () => {
    expect(schema.safeParse(sample.minimal).success).toBe(true);
    expect(schema.safeParse(sample.full).success).toBe(true);
  });

  it('rejects an unknown key', () => {
    expect(schema.safeParse({ ...asRecord(sample.minimal), extra: 1 }).success).toBe(false);
  });

  it('rejects a missing required key', () => {
    const withoutRequired = Object.fromEntries(
      Object.entries(asRecord(sample.minimal)).filter(([key]) => key !== sample.required),
    );
    expect(schema.safeParse(withoutRequired).success).toBe(false);
  });

  it('rejects non-object parameters', () => {
    for (const value of [null, 'x', 1, []]) expect(schema.safeParse(value).success).toBe(false);
  });

  it('has a top-level description of 1 to 1,000 characters', () => {
    const json = asRecord(z.toJSONSchema(schema));
    const description = json['description'];
    expect(typeof description).toBe('string');
    expect((description as string).length).toBeGreaterThan(0);
    expect((description as string).length).toBeLessThanOrEqual(1000);
  });

  it('describes every parameter in 1 to 500 characters', () => {
    const json = asRecord(z.toJSONSchema(schema));
    const properties = asRecord(json['properties']);
    expect(Object.keys(properties).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(properties)) {
      const description = asRecord(value)['description'];
      expect(typeof description, key).toBe('string');
      expect((description as string).length, key).toBeGreaterThan(0);
      expect((description as string).length, key).toBeLessThanOrEqual(500);
    }
  });

  it('is an object with additionalProperties false and the right required list', () => {
    const json = asRecord(z.toJSONSchema(schema));
    expect(json['type']).toBe('object');
    expect(json['additionalProperties']).toBe(false);
    expect(json['required']).toContain(sample.required);
  });
});

describe('create_card parameters', () => {
  it('rejects wrong types', () => {
    expect(CreateCardParamsSchema.safeParse({ name: 5 }).success).toBe(false);
    expect(CreateCardParamsSchema.safeParse({ name: 'A', id: 5 }).success).toBe(false);
    expect(CreateCardParamsSchema.safeParse({ name: 'A', index: '1' }).success).toBe(false);
  });

  it('rejects an empty name and a 101-character name, and accepts 100', () => {
    expect(CreateCardParamsSchema.safeParse({ name: '' }).success).toBe(false);
    expect(CreateCardParamsSchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
    expect(CreateCardParamsSchema.safeParse({ name: 'a'.repeat(100) }).success).toBe(true);
  });

  it('rejects a non-integer, negative or bad-pattern index and id', () => {
    expect(CreateCardParamsSchema.safeParse({ name: 'A', index: 1.5 }).success).toBe(false);
    expect(CreateCardParamsSchema.safeParse({ name: 'A', index: -1 }).success).toBe(false);
    expect(CreateCardParamsSchema.safeParse({ name: 'A', id: 'Bad Id' }).success).toBe(false);
  });

  it('leaves the upper bound of index to stage B', () => {
    expect(CreateCardParamsSchema.safeParse({ name: 'A', index: 10_000 }).success).toBe(true);
  });
});

describe('link_cards parameters', () => {
  it('rejects an empty label and a 101-character label', () => {
    const base = { fromCardId: 'card-1', toCardId: 'card-2' };
    expect(LinkCardsParamsSchema.safeParse({ ...base, label: '' }).success).toBe(false);
    expect(LinkCardsParamsSchema.safeParse({ ...base, label: 'a'.repeat(101) }).success).toBe(
      false,
    );
    expect(LinkCardsParamsSchema.safeParse({ ...base, label: 'a'.repeat(100) }).success).toBe(true);
  });

  it('rejects a wrong type for an id', () => {
    expect(
      LinkCardsParamsSchema.safeParse({ fromCardId: 1, toCardId: 'card-2', label: 'x' }).success,
    ).toBe(false);
  });
});

describe('set_action parameters', () => {
  it('rejects an unknown Action type', () => {
    expect(
      SetActionParamsSchema.safeParse({ ownerId: 'obj-1', handler: [{ type: 'explode' }] }).success,
    ).toBe(false);
  });

  it('leaves the 20-Action maximum to the semantic pass, as the format does', () => {
    const action = { type: 'show_message', text: 'x' };
    expect(
      SetActionParamsSchema.safeParse({ ownerId: 'obj-1', handler: Array(21).fill(action) })
        .success,
    ).toBe(true);
  });

  it('rejects a handler that is not an array', () => {
    expect(SetActionParamsSchema.safeParse({ ownerId: 'obj-1', handler: {} }).success).toBe(false);
  });
});

describe('JSON Schema bounds', () => {
  it('keeps the format maxLength and maxItems through the description metadata', () => {
    const name = asRecord(asRecord(z.toJSONSchema(CreateCardParamsSchema))['properties'])['name'];
    expect(asRecord(name)['maxLength']).toBe(LIMITS.cardName.max);
    const label = asRecord(asRecord(z.toJSONSchema(LinkCardsParamsSchema))['properties'])['label'];
    expect(asRecord(label)['maxLength']).toBe(LIMITS.linkLabel.max);
    const handler = asRecord(asRecord(z.toJSONSchema(SetActionParamsSchema))['properties'])[
      'handler'
    ];
    expect(asRecord(handler)['maxItems']).toBe(LIMITS.handlerActions.max);
  });

  it('gives index type integer with minimum 0', () => {
    const index = asRecord(asRecord(z.toJSONSchema(CreateCardParamsSchema))['properties'])['index'];
    expect(asRecord(index)['type']).toBe('integer');
    expect(asRecord(index)['minimum']).toBe(0);
  });
});

const BOX = { cardId: 'card-1', x: 0, y: 0, width: 100, height: 40 };

const ADD_MINIMAL: Record<(typeof OBJECT_TYPES)[number], Json> = {
  button: { ...BOX, type: 'button', label: 'Go' },
  field: { ...BOX, type: 'field' },
  image: { ...BOX, type: 'image', src: 'https://example.com/a.png' },
  list: { ...BOX, type: 'list' },
  'ai-field': { ...BOX, type: 'ai-field', prompt: 'Summarize.' },
};

const UPDATE_KEYS = [
  'name',
  'x',
  'y',
  'width',
  'height',
  'label',
  'onClick',
  'value',
  'placeholder',
  'multiline',
  'readOnly',
  'items',
  'ordered',
  'src',
  'alt',
  'prompt',
  'inputObjectIds',
];

function propertiesOf(schema: z.ZodType): Json {
  return asRecord(asRecord(z.toJSONSchema(schema))['properties']);
}

function expectDescriptions(properties: Json): void {
  expect(Object.keys(properties).length).toBeGreaterThan(0);
  for (const [key, value] of Object.entries(properties)) {
    const description = asRecord(value)['description'];
    expect(typeof description, key).toBe('string');
    expect((description as string).length, key).toBeGreaterThan(0);
    expect((description as string).length, key).toBeLessThanOrEqual(500);
  }
}

describe('add_object parameters', () => {
  it.each(OBJECT_TYPES)('accepts the minimal parameters of a %s', (type) => {
    expect(AddObjectParamsSchema.safeParse(ADD_MINIMAL[type]).success).toBe(true);
  });

  it('accepts a full parameter object', () => {
    const full = {
      ...BOX,
      type: 'ai-field',
      id: 'obj-9',
      index: 0,
      name: 'Summary',
      prompt: 'Summarize.',
      inputObjectIds: ['obj-1'],
      value: '',
    };
    expect(AddObjectParamsSchema.safeParse(full).success).toBe(true);
  });

  it('is flat: the schema itself does not tie type-specific keys to the type', () => {
    // Stage B reports "property does not belong to this type"; the schema only checks values.
    expect(AddObjectParamsSchema.safeParse({ ...ADD_MINIMAL.field, label: 'x' }).success).toBe(
      true,
    );
  });

  it('rejects an unknown key', () => {
    expect(AddObjectParamsSchema.safeParse({ ...ADD_MINIMAL.field, extra: 1 }).success).toBe(false);
  });

  it.each(['cardId', 'type', 'x', 'y', 'width', 'height'])('rejects a missing %s', (key) => {
    const without = Object.fromEntries(
      Object.entries(ADD_MINIMAL.field).filter(([name]) => name !== key),
    );
    expect(AddObjectParamsSchema.safeParse(without).success).toBe(false);
  });

  it('leaves the type-specific required properties to stage B', () => {
    expect(AddObjectParamsSchema.safeParse({ ...BOX, type: 'button' }).success).toBe(true);
  });

  it('rejects an unknown type and a non-string type', () => {
    expect(AddObjectParamsSchema.safeParse({ ...BOX, type: 'widget' }).success).toBe(false);
    expect(AddObjectParamsSchema.safeParse({ ...BOX, type: 3 }).success).toBe(false);
  });

  it('rejects out-of-range, non-integer and string geometry', () => {
    const field = ADD_MINIMAL.field;
    for (const patch of [
      { x: -1 },
      { y: 4097 },
      { x: 1.5 },
      { width: 7 },
      { height: 4097 },
      { width: '10' },
    ]) {
      expect(AddObjectParamsSchema.safeParse({ ...field, ...patch }).success, String(patch)).toBe(
        false,
      );
    }
    expect(AddObjectParamsSchema.safeParse({ ...field, width: 8, x: 4096 }).success).toBe(true);
  });

  it('rejects a bad index and a bad id, and leaves the upper bound of index to stage B', () => {
    const field = ADD_MINIMAL.field;
    expect(AddObjectParamsSchema.safeParse({ ...field, index: -1 }).success).toBe(false);
    expect(AddObjectParamsSchema.safeParse({ ...field, index: 1.5 }).success).toBe(false);
    expect(AddObjectParamsSchema.safeParse({ ...field, id: 'Bad Id' }).success).toBe(false);
    expect(AddObjectParamsSchema.safeParse({ ...field, index: 10_000 }).success).toBe(true);
  });

  it('rejects bad property values with the format limits', () => {
    expect(AddObjectParamsSchema.safeParse({ ...ADD_MINIMAL.button, label: '' }).success).toBe(
      false,
    );
    expect(
      AddObjectParamsSchema.safeParse({ ...ADD_MINIMAL.button, label: 'a'.repeat(101) }).success,
    ).toBe(false);
    expect(AddObjectParamsSchema.safeParse({ ...ADD_MINIMAL.image, src: 'ftp://x' }).success).toBe(
      false,
    );
    expect(
      AddObjectParamsSchema.safeParse({ ...ADD_MINIMAL.field, multiline: 'yes' }).success,
    ).toBe(false);
    expect(AddObjectParamsSchema.safeParse({ ...ADD_MINIMAL.list, items: [1] }).success).toBe(
      false,
    );
    expect(
      AddObjectParamsSchema.safeParse({ ...ADD_MINIMAL['ai-field'], prompt: '' }).success,
    ).toBe(false);
    expect(
      AddObjectParamsSchema.safeParse({ ...ADD_MINIMAL['ai-field'], inputObjectIds: ['Bad Id'] })
        .success,
    ).toBe(false);
    expect(
      AddObjectParamsSchema.safeParse({ ...ADD_MINIMAL.button, onClick: [{ type: 'explode' }] })
        .success,
    ).toBe(false);
  });

  it('rejects non-object parameters', () => {
    for (const value of [null, 'x', 1, []]) {
      expect(AddObjectParamsSchema.safeParse(value).success).toBe(false);
    }
  });

  describe('JSON Schema', () => {
    const json = asRecord(z.toJSONSchema(AddObjectParamsSchema));

    it('is a flat object at the root, with no oneOf, anyOf or default', () => {
      expect(json['type']).toBe('object');
      expect(json['additionalProperties']).toBe(false);
      expect(json['oneOf']).toBeUndefined();
      expect(json['anyOf']).toBeUndefined();
      expect(JSON.stringify(json)).not.toContain('"default"');
    });

    it('requires exactly cardId, type, x, y, width and height', () => {
      expect([...(json['required'] as string[])].sort()).toEqual(
        ['cardId', 'height', 'type', 'width', 'x', 'y'].sort(),
      );
    });

    it('lists every Object type in the type enum', () => {
      expect(asRecord(propertiesOf(AddObjectParamsSchema)['type'])['enum']).toEqual([
        ...OBJECT_TYPES,
      ]);
    });

    it('has every optional property and a description for each', () => {
      const properties = propertiesOf(AddObjectParamsSchema);
      for (const key of ['id', 'index', 'name', ...UPDATE_KEYS.slice(5)]) {
        expect(properties, key).toHaveProperty(key);
      }
      expectDescriptions(properties);
    });

    it('has a top-level description of 1 to 1,000 characters', () => {
      const description = json['description'];
      expect(typeof description).toBe('string');
      expect((description as string).length).toBeGreaterThan(0);
      expect((description as string).length).toBeLessThanOrEqual(1000);
    });

    it('names the Object types in the description of each type-specific parameter', () => {
      const properties = propertiesOf(AddObjectParamsSchema);
      const text = (key: string) => String(asRecord(properties[key])['description']);
      expect(text('label')).toContain('button');
      expect(text('src')).toContain('image');
      expect(text('prompt')).toContain('ai-field');
      expect(text('items')).toContain('List');
      expect(text('placeholder')).toContain('Field');
    });

    it('keeps the format bounds', () => {
      const properties = propertiesOf(AddObjectParamsSchema);
      expect(asRecord(properties['name'])['maxLength']).toBe(LIMITS.objectName.max);
      expect(asRecord(properties['label'])['maxLength']).toBe(LIMITS.buttonLabel.max);
      expect(asRecord(properties['value'])['maxLength']).toBe(LIMITS.fieldValue.max);
      expect(asRecord(properties['placeholder'])['maxLength']).toBe(LIMITS.fieldPlaceholder.max);
      expect(asRecord(properties['alt'])['maxLength']).toBe(LIMITS.imageAlt.max);
      expect(asRecord(properties['prompt'])['maxLength']).toBe(LIMITS.aiPrompt.max);
      expect(asRecord(properties['items'])['maxItems']).toBe(LIMITS.listItems.max);
      expect(asRecord(properties['inputObjectIds'])['maxItems']).toBe(LIMITS.aiInputObjects.max);
      expect(asRecord(properties['onClick'])['maxItems']).toBe(LIMITS.handlerActions.max);
      expect(asRecord(properties['x'])['minimum']).toBe(LIMITS.objectPosition.min);
      expect(asRecord(properties['x'])['maximum']).toBe(LIMITS.objectPosition.max);
      expect(asRecord(properties['width'])['minimum']).toBe(LIMITS.objectSize.min);
      expect(asRecord(properties['height'])['maximum']).toBe(LIMITS.objectSize.max);
      expect(asRecord(properties['index'])['type']).toBe('integer');
      expect(asRecord(properties['index'])['minimum']).toBe(0);
    });
  });
});

describe('update_object parameters', () => {
  const base = { objectId: 'obj-1' };

  it('accepts empty changes', () => {
    expect(UpdateObjectParamsSchema.safeParse({ ...base, changes: {} }).success).toBe(true);
  });

  it('accepts a change of each mutable property', () => {
    const changes: Json = {
      name: 'N',
      x: 1,
      y: 2,
      width: 20,
      height: 30,
      label: 'L',
      onClick: [{ type: 'show_message', text: 'Hi' }],
      value: 'v',
      placeholder: 'p',
      multiline: true,
      readOnly: false,
      items: ['a'],
      ordered: true,
      src: 'https://example.com/a.png',
      alt: 'a',
      prompt: 'P',
      inputObjectIds: ['obj-2'],
    };
    expect(Object.keys(changes).sort()).toEqual([...UPDATE_KEYS].sort());
    expect(UpdateObjectParamsSchema.safeParse({ ...base, changes }).success).toBe(true);
    for (const [key, value] of Object.entries(changes)) {
      expect(
        UpdateObjectParamsSchema.safeParse({ ...base, changes: { [key]: value } }).success,
        key,
      ).toBe(true);
    }
  });

  it('rejects id and type in changes as unknown keys', () => {
    for (const key of ['id', 'type']) {
      const result = UpdateObjectParamsSchema.safeParse({ ...base, changes: { [key]: 'x' } });
      expect(result.success, key).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.code).toBe('unrecognized_keys');
        expect(result.error.issues[0]?.path).toEqual(['changes']);
      }
    }
  });

  it('rejects an unknown key in changes and at the top level', () => {
    expect(UpdateObjectParamsSchema.safeParse({ ...base, changes: { color: 'red' } }).success).toBe(
      false,
    );
    expect(UpdateObjectParamsSchema.safeParse({ ...base, changes: {}, extra: 1 }).success).toBe(
      false,
    );
  });

  it('rejects a missing objectId or changes, and non-object changes', () => {
    expect(UpdateObjectParamsSchema.safeParse({ changes: {} }).success).toBe(false);
    expect(UpdateObjectParamsSchema.safeParse(base).success).toBe(false);
    for (const changes of [null, 'x', 1, []]) {
      expect(UpdateObjectParamsSchema.safeParse({ ...base, changes }).success).toBe(false);
    }
  });

  it('rejects bad values in changes', () => {
    for (const changes of [
      { x: -1 },
      { width: 7 },
      { label: '' },
      { multiline: 'y' },
      { items: 1 },
    ]) {
      expect(UpdateObjectParamsSchema.safeParse({ ...base, changes }).success).toBe(false);
    }
  });

  describe('JSON Schema', () => {
    const json = asRecord(z.toJSONSchema(UpdateObjectParamsSchema));
    const changes = asRecord(propertiesOf(UpdateObjectParamsSchema)['changes']);

    it('is an object at the root with objectId and changes required', () => {
      expect(json['type']).toBe('object');
      expect(json['additionalProperties']).toBe(false);
      expect([...(json['required'] as string[])].sort()).toEqual(['changes', 'objectId']);
    });

    it('has a strict changes object with all mutable properties, optional, and no id or type', () => {
      expect(changes['type']).toBe('object');
      expect(changes['additionalProperties']).toBe(false);
      expect(changes['required'] ?? []).toEqual([]);
      const properties = asRecord(changes['properties']);
      expect(Object.keys(properties).sort()).toEqual([...UPDATE_KEYS].sort());
      expect(properties).not.toHaveProperty('id');
      expect(properties).not.toHaveProperty('type');
    });

    it('describes the parameters, changes and each changed property', () => {
      expect(String(json['description']).length).toBeGreaterThan(0);
      expect(String(json['description']).length).toBeLessThanOrEqual(1000);
      expectDescriptions(propertiesOf(UpdateObjectParamsSchema));
      expectDescriptions(asRecord(changes['properties']));
    });

    it('keeps the format bounds', () => {
      const properties = asRecord(changes['properties']);
      expect(asRecord(properties['label'])['maxLength']).toBe(LIMITS.buttonLabel.max);
      expect(asRecord(properties['items'])['maxItems']).toBe(LIMITS.listItems.max);
      expect(asRecord(properties['width'])['minimum']).toBe(LIMITS.objectSize.min);
    });
  });
});
