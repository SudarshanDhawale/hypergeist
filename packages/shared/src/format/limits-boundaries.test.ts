import { describe, expect, it } from 'vitest';
import { LIMITS } from './limits.ts';
import { validateStack } from './validate.ts';

/*
 * Task 11.4: boundary tables for the LIMITS rows, through validateStack.
 * Text rows run with ASCII and with astral characters (counted in code points).
 * The array-count rows for cards, objects, links, list items, and handlers live in
 * validate.test.ts and array-limits.test.ts. The document-size rows live in check.test.ts.
 */

type Raw = Record<string, unknown>;
type Path = readonly (string | number)[];
type Pair = readonly [string, string];
type Bound = { readonly min: number; readonly max: number };

const VALID: unknown = { valid: true, errors: [], truncated: false };

function pointer(path: Path): string {
  return path.length === 0 ? '' : `/${path.join('/')}`;
}

function pairs(candidate: unknown): Pair[] {
  return validateStack(candidate).errors.map((error) => [error.code, error.path] as const);
}

/** A deep copy of `base` with the value at `path` replaced. */
function setAt(base: Raw, path: Path, value: unknown): Raw {
  const copy = structuredClone(base);
  let node: unknown = copy;
  for (const segment of path.slice(0, -1)) {
    node = (node as Record<string | number, unknown>)[segment];
  }
  (node as Record<string | number, unknown>)[path[path.length - 1] as string | number] = value;
  return copy;
}

function field(id: string): Raw {
  return {
    id,
    type: 'field',
    name: '',
    x: 10,
    y: 10,
    width: 200,
    height: 24,
    value: '',
    placeholder: '',
    multiline: false,
    readOnly: false,
  };
}

function image(id: string): Raw {
  return {
    id,
    type: 'image',
    name: '',
    x: 0,
    y: 100,
    width: 100,
    height: 100,
    src: 'https://example.com/a.png',
    alt: '',
  };
}

function aiField(id: string, inputObjectIds: readonly string[] = ['entry']): Raw {
  return {
    id,
    type: 'ai-field',
    name: '',
    x: 0,
    y: 200,
    width: 200,
    height: 60,
    prompt: 'Summarize',
    inputObjectIds,
    value: '',
  };
}

/** Action indexes in the button's `onClick` of `baseStack`. */
const ACTION = {
  setValue: 0,
  appendItem: 1,
  showMessage: 2,
  removeItem: 3,
  fetchNews: 4,
  scheduleNotification: 5,
} as const;

/** A valid stack with one of every Object type and an Action that has each limited property. */
function baseStack(): Raw {
  return {
    formatVersion: 1,
    id: 'limits',
    name: 'Limits',
    cardWidth: 400,
    cardHeight: 300,
    startCardId: 'home',
    cards: [
      {
        id: 'home',
        name: 'Home',
        objects: [
          field('entry'),
          {
            id: 'tasks',
            type: 'list',
            name: '',
            x: 10,
            y: 50,
            width: 200,
            height: 100,
            items: ['one'],
            ordered: false,
          },
          {
            id: 'add',
            type: 'button',
            name: '',
            x: 220,
            y: 10,
            width: 60,
            height: 24,
            label: 'Add',
            onClick: [
              { type: 'set_value', targetObjectId: 'entry', value: 'v' },
              { type: 'append_item', targetObjectId: 'tasks', item: 'x' },
              { type: 'show_message', text: 'Added' },
              { type: 'remove_item', targetObjectId: 'tasks', index: 0 },
              { type: 'fetch_news', targetObjectId: 'tasks', topics: ['technology'] },
              {
                type: 'schedule_notification',
                message: 'Stand up',
                at: '2027-01-01T09:00:00Z',
              },
            ],
          },
          image('pic'),
          aiField('brain'),
        ],
        links: [{ id: 'to-done', label: 'Done', targetCardId: 'done' }],
        onOpen: [],
      },
      { id: 'done', name: 'Done', objects: [], links: [], onOpen: [] },
    ],
  };
}

const OBJECTS = ['cards', 0, 'objects'] as const;
const CLICK = [...OBJECTS, 2, 'onClick'] as const;

describe('limits boundaries: base stack', () => {
  it('is valid', () => {
    expect(validateStack(baseStack())).toEqual(VALID);
  });
});

describe('limits boundaries: text rows (code points)', () => {
  type TextRow = { key: keyof typeof LIMITS; name: string; path: Path; limit: Bound };
  const rows: TextRow[] = [
    { key: 'stackName', name: 'stack name', path: ['name'], limit: LIMITS.stackName },
    { key: 'cardName', name: 'card name', path: ['cards', 0, 'name'], limit: LIMITS.cardName },
    {
      key: 'linkLabel',
      name: 'link label',
      path: ['cards', 0, 'links', 0, 'label'],
      limit: LIMITS.linkLabel,
    },
    {
      key: 'objectName',
      name: 'object name',
      path: [...OBJECTS, 0, 'name'],
      limit: LIMITS.objectName,
    },
    {
      key: 'buttonLabel',
      name: 'button label',
      path: [...OBJECTS, 2, 'label'],
      limit: LIMITS.buttonLabel,
    },
    {
      key: 'fieldValue',
      name: 'field value',
      path: [...OBJECTS, 0, 'value'],
      limit: LIMITS.fieldValue,
    },
    {
      key: 'fieldPlaceholder',
      name: 'field placeholder',
      path: [...OBJECTS, 0, 'placeholder'],
      limit: LIMITS.fieldPlaceholder,
    },
    {
      key: 'listItemText',
      name: 'list item text',
      path: [...OBJECTS, 1, 'items', 0],
      limit: LIMITS.listItemText,
    },
    {
      key: 'setValueText',
      name: 'set_value value',
      path: [...CLICK, ACTION.setValue, 'value'],
      limit: LIMITS.setValueText,
    },
    {
      key: 'appendItemText',
      name: 'append_item item',
      path: [...CLICK, ACTION.appendItem, 'item'],
      limit: LIMITS.appendItemText,
    },
    {
      key: 'messageText',
      name: 'show_message text',
      path: [...CLICK, ACTION.showMessage, 'text'],
      limit: LIMITS.messageText,
    },
    {
      key: 'imageAlt',
      name: 'image alt',
      path: [...OBJECTS, 3, 'alt'],
      limit: LIMITS.imageAlt,
    },
    {
      key: 'aiPrompt',
      name: 'ai-field prompt',
      path: [...OBJECTS, 4, 'prompt'],
      limit: LIMITS.aiPrompt,
    },
    {
      key: 'aiFieldValue',
      name: 'ai-field value',
      path: [...OBJECTS, 4, 'value'],
      limit: LIMITS.aiFieldValue,
    },
    {
      key: 'newsTopicText',
      name: 'fetch_news topic',
      path: [...CLICK, ACTION.fetchNews, 'topics', 0],
      limit: LIMITS.newsTopicText,
    },
    {
      key: 'notificationMessage',
      name: 'schedule_notification message',
      path: [...CLICK, ACTION.scheduleNotification, 'message'],
      limit: LIMITS.notificationMessage,
    },
  ];

  describe.each([
    ['ASCII', 'a'],
    ['astral (two UTF-16 units each)', '😀'],
  ])('%s text', (_label, unit) => {
    describe.each(rows)('$name', ({ path, limit }) => {
      const at = (count: number): Raw => setAt(baseStack(), path, unit.repeat(count));

      it('accepts exactly the maximum', () => {
        expect(validateStack(at(limit.max))).toEqual(VALID);
      });

      it('rejects maximum plus one with exactly one LIMIT_EXCEEDED at the value', () => {
        const result = validateStack(at(limit.max + 1));
        expect(pairs(at(limit.max + 1))).toEqual([['LIMIT_EXCEEDED', pointer(path)]]);
        expect(result.truncated).toBe(false);
      });

      it('accepts exactly the minimum', () => {
        expect(validateStack(at(limit.min))).toEqual(VALID);
      });

      if (limit.min > 0) {
        it('rejects minimum minus one with exactly one INVALID_VALUE at the value', () => {
          expect(pairs(at(limit.min - 1))).toEqual([['INVALID_VALUE', pointer(path)]]);
        });
      }
    });
  });

  it('counts astral text in code points, not UTF-16 units', () => {
    // 100 astral characters are 200 UTF-16 units; 101 are over the 100 code point maximum.
    const path = ['name'] as const;
    expect('😀'.repeat(LIMITS.stackName.max)).toHaveLength(LIMITS.stackName.max * 2);
    expect(validateStack(setAt(baseStack(), path, '😀'.repeat(100)))).toEqual(VALID);
    expect(pairs(setAt(baseStack(), path, '😀'.repeat(101)))).toEqual([
      ['LIMIT_EXCEEDED', '/name'],
    ]);
  });
});

describe('limits boundaries: integer rows', () => {
  const size = LIMITS.cardSize;

  describe.each([
    ['cardWidth', ['cardWidth']],
    ['cardHeight', ['cardHeight']],
  ] as const)('stack %s', (_name, path) => {
    // No objects, so a small card cannot push an object out of bounds.
    const emptyCard = (): Raw => setAt(baseStack(), ['cards', 0, 'objects'], []);
    const at = (value: number): Raw => setAt(emptyCard(), path, value);

    it('accepts 64 and 4096', () => {
      expect(validateStack(at(size.min))).toEqual(VALID);
      expect(validateStack(at(size.max))).toEqual(VALID);
    });

    it('rejects 63 and 4097 with one INVALID_VALUE at the property', () => {
      expect(pairs(at(size.min - 1))).toEqual([['INVALID_VALUE', pointer(path)]]);
      expect(pairs(at(size.max + 1))).toEqual([['INVALID_VALUE', pointer(path)]]);
    });
  });

  describe.each([
    ['field', field('only')],
    ['image', image('only')],
    ['ai-field', aiField('only', [])],
  ] as const)('%s geometry', (_type, object) => {
    const objectPath = '/cards/0/objects/0';
    const onlyObject = (): Raw => {
      const stack = setAt(
        baseStack(),
        ['cards', 0, 'objects'],
        [{ ...structuredClone(object), x: 0, y: 0 }],
      );
      return { ...stack, cardWidth: 4096, cardHeight: 4096 };
    };
    const outOfBounds: Pair = ['OUT_OF_BOUNDS', objectPath];

    it('uses a base stack that is valid', () => {
      expect(validateStack(onlyObject())).toEqual(VALID);
    });

    describe.each([['x'], ['y']] as const)('%s', (key) => {
      const at = (value: number): Raw => setAt(onlyObject(), [...OBJECTS, 0, key], value);
      const here = ['INVALID_VALUE', `${objectPath}/${key}`] as const;

      it('accepts 0', () => {
        expect(validateStack(at(LIMITS.objectPosition.min))).toEqual(VALID);
      });

      it('rejects -1 with one INVALID_VALUE', () => {
        expect(pairs(at(LIMITS.objectPosition.min - 1))).toEqual([here]);
      });

      it('accepts 4096 in the schema, but the object no longer fits the card', () => {
        expect(pairs(at(LIMITS.objectPosition.max))).toEqual([outOfBounds]);
      });

      it('rejects 4097 as INVALID_VALUE (and the object is out of bounds too)', () => {
        expect(pairs(at(LIMITS.objectPosition.max + 1))).toEqual([outOfBounds, here]);
      });
    });

    describe.each([['width'], ['height']] as const)('%s', (key) => {
      const at = (value: number): Raw => setAt(onlyObject(), [...OBJECTS, 0, key], value);
      const here = ['INVALID_VALUE', `${objectPath}/${key}`] as const;

      it('accepts 8 and 4096', () => {
        expect(validateStack(at(LIMITS.objectSize.min))).toEqual(VALID);
        expect(validateStack(at(LIMITS.objectSize.max))).toEqual(VALID);
      });

      it('rejects 7 with one INVALID_VALUE', () => {
        expect(pairs(at(LIMITS.objectSize.min - 1))).toEqual([here]);
      });

      it('rejects 4097 as INVALID_VALUE (and the object is out of bounds too)', () => {
        expect(pairs(at(LIMITS.objectSize.max + 1))).toEqual([outOfBounds, here]);
      });
    });
  });

  describe('remove_item index', () => {
    const path = [...CLICK, ACTION.removeItem, 'index'] as const;
    const at = (value: number): Raw => setAt(baseStack(), path, value);

    it('accepts 0 and a large index (there is no maximum)', () => {
      expect(LIMITS.removeItemIndex.min).toBe(0);
      expect(validateStack(at(0))).toEqual(VALID);
      expect(validateStack(at(1))).toEqual(VALID);
      expect(validateStack(at(Number.MAX_SAFE_INTEGER))).toEqual(VALID);
    });

    it.each([-1, 1.5, -0.5])('rejects %s with one INVALID_VALUE at the index', (value) => {
      expect(pairs(at(value))).toEqual([['INVALID_VALUE', pointer(path)]]);
    });
  });
});

describe('limits boundaries: counts of the new array rows', () => {
  describe('ai-field inputObjectIds', () => {
    const inputIds = Array.from({ length: LIMITS.aiInputObjects.max + 2 }, (_, i) => `in${i}`);
    const withInputs = (count: number): Raw => {
      const fields = inputIds.map((id) => ({ ...field(id), x: 0, y: 0, width: 8, height: 8 }));
      const objects = [...fields, aiField('brain', inputIds.slice(0, count))];
      return setAt(baseStack(), OBJECTS, objects);
    };
    const inputsPath = [...OBJECTS, inputIds.length, 'inputObjectIds'] as const;

    it('accepts 0 and 10 inputs', () => {
      expect(validateStack(withInputs(LIMITS.aiInputObjects.min))).toEqual(VALID);
      expect(validateStack(withInputs(LIMITS.aiInputObjects.max))).toEqual(VALID);
    });

    it('rejects 11 inputs with one LIMIT_EXCEEDED at the array', () => {
      expect(pairs(withInputs(LIMITS.aiInputObjects.max + 1))).toEqual([
        ['LIMIT_EXCEEDED', pointer(inputsPath)],
      ]);
    });
  });

  describe('fetch_news topics', () => {
    const path = [...CLICK, ACTION.fetchNews, 'topics'] as const;
    const withTopics = (count: number): Raw =>
      setAt(
        baseStack(),
        path,
        Array.from({ length: count }, () => 'news'),
      );

    it('accepts 1 and 10 topics', () => {
      expect(validateStack(withTopics(LIMITS.newsTopics.min))).toEqual(VALID);
      expect(validateStack(withTopics(LIMITS.newsTopics.max))).toEqual(VALID);
    });

    it('rejects 0 topics with one INVALID_VALUE at the array', () => {
      expect(pairs(withTopics(LIMITS.newsTopics.min - 1))).toEqual([
        ['INVALID_VALUE', pointer(path)],
      ]);
    });

    it('rejects 11 topics with one LIMIT_EXCEEDED at the array', () => {
      expect(pairs(withTopics(LIMITS.newsTopics.max + 1))).toEqual([
        ['LIMIT_EXCEEDED', pointer(path)],
      ]);
    });
  });
});

describe('limits boundaries: image src', () => {
  const path = [...OBJECTS, 3, 'src'] as const;
  const at = (src: string): Raw => setAt(baseStack(), path, src);

  describe('https: sources (1 to 2,000 characters)', () => {
    const https = (length: number): string => `https://${'a'.repeat(length - 8)}`;

    it('accepts the shortest source and exactly 2,000 characters', () => {
      expect(validateStack(at('https://a'))).toEqual(VALID);
      expect(https(LIMITS.imageHttpsSrc.max)).toHaveLength(2000);
      expect(validateStack(at(https(LIMITS.imageHttpsSrc.max)))).toEqual(VALID);
    });

    it('rejects 2,001 characters with exactly one LIMIT_EXCEEDED', () => {
      expect(pairs(at(https(LIMITS.imageHttpsSrc.max + 1)))).toEqual([
        ['LIMIT_EXCEEDED', pointer(path)],
      ]);
    });

    it.each([
      ['empty text', ''],
      ['a scheme with no authority', 'https://'],
    ])('rejects %s with one INVALID_VALUE', (_name, src) => {
      expect(LIMITS.imageHttpsSrc.min).toBe(1);
      expect(pairs(at(src))).toEqual([['INVALID_VALUE', pointer(path)]]);
    });
  });

  describe('data: sources (up to 1,000,000 characters)', () => {
    /*
     * The payload is groups of four characters, so a total of exactly 1,000,000 is not
     * reachable: the prefix is 22 (png, gif) or 23 (jpeg, webp) characters, and neither
     * 999,978 nor 999,977 is a multiple of four. The largest valid length is the biggest
     * total at or below 1,000,000, and the smallest over-limit one is four characters more.
     */
    const types = [
      ['png', 'data:image/png;base64,'],
      ['gif', 'data:image/gif;base64,'],
      ['jpeg', 'data:image/jpeg;base64,'],
      ['webp', 'data:image/webp;base64,'],
    ] as const;
    const largest = (prefix: string): string =>
      prefix + 'A'.repeat(Math.floor((LIMITS.imageDataSrc.max - prefix.length) / 4) * 4);
    const overLimit = (prefix: string): string => `${largest(prefix)}AAAA`;

    it.each(types)('accepts the largest valid %s source', (_type, prefix) => {
      const src = largest(prefix);
      expect(src.length).toBeLessThanOrEqual(LIMITS.imageDataSrc.max);
      expect(src.length + 4).toBeGreaterThan(LIMITS.imageDataSrc.max);
      expect(validateStack(at(src))).toEqual(VALID);
    });

    it.each(types)(
      'rejects the smallest over-limit %s source with one LIMIT_EXCEEDED',
      (_t, prefix) => {
        const src = overLimit(prefix);
        expect(src.length).toBeGreaterThan(LIMITS.imageDataSrc.max);
        expect(pairs(at(src))).toEqual([['LIMIT_EXCEEDED', pointer(path)]]);
      },
    );

    it('reports a malformed source of exactly 1,000,000 characters as INVALID_VALUE only', () => {
      const prefix = 'data:image/png;base64,';
      const src = prefix + 'A'.repeat(LIMITS.imageDataSrc.max - prefix.length);
      expect(src).toHaveLength(LIMITS.imageDataSrc.max);
      expect(pairs(at(src))).toEqual([['INVALID_VALUE', pointer(path)]]);
    });

    it('reports a malformed source of 1,000,001 characters as INVALID_VALUE and LIMIT_EXCEEDED', () => {
      const prefix = 'data:image/png;base64,';
      const src = prefix + 'A'.repeat(LIMITS.imageDataSrc.max + 1 - prefix.length);
      expect(src).toHaveLength(LIMITS.imageDataSrc.max + 1);
      expect(pairs(at(src))).toEqual([
        ['INVALID_VALUE', pointer(path)],
        ['LIMIT_EXCEEDED', pointer(path)],
      ]);
    });

    it('accepts the shortest payload and rejects an empty one', () => {
      expect(validateStack(at('data:image/png;base64,AAAA'))).toEqual(VALID);
      expect(pairs(at('data:image/png;base64,'))).toEqual([['INVALID_VALUE', pointer(path)]]);
    });
  });
});

describe('limits boundaries: coverage of LIMITS', () => {
  it('names every LIMITS row either here or in the file that owns it', () => {
    const here = [
      'stackName',
      'cardName',
      'linkLabel',
      'objectName',
      'buttonLabel',
      'fieldValue',
      'fieldPlaceholder',
      'listItemText',
      'setValueText',
      'appendItemText',
      'messageText',
      'imageAlt',
      'aiPrompt',
      'aiFieldValue',
      'newsTopicText',
      'notificationMessage',
      'cardSize',
      'objectPosition',
      'objectSize',
      'removeItemIndex',
      'aiInputObjects',
      'newsTopics',
      'imageHttpsSrc',
      'imageDataSrc',
    ];
    // validate.test.ts and array-limits.test.ts hold the counts; check.test.ts holds the byte
    // and error-count limits.
    const elsewhere = [
      'cards',
      'objectsPerCard',
      'linksPerCard',
      'listItems',
      'handlerActions',
      'maxDocumentBytes',
      'maxErrors',
      'actualMaxChars',
    ];
    expect([...here, ...elsewhere].sort()).toEqual(Object.keys(LIMITS).sort());
  });
});
