import { describe, expect, it } from 'vitest';
import { VALIDATION_ERROR_CODES } from './errors.ts';
import { LIMITS } from './limits.ts';
import { utf8ByteLength } from './text.ts';
import { validateHandler, validateStack } from './validate.ts';
import type { Stack } from './schemas.ts';
import { StackSchema } from './schemas.ts';

type Raw = Record<string, unknown>;

function validStack(): Raw {
  return {
    formatVersion: 1,
    id: 'todo',
    name: 'To-do',
    cardWidth: 400,
    cardHeight: 300,
    startCardId: 'home',
    cards: [
      {
        id: 'home',
        name: 'Home',
        objects: [
          {
            id: 'entry',
            type: 'field',
            name: '',
            x: 10,
            y: 10,
            width: 200,
            height: 24,
            value: '',
            placeholder: 'New task',
            multiline: false,
            readOnly: false,
          },
          {
            id: 'tasks',
            type: 'list',
            name: '',
            x: 10,
            y: 50,
            width: 200,
            height: 150,
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
              { type: 'append_item', targetObjectId: 'tasks', fromObjectId: 'entry' },
              { type: 'set_value', targetObjectId: 'entry', value: '' },
              { type: 'show_message', text: 'Added' },
            ],
          },
        ],
        links: [{ id: 'to-done', label: 'Done', targetCardId: 'done' }],
        onOpen: [],
      },
      { id: 'done', name: 'Done', objects: [], links: [], onOpen: [] },
    ],
  };
}

function stackWithoutId(): Raw {
  const stack = validStack();
  delete stack['id'];
  return stack;
}

function typedStack(): Stack {
  return StackSchema.parse(validStack());
}

function codes(result: { errors: readonly { code: string }[] }): string[] {
  return result.errors.map((error) => error.code);
}

function pathsOf(result: { errors: readonly { path: string }[] }): string[] {
  return result.errors.map((error) => error.path);
}

describe('validateStack: valid input', () => {
  it('accepts a valid stack as an object', () => {
    expect(validateStack(validStack())).toEqual({ valid: true, errors: [], truncated: false });
  });

  it('accepts the same stack as JSON text, compact or indented', () => {
    expect(validateStack(JSON.stringify(validStack())).valid).toBe(true);
    expect(validateStack(JSON.stringify(validStack(), null, 2)).valid).toBe(true);
  });

  it('accepts remixedFrom when it is a valid id', () => {
    expect(validateStack({ ...validStack(), remixedFrom: 'other' }).valid).toBe(true);
  });
});

describe('validateStack: one error per pipeline stage', () => {
  it('reports malformed JSON text as INVALID_JSON at the root', () => {
    const result = validateStack('{"formatVersion": 1,');
    expect(result.valid).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'INVALID_JSON', path: '' });
    expect(result.errors[0]?.actual).toBe('"{\\"formatVersion\\": 1,"');
  });

  it('reports text over 2,097,152 bytes as LIMIT_EXCEEDED without parsing it', () => {
    // Not JSON: a parse would report INVALID_JSON, so LIMIT_EXCEEDED proves it was not parsed.
    const result = validateStack('a'.repeat(LIMITS.maxDocumentBytes + 1));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'LIMIT_EXCEEDED', path: '' });
    expect([...(result.errors[0]?.actual ?? '')]).toHaveLength(LIMITS.actualMaxChars);
  });

  it('counts bytes, not characters, for the text limit', () => {
    // 2 bytes per character: half the limit in characters is exactly the limit in bytes.
    const half = LIMITS.maxDocumentBytes / 2;
    expect(codes(validateStack('é'.repeat(half)))).toEqual(['INVALID_JSON']);
    expect(codes(validateStack('é'.repeat(half + 1)))).toEqual(['LIMIT_EXCEEDED']);
  });

  it('parses text of exactly 2,097,152 bytes', () => {
    const text = `{}${' '.repeat(LIMITS.maxDocumentBytes - 2)}`;
    expect(utf8ByteLength(text)).toBe(LIMITS.maxDocumentBytes);
    expect(codes(validateStack(text))).not.toContain('LIMIT_EXCEEDED');
    expect(validateStack(text).errors[0]?.code).toBe('MISSING_PROPERTY');
  });

  it.each([
    ['an array', '[]', '[]'],
    ['a string', '"x"', '"x"'],
    ['null', 'null', 'null'],
    ['a number', '5', '5'],
  ])('reports %s root text as WRONG_TYPE at the root', (_name, text, actual) => {
    const result = validateStack(text);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'WRONG_TYPE', path: '', actual });
  });

  it('reports non-object, non-string candidates as WRONG_TYPE', () => {
    for (const candidate of [null, 7, true, [], [validStack()]]) {
      expect(codes(validateStack(candidate))).toEqual(['WRONG_TYPE']);
    }
    const missing = validateStack(undefined);
    expect(missing.errors).toHaveLength(1);
    expect(missing.errors[0]).toMatchObject({ code: 'WRONG_TYPE', path: '', actual: null });
  });

  it.each([2, 0, -1, 99])(
    'reports integer formatVersion %i as UNSUPPORTED_VERSION and nothing else',
    (version) => {
      const result = validateStack({ ...validStack(), formatVersion: version, bogus: true });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        code: 'UNSUPPORTED_VERSION',
        path: '/formatVersion',
        actual: String(version),
      });
      expect(result.errors[0]?.hint).toContain('1');
    },
  );

  it('does not treat a non-integer or non-number formatVersion as UNSUPPORTED_VERSION', () => {
    const fractional = validateStack({ ...validStack(), formatVersion: 1.5 });
    expect(fractional.errors).toHaveLength(1);
    expect(fractional.errors[0]).toMatchObject({ code: 'INVALID_VALUE', path: '/formatVersion' });
    const text = validateStack({ ...validStack(), formatVersion: '1' });
    expect(text.errors[0]).toMatchObject({ code: 'WRONG_TYPE', path: '/formatVersion' });
  });

  it('reports structural problems from the schema', () => {
    const withoutId = stackWithoutId();
    const result = validateStack({ ...withoutId, bogus: 1 });
    expect(result.errors.map((e) => [e.code, e.path, e.actual])).toEqual([
      ['MISSING_PROPERTY', '', null],
      ['UNKNOWN_PROPERTY', '/bogus', '1'],
    ]);
  });

  it('reports cross-entity problems from the semantic pass', () => {
    const result = validateStack({ ...validStack(), startCardId: 'nowhere' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'DANGLING_REFERENCE',
      path: '/startCardId',
      actual: '"nowhere"',
    });
  });

  it('reports an indented stack over 2,097,152 bytes as LIMIT_EXCEEDED at the root', () => {
    const base = validStack();
    const card = (base['cards'] as Raw[])[0] as Raw;
    const lists = Array.from({ length: 9 }, (_, index) => ({
      id: `big-${index}`,
      type: 'list',
      name: '',
      x: 0,
      y: 0,
      width: 8,
      height: 8,
      items: Array.from({ length: LIMITS.listItems.max }, () => 'a'.repeat(500)),
      ordered: false,
    }));
    const cards = base['cards'] as Raw[];
    const big = { ...base, cards: [{ ...card, objects: lists }, cards[1]] };
    const result = validateStack(big);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'LIMIT_EXCEEDED', path: '' });
    expect(result.valid).toBe(false);
  });
});

describe('validateStack: ordering and truncation', () => {
  it('merges structural and semantic errors into document order', () => {
    const base = validStack();
    const cards = base['cards'] as Raw[];
    const home = cards[0] as Raw;
    const objects = (home['objects'] as Raw[]).slice();
    objects[2] = {
      ...(objects[2] as Raw),
      onClick: [{ type: 'go_to_card', cardId: 'nowhere' }],
    };
    const candidate = {
      ...base,
      startCardId: 'ghost',
      cards: [
        {
          id: 'home',
          name: 'Home',
          bogus: 1,
          objects,
          links: home['links'],
          onOpen: [],
        },
        cards[1],
      ],
    };
    const result = validateStack(candidate);
    expect(result.errors.map((e) => [e.code, e.path])).toEqual([
      ['DANGLING_REFERENCE', '/startCardId'],
      ['UNKNOWN_PROPERTY', '/cards/0/bogus'],
      ['DANGLING_REFERENCE', '/cards/0/objects/2/onClick/0/cardId'],
    ]);
  });

  it.each([
    [99, 99, false],
    [100, 100, false],
    [101, 100, true],
    [150, 100, true],
  ])('with %i violations returns %i errors and truncated=%s', (count, kept, truncated) => {
    const cards = Array.from({ length: count }, (_, index) => ({
      id: `c${index}`,
      name: 'Card',
      bogus: index,
      objects: [],
      links: [],
      onOpen: [],
    }));
    const result = validateStack({ ...validStack(), startCardId: 'c0', cards });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(kept);
    expect(result.truncated).toBe(truncated);
    expect(pathsOf(result)[0]).toBe('/cards/0/bogus');
    expect(pathsOf(result)[kept - 1]).toBe(`/cards/${kept - 1}/bogus`);
    expect(codes(result).every((code) => code === 'UNKNOWN_PROPERTY')).toBe(true);
  });

  it('cuts actual to 200 code points', () => {
    const base = validStack();
    const result = validateStack({ ...base, bogus: '😀'.repeat(300) });
    expect([...(result.errors[0]?.actual ?? '')]).toHaveLength(LIMITS.actualMaxChars);
  });

  it('fills expected, hint, and message for every error', () => {
    const withoutId = stackWithoutId();
    const result = validateStack({ ...withoutId, bogus: 1, startCardId: 'nowhere', cardWidth: 1 });
    expect(result.errors.length).toBeGreaterThan(2);
    for (const error of result.errors) {
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.expected.length).toBeGreaterThan(0);
      expect(error.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('validateStack: purity', () => {
  it('returns deeply equal results for the same candidate and leaves it unmodified', () => {
    const candidate = { ...validStack(), startCardId: 'nowhere', bogus: [1, { a: 2 }] };
    const before = structuredClone(candidate);
    const first = validateStack(candidate);
    const second = validateStack(candidate);
    expect(second).toEqual(first);
    expect(candidate).toEqual(before);
  });

  it('never throws, even for values that are not JSON data', () => {
    const cyclic: Raw = { ...validStack() };
    cyclic['self'] = cyclic;
    expect(validateStack(cyclic).valid).toBe(false);

    const hostile = { ...validStack() };
    Object.defineProperty(hostile, 'formatVersion', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const result = validateStack(hostile);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'WRONG_TYPE', path: '' });
  });
});

describe('validateHandler', () => {
  it('accepts a valid handler, including an empty one', () => {
    const stack = typedStack();
    expect(validateHandler(stack, [])).toEqual({ valid: true, errors: [], truncated: false });
    expect(
      validateHandler(stack, [
        { type: 'go_to_card', cardId: 'done' },
        { type: 'set_value', targetObjectId: 'entry', fromObjectId: 'tasks' },
      ]).valid,
    ).toBe(true);
  });

  it('reports semantic errors with paths relative to the handler', () => {
    const result = validateHandler(typedStack(), [
      { type: 'show_message', text: 'hi' },
      { type: 'go_to_card', cardId: 'nowhere' },
      { type: 'append_item', targetObjectId: 'entry', item: 'x' },
    ]);
    expect(result.errors.map((e) => [e.code, e.path])).toEqual([
      ['DANGLING_REFERENCE', '/1/cardId'],
      ['WRONG_REFERENCE_TYPE', '/2/targetObjectId'],
    ]);
  });

  it('accepts a complete fetch_news action', () => {
    const result = validateHandler(typedStack(), [
      { type: 'fetch_news', targetObjectId: 'tasks', topics: ['technology'] },
    ]);
    expect(result).toEqual({ valid: true, errors: [], truncated: false });
  });

  it('reports structural errors, including unknown action types', () => {
    const result = validateHandler(typedStack(), [
      { type: 'nope' },
      { type: 'show_message', text: '' },
    ]);
    expect(result.errors.map((e) => [e.code, e.path])).toEqual([
      ['INVALID_VALUE', '/0/type'],
      ['INVALID_VALUE', '/1/text'],
    ]);
    expect(result.errors[0]?.message).toContain('is unknown');
  });

  it('reports a candidate that is not an array at the root', () => {
    const result = validateHandler(typedStack(), { type: 'show_message', text: 'hi' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'WRONG_TYPE', path: '' });
  });

  it('reports more than 20 actions as LIMIT_EXCEEDED', () => {
    const actions = Array.from({ length: 21 }, () => ({ type: 'show_message', text: 'x' }));
    const result = validateHandler(typedStack(), actions);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'LIMIT_EXCEEDED', path: '' });
  });

  it('leaves the stack and handler unmodified', () => {
    const stack = typedStack();
    const handler = [{ type: 'go_to_card', cardId: 'nowhere' }];
    const stackBefore = structuredClone(stack);
    const handlerBefore = structuredClone(handler);
    validateHandler(stack, handler);
    expect(stack).toEqual(stackBefore);
    expect(handler).toEqual(handlerBefore);
  });
});

/* Task 2.6: boundary tables, one example per code, size limits, and result shape. */

type Path = readonly (string | number)[];
type Pair = readonly [string, string];

function pointer(path: Path): string {
  return path.length === 0 ? '' : `/${path.join('/')}`;
}

function pairs(result: { errors: readonly { code: string; path: string }[] }): Pair[] {
  return result.errors.map((error) => [error.code, error.path] as const);
}

/** A deep copy of `base` with the value at `path` replaced. */
function setAt(base: Raw, path: Path, value: unknown): Raw {
  const copy = structuredClone(base);
  let node: unknown = copy;
  for (const segment of path.slice(0, -1)) {
    node = (node as Record<string | number, unknown>)[segment];
  }
  const last = path[path.length - 1] as string | number;
  (node as Record<string | number, unknown>)[last] = value;
  return copy;
}

function deleteAt(base: Raw, path: Path): Raw {
  const copy = structuredClone(base);
  let node: unknown = copy;
  for (const segment of path.slice(0, -1)) {
    node = (node as Record<string | number, unknown>)[segment];
  }
  delete (node as Record<string | number, unknown>)[path[path.length - 1] as string | number];
  return copy;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const VALID: unknown = { valid: true, errors: [], truncated: false };

function homeCard(stack: Raw): Raw {
  return (stack['cards'] as Raw[])[0] as Raw;
}

/** The valid stack with an `item` (not `fromObjectId`) on the first action, so every text property exists. */
function tableBase(): Raw {
  return setAt(validStack(), ['cards', 0, 'objects', 2, 'onClick', 0], {
    type: 'append_item',
    targetObjectId: 'tasks',
    item: 'x',
  });
}

function field(id: string, x = 0, y = 0, width = 8, height = 8): Raw {
  return {
    id,
    type: 'field',
    name: '',
    x,
    y,
    width,
    height,
    value: '',
    placeholder: '',
    multiline: false,
    readOnly: false,
  };
}

function emptyCard(id: string): Raw {
  return { id, name: id, objects: [], links: [], onOpen: [] };
}

describe('validateStack: text boundary tables (code points)', () => {
  type TextRow = { name: string; path: Path; min: number; max: number };
  const rows: TextRow[] = [
    { name: 'stack name', path: ['name'], min: 1, max: 100 },
    { name: 'card name', path: ['cards', 0, 'name'], min: 1, max: 100 },
    { name: 'link label', path: ['cards', 0, 'links', 0, 'label'], min: 1, max: 100 },
    { name: 'object name', path: ['cards', 0, 'objects', 0, 'name'], min: 0, max: 100 },
    { name: 'button label', path: ['cards', 0, 'objects', 2, 'label'], min: 1, max: 100 },
    { name: 'field value', path: ['cards', 0, 'objects', 0, 'value'], min: 0, max: 10_000 },
    {
      name: 'field placeholder',
      path: ['cards', 0, 'objects', 0, 'placeholder'],
      min: 0,
      max: 200,
    },
    { name: 'list item text', path: ['cards', 0, 'objects', 1, 'items', 0], min: 0, max: 500 },
    {
      name: 'set_value value',
      path: ['cards', 0, 'objects', 2, 'onClick', 1, 'value'],
      min: 0,
      max: 10_000,
    },
    {
      name: 'append_item item',
      path: ['cards', 0, 'objects', 2, 'onClick', 0, 'item'],
      min: 0,
      max: 500,
    },
    {
      name: 'show_message text',
      path: ['cards', 0, 'objects', 2, 'onClick', 2, 'text'],
      min: 1,
      max: 500,
    },
  ];

  it('uses a base stack that is valid', () => {
    expect(validateStack(tableBase())).toEqual(VALID);
  });

  it('ties the table to LIMITS', () => {
    const expected = [
      LIMITS.stackName,
      LIMITS.cardName,
      LIMITS.linkLabel,
      LIMITS.objectName,
      LIMITS.buttonLabel,
      LIMITS.fieldValue,
      LIMITS.fieldPlaceholder,
      LIMITS.listItemText,
      LIMITS.setValueText,
      LIMITS.appendItemText,
      LIMITS.messageText,
    ];
    expect(rows.map((row) => ({ min: row.min, max: row.max }))).toEqual(expected);
  });

  describe.each([
    ['ASCII', 'a'],
    ['astral (two UTF-16 units each)', '😀'],
  ])('%s text', (_label, unit) => {
    describe.each(rows)('$name', ({ path, min, max }) => {
      const at = (count: number): Raw => setAt(tableBase(), path, unit.repeat(count));

      it('accepts exactly the maximum', () => {
        expect(validateStack(at(max))).toEqual(VALID);
      });

      it('rejects maximum plus one with one LIMIT_EXCEEDED at the value', () => {
        const result = validateStack(at(max + 1));
        expect(pairs(result)).toEqual([['LIMIT_EXCEEDED', pointer(path)]]);
        expect(result.valid).toBe(false);
        expect(result.truncated).toBe(false);
      });

      it('accepts exactly the minimum', () => {
        expect(validateStack(at(min))).toEqual(VALID);
      });

      if (min > 0) {
        it('rejects minimum minus one with one INVALID_VALUE at the value', () => {
          expect(pairs(validateStack(at(min - 1)))).toEqual([['INVALID_VALUE', pointer(path)]]);
        });
      }
    });
  });

  it('accepts a 64-character id and rejects 65 and 0 characters', () => {
    const at = (id: string): Raw => setAt(validStack(), ['id'], id);
    expect(validateStack(at('a'.repeat(64)))).toEqual(VALID);
    expect(pairs(validateStack(at('a'.repeat(65))))).toEqual([['INVALID_VALUE', '/id']]);
    expect(pairs(validateStack(at('')))).toEqual([['INVALID_VALUE', '/id']]);
  });
});

describe('validateStack: integer boundary tables', () => {
  type IntRow = {
    name: string;
    path: Path;
    min: number;
    max: number;
    base: () => Raw;
    atMax: Pair[];
    overMax: Pair[];
  };

  const objectPath = '/cards/0/objects/0';
  const cardBase = (): Raw => setAt(validStack(), ['cards', 0, 'objects'], []);
  const objectBase = (): Raw => {
    const stack = setAt(validStack(), ['cards', 0, 'objects'], [field('only')]);
    return { ...stack, cardWidth: 4096, cardHeight: 4096 };
  };
  const outOfBounds: Pair = ['OUT_OF_BOUNDS', objectPath];

  const rows: IntRow[] = [
    {
      name: 'cardWidth',
      path: ['cardWidth'],
      ...LIMITS.cardSize,
      base: cardBase,
      atMax: [],
      overMax: [['INVALID_VALUE', '/cardWidth']],
    },
    {
      name: 'cardHeight',
      path: ['cardHeight'],
      ...LIMITS.cardSize,
      base: cardBase,
      atMax: [],
      overMax: [['INVALID_VALUE', '/cardHeight']],
    },
    {
      // The object is 8 wide, so x = 4096 is an integer the schema accepts but the card cannot hold.
      name: 'object x',
      path: ['cards', 0, 'objects', 0, 'x'],
      ...LIMITS.objectPosition,
      base: objectBase,
      atMax: [outOfBounds],
      overMax: [outOfBounds, ['INVALID_VALUE', `${objectPath}/x`]],
    },
    {
      name: 'object y',
      path: ['cards', 0, 'objects', 0, 'y'],
      ...LIMITS.objectPosition,
      base: objectBase,
      atMax: [outOfBounds],
      overMax: [outOfBounds, ['INVALID_VALUE', `${objectPath}/y`]],
    },
    {
      name: 'object width',
      path: ['cards', 0, 'objects', 0, 'width'],
      ...LIMITS.objectSize,
      base: objectBase,
      atMax: [],
      overMax: [outOfBounds, ['INVALID_VALUE', `${objectPath}/width`]],
    },
    {
      name: 'object height',
      path: ['cards', 0, 'objects', 0, 'height'],
      ...LIMITS.objectSize,
      base: objectBase,
      atMax: [],
      overMax: [outOfBounds, ['INVALID_VALUE', `${objectPath}/height`]],
    },
  ];

  it.each(rows)('$name: base stacks are valid', ({ base }) => {
    expect(validateStack(base())).toEqual(VALID);
  });

  it.each(rows)('$name: at min, max, min - 1, and max + 1', (row) => {
    const at = (value: number): Raw => setAt(row.base(), row.path, value);
    expect(validateStack(at(row.min))).toEqual(VALID);
    expect(pairs(validateStack(at(row.max)))).toEqual(row.atMax);
    expect(pairs(validateStack(at(row.min - 1)))).toEqual([['INVALID_VALUE', pointer(row.path)]]);
    expect(pairs(validateStack(at(row.max + 1)))).toEqual(row.overMax);
  });
});

describe('validateStack: count boundary tables', () => {
  const handlerOf = (count: number): unknown[] =>
    Array.from({ length: count }, () => ({ type: 'show_message', text: 'x' }));

  it('accepts 200 cards and rejects 201 with LIMIT_EXCEEDED at /cards', () => {
    const withCards = (count: number): Raw => {
      const extra = Array.from({ length: count - 2 }, (_, index) => emptyCard(`extra-${index}`));
      return setAt(validStack(), ['cards'], [homeCard(validStack()), emptyCard('done'), ...extra]);
    };
    expect(validateStack(withCards(200))).toEqual(VALID);
    expect(pairs(validateStack(withCards(201)))).toEqual([['LIMIT_EXCEEDED', '/cards']]);
  });

  it('accepts 1 card and rejects 0 cards at /cards', () => {
    const one = setAt(
      setAt(validStack(), ['cards'], [{ ...homeCard(validStack()), links: [] }]),
      ['startCardId'],
      'home',
    );
    expect(validateStack(one)).toEqual(VALID);
    const none = setAt(validStack(), ['cards'], []);
    expect(pairs(validateStack(none))).toEqual([
      ['DANGLING_REFERENCE', '/startCardId'],
      ['INVALID_VALUE', '/cards'],
    ]);
  });

  it('accepts 100 objects and rejects 101 with LIMIT_EXCEEDED at the array', () => {
    const withObjects = (count: number): Raw =>
      setAt(
        validStack(),
        ['cards', 0, 'objects'],
        Array.from({ length: count }, (_, index) => field(`o${index}`)),
      );
    expect(validateStack(withObjects(100))).toEqual(VALID);
    expect(pairs(validateStack(withObjects(101)))).toEqual([
      ['LIMIT_EXCEEDED', '/cards/0/objects'],
    ]);
  });

  it('accepts 50 links and rejects 51 with LIMIT_EXCEEDED at the array', () => {
    const withLinks = (count: number): Raw => {
      const targets = Array.from({ length: 51 }, (_, index) => emptyCard(`t${index}`));
      const links = Array.from({ length: count }, (_, index) => ({
        id: `l${index}`,
        label: 'Go',
        targetCardId: `t${index}`,
      }));
      return setAt(validStack(), ['cards'], [{ ...homeCard(validStack()), links }, ...targets]);
    };
    expect(validateStack(withLinks(50))).toEqual(VALID);
    expect(pairs(validateStack(withLinks(51)))).toEqual([['LIMIT_EXCEEDED', '/cards/0/links']]);
  });

  it('accepts 500 list items and rejects 501 with LIMIT_EXCEEDED at the array', () => {
    const withItems = (count: number): Raw =>
      setAt(
        validStack(),
        ['cards', 0, 'objects', 1, 'items'],
        Array.from({ length: count }, () => 'x'),
      );
    expect(validateStack(withItems(500))).toEqual(VALID);
    expect(pairs(validateStack(withItems(501)))).toEqual([
      ['LIMIT_EXCEEDED', '/cards/0/objects/1/items'],
    ]);
  });

  it.each([
    ['onClick', ['cards', 0, 'objects', 2, 'onClick']],
    ['onOpen', ['cards', 0, 'onOpen']],
  ] as const)('accepts 20 actions and rejects 21 in %s', (_name, path) => {
    expect(validateStack(setAt(validStack(), path, handlerOf(20)))).toEqual(VALID);
    expect(validateStack(setAt(validStack(), path, handlerOf(0)))).toEqual(VALID);
    expect(pairs(validateStack(setAt(validStack(), path, handlerOf(21))))).toEqual([
      ['LIMIT_EXCEEDED', pointer(path)],
    ]);
  });
});

describe('validateStack: one example per error code', () => {
  type Example = {
    code: string;
    candidate: unknown;
    path: string;
    actual: string | null;
  };

  const examples: Example[] = [
    { code: 'INVALID_JSON', candidate: '{', path: '', actual: '"{"' },
    {
      code: 'MISSING_PROPERTY',
      candidate: deleteAt(validStack(), ['cards', 0, 'name']),
      path: '/cards/0',
      actual: null,
    },
    {
      code: 'UNKNOWN_PROPERTY',
      candidate: setAt(validStack(), ['cards', 1, 'extra'], true),
      path: '/cards/1/extra',
      actual: 'true',
    },
    {
      code: 'WRONG_TYPE',
      candidate: setAt(validStack(), ['cardWidth'], '400'),
      path: '/cardWidth',
      actual: '"400"',
    },
    {
      code: 'INVALID_VALUE',
      candidate: setAt(validStack(), ['cards', 0, 'name'], ''),
      path: '/cards/0/name',
      actual: '""',
    },
    {
      code: 'DUPLICATE_ID',
      // The link comes after the object "entry" in document order, so the link is the duplicate.
      candidate: setAt(validStack(), ['cards', 0, 'links', 0, 'id'], 'entry'),
      path: '/cards/0/links/0/id',
      actual: '"entry"',
    },
    {
      code: 'DANGLING_REFERENCE',
      candidate: setAt(
        validStack(),
        ['cards', 1, 'onOpen'],
        [{ type: 'go_to_card', cardId: 'zz' }],
      ),
      path: '/cards/1/onOpen/0/cardId',
      actual: '"zz"',
    },
    {
      code: 'WRONG_REFERENCE_TYPE',
      candidate: setAt(
        validStack(),
        ['cards', 1, 'onOpen'],
        [{ type: 'append_item', targetObjectId: 'entry', item: 'x' }],
      ),
      path: '/cards/1/onOpen/0/targetObjectId',
      actual: '"entry"',
    },
    {
      code: 'OUT_OF_BOUNDS',
      candidate: setAt(validStack(), ['cards', 0, 'objects', 0, 'width'], 500),
      path: '/cards/0/objects/0',
      actual: JSON.stringify({ ...field('entry', 10, 10, 500, 24), placeholder: 'New task' }),
    },
    {
      code: 'LIMIT_EXCEEDED',
      candidate: setAt(validStack(), ['name'], 'a'.repeat(101)),
      path: '/name',
      actual: JSON.stringify('a'.repeat(101)),
    },
    {
      code: 'UNSUPPORTED_VERSION',
      candidate: setAt(validStack(), ['formatVersion'], 2),
      path: '/formatVersion',
      actual: '2',
    },
    {
      code: 'DUPLICATE_LINK',
      candidate: setAt(
        validStack(),
        ['cards', 0, 'links'],
        [
          { id: 'to-done', label: 'Done', targetCardId: 'done' },
          { id: 'again', label: 'Again', targetCardId: 'done' },
        ],
      ),
      path: '/cards/0/links/1/targetCardId',
      actual: '"done"',
    },
  ];

  it.each(examples)('$code', ({ code, candidate, path, actual }) => {
    const result = validateStack(candidate);
    expect(result.valid).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.errors).toHaveLength(1);
    const [error] = result.errors;
    expect(error).toMatchObject({ code, path, actual });
    expect(error?.message.length).toBeGreaterThan(0);
    expect(error?.expected.length).toBeGreaterThan(0);
    expect(error?.hint.length).toBeGreaterThan(0);
  });

  it('covers the 12 codes the validator can return, and never returns the two engine-only codes', () => {
    const covered = new Set(examples.map((example) => example.code));
    const expected = VALIDATION_ERROR_CODES.filter(
      (code) => code !== 'OUT_OF_RANGE' && code !== 'UNKNOWN_ENTITY',
    );
    expect(expected).toHaveLength(12);
    expect([...covered].sort()).toEqual([...expected].sort());
    for (const { candidate } of examples) {
      for (const error of validateStack(candidate).errors) {
        expect(['OUT_OF_RANGE', 'UNKNOWN_ENTITY']).not.toContain(error.code);
      }
    }
  });
});

describe('validateStack: size limits at the byte boundary', () => {
  const indentedBytes = (candidate: unknown): number =>
    utf8ByteLength(`${JSON.stringify(candidate, null, 2)}\n`);

  /** A valid stack whose two-space indented text, with trailing newline, is exactly `target` bytes. */
  function stackOfIndentedSize(target: number): Raw {
    const base = validStack();
    const cards = base['cards'] as Raw[];
    const home = homeCard(base);
    const lengths: number[][] = [
      ...Array.from({ length: 8 }, () => Array.from({ length: 500 }, () => 500)),
      [],
    ];
    const nameLengths = Array.from({ length: lengths.length }, () => 0);
    const build = (): Raw => ({
      ...base,
      cards: [
        {
          ...home,
          objects: lengths.map((itemLengths, index) => ({
            id: `big-${index}`,
            type: 'list',
            name: 'a'.repeat(nameLengths[index] ?? 0),
            x: 0,
            y: 0,
            width: 8,
            height: 8,
            items: itemLengths.map((length) => 'a'.repeat(length)),
            ordered: false,
          })),
        },
        cards[1],
      ],
    });
    const last = lengths[lengths.length - 1] as number[];
    // A 500-character item adds 518 bytes to the indented text.
    while (indentedBytes(build()) + 519 <= target) last.push(500);
    const rest = target - indentedBytes(build());
    if (rest >= 18) last.push(Math.min(500, rest - 18));
    let leftover = target - indentedBytes(build());
    nameLengths.forEach((_, index) => {
      const take = Math.min(LIMITS.objectName.max, leftover);
      nameLengths[index] = take;
      leftover -= take;
    });
    return build();
  }

  it('accepts an indented stack of exactly 2,097,152 bytes', () => {
    const candidate = stackOfIndentedSize(LIMITS.maxDocumentBytes);
    expect(indentedBytes(candidate)).toBe(LIMITS.maxDocumentBytes);
    expect(validateStack(candidate)).toEqual(VALID);
  });

  it('rejects an indented stack one byte over with LIMIT_EXCEEDED at the root', () => {
    const candidate = stackOfIndentedSize(LIMITS.maxDocumentBytes + 1);
    expect(indentedBytes(candidate)).toBe(LIMITS.maxDocumentBytes + 1);
    const result = validateStack(candidate);
    expect(pairs(result)).toEqual([['LIMIT_EXCEEDED', '']]);
    expect([...(result.errors[0]?.actual ?? '')].length).toBeLessThanOrEqual(LIMITS.actualMaxChars);
  });

  it('applies the indented limit to the parsed text of a compact stack too', () => {
    const compact = JSON.stringify(stackOfIndentedSize(LIMITS.maxDocumentBytes + 1));
    expect(utf8ByteLength(compact)).toBeLessThan(LIMITS.maxDocumentBytes);
    expect(pairs(validateStack(compact))).toEqual([['LIMIT_EXCEEDED', '']]);
  });

  it('measures the text limit in UTF-8 bytes for four-byte characters', () => {
    const exact = '😀'.repeat(LIMITS.maxDocumentBytes / 4);
    expect(utf8ByteLength(exact)).toBe(LIMITS.maxDocumentBytes);
    expect(pairs(validateStack(exact))).toEqual([['INVALID_JSON', '']]);
    const over = `${'😀'.repeat(LIMITS.maxDocumentBytes / 4 - 1)}aaaaa`;
    expect(utf8ByteLength(over)).toBe(LIMITS.maxDocumentBytes + 1);
    expect(pairs(validateStack(over))).toEqual([['LIMIT_EXCEEDED', '']]);
  });
});

describe('validateStack: malformed and non-object input', () => {
  it.each([
    ['empty text', '', '""'],
    ['unclosed object', '{"a":', '"{\\"a\\":"'],
    ['single quotes', "{'a':1}", `"{'a':1}"`],
    ['trailing garbage', '{}}', '"{}}"'],
    ['trailing comma', '{"a":1,}', '"{\\"a\\":1,}"'],
    ['undefined literal', 'undefined', '"undefined"'],
    ['NaN literal', 'NaN', '"NaN"'],
  ])('reports %s as INVALID_JSON at the root', (_name, text, actual) => {
    const result = validateStack(text);
    expect(result.valid).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'INVALID_JSON', path: '', actual });
  });

  it.each(['true', 'false', ' [ ] ', '"{}"'])('reports the root text %j as WRONG_TYPE', (text) => {
    expect(pairs(validateStack(text))).toEqual([['WRONG_TYPE', '']]);
  });

  it('reports functions, symbols, and bigints as WRONG_TYPE without throwing', () => {
    for (const candidate of [() => 1, Symbol('s'), 10n]) {
      expect(pairs(validateStack(candidate))).toEqual([['WRONG_TYPE', '']]);
    }
  });

  it('checks formatVersion 2 and 0 before any other problem, and treats 1.5 as structural', () => {
    const broken = { ...validStack(), cards: 'x', name: 5 };
    expect(pairs(validateStack({ ...broken, formatVersion: 2 }))).toEqual([
      ['UNSUPPORTED_VERSION', '/formatVersion'],
    ]);
    expect(pairs(validateStack({ ...broken, formatVersion: 0 }))).toEqual([
      ['UNSUPPORTED_VERSION', '/formatVersion'],
    ]);
    expect(pairs(validateStack({ ...broken, formatVersion: 1.5 }))[0]).toEqual([
      'INVALID_VALUE',
      '/formatVersion',
    ]);
  });

  it('accepts JSON text for formatVersion 1 and 1.0, and rejects "2" from text', () => {
    const text = JSON.stringify(validStack());
    expect(validateStack(text.replace('"formatVersion":1', '"formatVersion":1.0'))).toEqual(VALID);
    expect(pairs(validateStack(text.replace('"formatVersion":1', '"formatVersion":2')))).toEqual([
      ['UNSUPPORTED_VERSION', '/formatVersion'],
    ]);
  });
});

describe('validateStack: result shape', () => {
  it('gives every error exactly the six documented properties, with a JSON Pointer path', () => {
    const candidate = {
      ...setAt(validStack(), ['cards', 0, 'name'], ''),
      bogus: 1,
      cardHeight: 'x',
    };
    const result = validateStack(candidate);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    for (const error of result.errors) {
      expect(Object.keys(error).sort()).toEqual([
        'actual',
        'code',
        'expected',
        'hint',
        'message',
        'path',
      ]);
      expect(error.path === '' || error.path.startsWith('/')).toBe(true);
      expect(error.actual === null || typeof error.actual === 'string').toBe(true);
    }
    expect(Object.keys(result).sort()).toEqual(['errors', 'truncated', 'valid']);
  });

  it('escapes "~" and "/" in property names in the path', () => {
    const result = validateStack({ ...validStack(), 'a/b~c': 1 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'UNKNOWN_PROPERTY', path: '/a~1b~0c' });
  });

  it('sets valid to the negation of a non-empty errors array', () => {
    for (const candidate of [validStack(), { ...validStack(), bogus: 1 }, '{', 5]) {
      const result = validateStack(candidate);
      expect(result.valid).toBe(result.errors.length === 0);
    }
  });
});

describe('validateStack: candidates are never modified', () => {
  it('accepts a deeply frozen valid stack and a deeply frozen invalid stack', () => {
    const valid = deepFreeze(validStack());
    expect(validateStack(valid)).toEqual(VALID);

    const invalid = deepFreeze({
      ...setAt(validStack(), ['cards', 0, 'objects', 0, 'width'], 500),
      startCardId: 'nowhere',
      bogus: [1, { a: 2 }],
    });
    const first = validateStack(invalid);
    expect(first.valid).toBe(false);
    expect(first.errors.length).toBeGreaterThanOrEqual(3);
    expect(validateStack(invalid)).toEqual(first);
  });

  it('returns the same result for JSON text on every call', () => {
    const text = JSON.stringify({ ...validStack(), startCardId: 'nowhere' });
    expect(validateStack(text)).toEqual(validateStack(text));
  });
});
