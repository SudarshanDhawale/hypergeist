import { describe, expect, it } from 'vitest';
import { LIMITS } from './limits.ts';
import { StackSchema } from './schemas.ts';
import { validateHandler, validateStack } from './validate.ts';
import type { ValidationResult } from './errors.ts';

// Example tests for the array maximums that the semantic pass enforces:
// Cards, Objects, Links, List items, and Handler Actions.

type Raw = Record<string, unknown>;

const VALID = { valid: true, errors: [], truncated: false };

function pairs(result: ValidationResult): [string, string][] {
  return result.errors.map((error) => [error.code, error.path]);
}

function sortedPairs(result: ValidationResult): [string, string][] {
  return pairs(result).sort((a, b) => (a.join(' ') < b.join(' ') ? -1 : 1));
}

function field(id: string, overrides: Raw = {}): Raw {
  return {
    id,
    type: 'field',
    name: '',
    x: 0,
    y: 0,
    width: 100,
    height: 24,
    value: '',
    placeholder: '',
    multiline: false,
    readOnly: false,
    ...overrides,
  };
}

function list(id: string, items: unknown[]): Raw {
  return {
    id,
    type: 'list',
    name: '',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    items,
    ordered: false,
  };
}

function card(id: string, overrides: Raw = {}): Raw {
  return { id, name: id, objects: [], links: [], onOpen: [], ...overrides };
}

function stack(cards: Raw[]): Raw {
  return {
    formatVersion: 1,
    id: 'limits',
    name: 'Limits',
    cardWidth: 400,
    cardHeight: 300,
    startCardId: 'c0',
    cards,
  };
}

function oneCardStack(overrides: Raw): Raw {
  return stack([card('c0', overrides)]);
}

const message = { type: 'show_message', text: 'x' };
const actions = (count: number): Raw[] => Array.from({ length: count }, () => ({ ...message }));

describe('array maximums: Cards (200)', () => {
  const withCards = (count: number, mutate?: (cards: Raw[]) => void): Raw => {
    const cards = Array.from({ length: count }, (_, index) => card(`c${index}`));
    mutate?.(cards);
    return stack(cards);
  };

  it('accepts exactly 200 Cards', () => {
    expect(validateStack(withCards(200))).toEqual(VALID);
  });

  it('gives exactly one LIMIT_EXCEEDED at /cards for 201 Cards', () => {
    expect(pairs(validateStack(withCards(201)))).toEqual([['LIMIT_EXCEEDED', '/cards']]);
  });

  it('also reports a bad element inside an oversize Cards array', () => {
    const candidate = withCards(201, (cards) => {
      cards[5] = card('c5', { name: '' });
    });
    expect(sortedPairs(validateStack(candidate))).toEqual([
      ['INVALID_VALUE', '/cards/5/name'],
      ['LIMIT_EXCEEDED', '/cards'],
    ]);
  });
});

describe('array maximums: Objects per Card (100)', () => {
  const objects = (count: number): Raw[] =>
    Array.from({ length: count }, (_, index) => field(`o${index}`));

  it('accepts exactly 100 Objects', () => {
    expect(validateStack(oneCardStack({ objects: objects(100) }))).toEqual(VALID);
  });

  it('gives exactly one LIMIT_EXCEEDED at the objects array for 101 Objects', () => {
    expect(pairs(validateStack(oneCardStack({ objects: objects(101) })))).toEqual([
      ['LIMIT_EXCEEDED', '/cards/0/objects'],
    ]);
  });

  it('also reports a bad element inside an oversize objects array', () => {
    const many = objects(101);
    many[100] = field('o100', { x: 390 }); // right edge 490 is past the card width 400
    expect(sortedPairs(validateStack(oneCardStack({ objects: many })))).toEqual([
      ['LIMIT_EXCEEDED', '/cards/0/objects'],
      ['OUT_OF_BOUNDS', '/cards/0/objects/100'],
    ]);
  });
});

describe('array maximums: Links per Card (50)', () => {
  const build = (count: number, mutate?: (links: Raw[]) => void): Raw => {
    const targets = Array.from({ length: 51 }, (_, index) => card(`t${index}`));
    const links = Array.from({ length: count }, (_, index) => ({
      id: `l${index}`,
      label: 'Go',
      targetCardId: `t${index}`,
    }));
    mutate?.(links);
    return stack([card('c0', { links }), ...targets]);
  };

  it('accepts exactly 50 Links', () => {
    expect(validateStack(build(50))).toEqual(VALID);
  });

  it('gives exactly one LIMIT_EXCEEDED at the links array for 51 Links', () => {
    expect(pairs(validateStack(build(51)))).toEqual([['LIMIT_EXCEEDED', '/cards/0/links']]);
  });

  it('also reports a bad element inside an oversize links array', () => {
    const candidate = build(51, (links) => {
      links[50] = { id: 'l50', label: 'Go', targetCardId: 'gone' };
    });
    expect(sortedPairs(validateStack(candidate))).toEqual([
      ['DANGLING_REFERENCE', '/cards/0/links/50/targetCardId'],
      ['LIMIT_EXCEEDED', '/cards/0/links'],
    ]);
  });
});

describe('array maximums: List items (500)', () => {
  const build = (items: unknown[]): Raw => oneCardStack({ objects: [list('tasks', items)] });
  const items = (count: number): unknown[] => Array.from({ length: count }, () => 'x');

  it('accepts exactly 500 items', () => {
    expect(validateStack(build(items(500)))).toEqual(VALID);
  });

  it('gives exactly one LIMIT_EXCEEDED at the items array for 501 items', () => {
    expect(pairs(validateStack(build(items(501))))).toEqual([
      ['LIMIT_EXCEEDED', '/cards/0/objects/0/items'],
    ]);
  });

  it('also reports a bad element inside an oversize items array', () => {
    const many = items(501);
    many[7] = 42;
    expect(sortedPairs(validateStack(build(many)))).toEqual([
      ['LIMIT_EXCEEDED', '/cards/0/objects/0/items'],
      ['WRONG_TYPE', '/cards/0/objects/0/items/7'],
    ]);
  });
});

describe('array maximums: Handler (20 Actions)', () => {
  const button = (onClick: unknown[]): Raw => ({
    id: 'go',
    type: 'button',
    name: '',
    x: 0,
    y: 0,
    width: 60,
    height: 24,
    label: 'Go',
    onClick,
  });

  it.each([
    [
      'Button onClick',
      (handler: unknown[]) => oneCardStack({ objects: [button(handler)] }),
      '/cards/0/objects/0/onClick',
    ],
    ['Card onOpen', (handler: unknown[]) => oneCardStack({ onOpen: handler }), '/cards/0/onOpen'],
  ] as const)('%s: 20 Actions are valid and 21 give one LIMIT_EXCEEDED', (_name, build, path) => {
    expect(validateStack(build(actions(20)))).toEqual(VALID);
    expect(pairs(validateStack(build(actions(21))))).toEqual([['LIMIT_EXCEEDED', path]]);
  });

  it('also reports a bad Action inside an oversize Handler', () => {
    const handler: unknown[] = actions(21);
    handler[3] = { type: 'go_to_card', cardId: 'gone' };
    expect(sortedPairs(validateStack(oneCardStack({ onOpen: handler })))).toEqual([
      ['DANGLING_REFERENCE', '/cards/0/onOpen/3/cardId'],
      ['LIMIT_EXCEEDED', '/cards/0/onOpen'],
    ]);
  });

  it('validateHandler: 20 Actions are valid, 21 give LIMIT_EXCEEDED at the root ""', () => {
    const typed = StackSchema.parse(oneCardStack({}));
    expect(validateHandler(typed, actions(20))).toEqual(VALID);
    expect(pairs(validateHandler(typed, actions(21)))).toEqual([['LIMIT_EXCEEDED', '']]);
  });

  it('limit message names the maximum', () => {
    const typed = StackSchema.parse(oneCardStack({}));
    const error = validateHandler(typed, actions(LIMITS.handlerActions.max + 1)).errors[0];
    expect(error?.message).toContain(String(LIMITS.handlerActions.max));
  });
});
