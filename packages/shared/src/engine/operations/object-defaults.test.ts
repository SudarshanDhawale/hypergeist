import { describe, expect, it } from 'vitest';
import {
  AiFieldSchema,
  ButtonSchema,
  FieldSchema,
  ImageSchema,
  ListSchema,
  OBJECT_TYPES,
} from '../../format/index.ts';
import { OBJECT_DEFAULTS } from './object-defaults.ts';

const COMMON_REQUIRED = ['id', 'type', 'x', 'y', 'width', 'height'];

const SHAPES = {
  button: { keys: Object.keys(ButtonSchema.shape), required: [...COMMON_REQUIRED, 'label'] },
  field: { keys: Object.keys(FieldSchema.shape), required: COMMON_REQUIRED },
  image: { keys: Object.keys(ImageSchema.shape), required: [...COMMON_REQUIRED, 'src'] },
  list: { keys: Object.keys(ListSchema.shape), required: COMMON_REQUIRED },
  'ai-field': {
    keys: Object.keys(AiFieldSchema.shape),
    required: [...COMMON_REQUIRED, 'prompt'],
  },
} as const;

const SCHEMAS = {
  button: ButtonSchema,
  field: FieldSchema,
  image: ImageSchema,
  list: ListSchema,
  'ai-field': AiFieldSchema,
} as const;

/** A valid value for the properties that have no default. */
const REQUIRED_EXTRA = {
  button: { label: 'Go' },
  field: {},
  image: { src: 'https://example.com/a.png' },
  list: {},
  'ai-field': { prompt: 'Say hi' },
} as const;

describe('OBJECT_DEFAULTS', () => {
  it('has exactly one row per Object type', () => {
    expect(Object.keys(OBJECT_DEFAULTS).sort()).toEqual([...OBJECT_TYPES].sort());
  });

  it('stores the documented default values', () => {
    expect(OBJECT_DEFAULTS).toEqual({
      button: { name: '', onClick: [] },
      field: { name: '', value: '', placeholder: '', multiline: false, readOnly: false },
      image: { name: '', alt: '' },
      list: { name: '', items: [], ordered: false },
      'ai-field': { name: '', value: '', inputObjectIds: [] },
    });
  });

  it.each(OBJECT_TYPES)('%s: defaults and required properties cover every property', (type) => {
    const { keys, required } = SHAPES[type];
    const defaults = Object.keys(OBJECT_DEFAULTS[type]);

    // Every default names a real property, and no default is also required.
    for (const key of defaults) {
      expect(keys).toContain(key);
      expect(required).not.toContain(key);
    }
    // defaults ∪ required = all properties.
    expect([...new Set([...defaults, ...required])].sort()).toEqual([...keys].sort());
  });

  it.each(OBJECT_TYPES)('%s: every default value passes the format schema', (type) => {
    const base = { id: 'a', type, x: 0, y: 0, width: 10, height: 10 };
    const candidate = { ...base, ...REQUIRED_EXTRA[type], ...OBJECT_DEFAULTS[type] };
    expect(SCHEMAS[type].safeParse(candidate).success).toBe(true);
  });

  it('is frozen, including its arrays', () => {
    expect(Object.isFrozen(OBJECT_DEFAULTS)).toBe(true);
    for (const type of OBJECT_TYPES) {
      expect(Object.isFrozen(OBJECT_DEFAULTS[type])).toBe(true);
    }
    expect(Object.isFrozen(OBJECT_DEFAULTS.button.onClick)).toBe(true);
    expect(Object.isFrozen(OBJECT_DEFAULTS.list.items)).toBe(true);
    expect(Object.isFrozen(OBJECT_DEFAULTS['ai-field'].inputObjectIds)).toBe(true);
  });
});
