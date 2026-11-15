import { describe, expect, it } from 'vitest';
import { parseStack } from './parse.ts';
import { validateStack } from './validate.ts';
import type { ValidationError } from './errors.ts';

/*
 * One end-to-end example per rule that the image and ai-field Objects and the five newer
 * Actions add. Each case goes through `validateStack` and `parseStack`, and asserts the
 * error code and the JSON Pointer path.
 */

type Raw = Record<string, unknown>;

const field = (id: string, extra: Raw = {}): Raw => ({
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
  ...extra,
});

const list = (id: string, extra: Raw = {}): Raw => ({
  id,
  type: 'list',
  name: '',
  x: 0,
  y: 30,
  width: 100,
  height: 100,
  items: [],
  ordered: false,
  ...extra,
});

const image = (id: string, extra: Raw = {}): Raw => ({
  id,
  type: 'image',
  name: '',
  x: 120,
  y: 0,
  width: 50,
  height: 50,
  src: 'https://example.com/a.png',
  alt: '',
  ...extra,
});

const aiField = (id: string, inputObjectIds: unknown[] = [], extra: Raw = {}): Raw => ({
  id,
  type: 'ai-field',
  name: '',
  x: 0,
  y: 150,
  width: 100,
  height: 40,
  prompt: 'Summarize',
  inputObjectIds,
  value: '',
  ...extra,
});

const button = (id: string, onClick: unknown[], extra: Raw = {}): Raw => ({
  id,
  type: 'button',
  name: '',
  x: 0,
  y: 200,
  width: 60,
  height: 20,
  label: 'Go',
  onClick,
  ...extra,
});

const card = (id: string, objects: Raw[], extra: Raw = {}): Raw => ({
  id,
  name: id,
  objects,
  links: [],
  onOpen: [],
  ...extra,
});

const stack = (cards: Raw[]): Raw => ({
  formatVersion: 1,
  id: 'demo',
  name: 'Demo',
  cardWidth: 400,
  cardHeight: 400,
  startCardId: 'c1',
  cards,
});

/**
 * Card `c1` holds field `f`, list `l`, image `img`, ai-field `ai1`, button `btn` (index 4)
 * and link `lnk`. Card `c2` holds field `f2`. `extra` objects come after the button.
 */
function fixture(extraObjects: Raw[] = [], btn: Raw = button('btn', [])): Raw {
  return stack([
    card('c1', [field('f'), list('l'), image('img'), aiField('ai1'), btn, ...extraObjects], {
      links: [{ id: 'lnk', label: 'Next', targetCardId: 'c2' }],
    }),
    card('c2', [field('f2')]),
  ]);
}

/** A stack whose button `btn` holds the given Action. The Action path is `ACTION`. */
function withAction(action: Raw): Raw {
  return fixture([], button('btn', [action]));
}

const ACTION = '/cards/0/objects/4/onClick/0';
/** Index of the first of `extraObjects` in `fixture`. */
const EXTRA = 5;

/** `CODE pointer` for every error. */
function summary(errors: readonly ValidationError[]): string[] {
  return errors.map((error) => `${error.code} ${error.path}`);
}

/**
 * Validates through both entry points and checks they agree, then returns the errors.
 * An empty list means both accepted the candidate.
 */
function run(candidate: unknown): ValidationError[] {
  const validated = validateStack(candidate);
  const parsed = parseStack(candidate);
  expect(parsed.ok).toBe(validated.valid);
  if (!parsed.ok) expect(parsed.errors).toEqual(validated.errors);
  expect(validated.truncated).toBe(false);
  return [...validated.errors];
}

describe('the fixture', () => {
  it('is valid', () => {
    expect(run(fixture())).toEqual([]);
  });
});

describe('ai-field inputObjectIds (Requirements 4.7, 4.8)', () => {
  const AI = `/cards/0/objects/${EXTRA}`;
  const withInputs = (inputs: unknown[]): Raw => fixture([aiField('ai2', inputs)]);

  it('accepts a field, a list, and another ai-field on the same card', () => {
    expect(run(withInputs(['f', 'l', 'ai1']))).toEqual([]);
  });

  it('rejects an input on another card with WRONG_REFERENCE_TYPE', () => {
    expect(summary(run(withInputs(['f2'])))).toEqual([
      `WRONG_REFERENCE_TYPE ${AI}/inputObjectIds/0`,
    ]);
  });

  it.each([
    ['a button', 'btn'],
    ['an image', 'img'],
    ['the ai-field itself', 'ai2'],
    ['a card', 'c2'],
    ['a link', 'lnk'],
  ])('rejects %s as an input with WRONG_REFERENCE_TYPE', (_label, id) => {
    expect(summary(run(withInputs(['f', id])))).toEqual([
      `WRONG_REFERENCE_TYPE ${AI}/inputObjectIds/1`,
    ]);
  });

  it('rejects an id that does not exist with DANGLING_REFERENCE', () => {
    expect(summary(run(withInputs(['missing'])))).toEqual([
      `DANGLING_REFERENCE ${AI}/inputObjectIds/0`,
    ]);
  });

  it('rejects a repeated input at the later entry with INVALID_VALUE', () => {
    expect(summary(run(withInputs(['f', 'l', 'f'])))).toEqual([
      `INVALID_VALUE ${AI}/inputObjectIds/2`,
    ]);
  });

  it('names the ai-field id in every input error message', () => {
    const cases: unknown[][] = [['f2'], ['btn'], ['img'], ['ai2'], ['c2'], ['lnk'], ['missing']];
    for (const inputs of cases) {
      const errors = run(withInputs(inputs));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('"ai2"');
    }
    const repeated = run(withInputs(['f', 'f']));
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.message).toContain('"ai2"');
  });
});

describe('image src (Requirements 4.4, 4.8, 4.9)', () => {
  const SRC = `/cards/0/objects/${EXTRA}/src`;
  const withSrc = (src: unknown): Raw => fixture([image('img2', { y: 60, src })]);
  const httpsOfLength = (length: number): string => `https://${'a'.repeat(length - 8)}`;

  it('accepts an https: source of exactly 2,000 characters', () => {
    expect(run(withSrc(httpsOfLength(2000)))).toEqual([]);
  });

  it('rejects an https: source of 2,001 characters with LIMIT_EXCEEDED', () => {
    expect(summary(run(withSrc(httpsOfLength(2001))))).toEqual([`LIMIT_EXCEEDED ${SRC}`]);
  });

  it.each([
    ['http:', 'http://example.com/a.png'],
    ['javascript:', 'javascript:alert(1)'],
    ['an svg data URI', 'data:image/svg+xml;base64,AAAA'],
  ])('rejects %s with INVALID_VALUE', (_label, src) => {
    expect(summary(run(withSrc(src)))).toEqual([`INVALID_VALUE ${SRC}`]);
  });

  it('names the Image id in every src error message', () => {
    for (const src of ['http://example.com/a.png', 'javascript:alert(1)', httpsOfLength(2001)]) {
      const errors = run(withSrc(src));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('"img2"');
    }
  });
});

describe('image and ai-field property errors name the Object id (Requirement 4.8)', () => {
  const OBJ = `/cards/0/objects/${EXTRA}`;
  const without = (object: Raw, key: string): Raw =>
    Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

  it.each([
    ['image without src', without(image('x1', { y: 60 }), 'src'), 'MISSING_PROPERTY', OBJ],
    ['image with a number alt', image('x1', { y: 60, alt: 5 }), 'WRONG_TYPE', `${OBJ}/alt`],
    [
      'image with a 201-character alt',
      image('x1', { y: 60, alt: 'a'.repeat(201) }),
      'LIMIT_EXCEEDED',
      `${OBJ}/alt`,
    ],
    ['ai-field without prompt', without(aiField('x1'), 'prompt'), 'MISSING_PROPERTY', OBJ],
    [
      'ai-field with an empty prompt',
      aiField('x1', [], { prompt: '' }),
      'INVALID_VALUE',
      `${OBJ}/prompt`,
    ],
    [
      'ai-field with a 2,001-character prompt',
      aiField('x1', [], { prompt: 'a'.repeat(2001) }),
      'LIMIT_EXCEEDED',
      `${OBJ}/prompt`,
    ],
    [
      'ai-field with 11 inputs',
      aiField('x1', ['f', 'l', 'ai1', 'f', 'l', 'ai1', 'f', 'l', 'ai1', 'f', 'l']),
      'LIMIT_EXCEEDED',
      `${OBJ}/inputObjectIds`,
    ],
  ])('%s', (_label, object, code, path) => {
    const errors = run(fixture([object]));
    expect(errors.map((error) => `${error.code} ${error.path}`)).toContain(`${code} ${path}`);
    const own = errors.find((error) => error.code === code && error.path === path);
    expect(own?.message).toContain('"x1"');
  });
});

describe('schedule_notification at (Requirement 6.11)', () => {
  const AT = `${ACTION}/at`;
  const notify = (at: unknown): Raw =>
    withAction({ type: 'schedule_notification', message: 'Wake up', at });

  it('accepts a UTC timestamp with seconds and a Z', () => {
    expect(run(notify('2027-01-01T09:00:00Z'))).toEqual([]);
    expect(run(notify('2028-02-29T00:00:00.123Z'))).toEqual([]);
  });

  it.each([
    ['an offset', '2027-01-01T09:00:00+02:00'],
    ['no seconds', '2027-01-01T09:00Z'],
    ['a lowercase z', '2027-01-01T09:00:00z'],
    ['a date that does not exist', '2027-02-29T00:00:00Z'],
  ])('rejects %s with INVALID_VALUE', (_label, at) => {
    expect(summary(run(notify(at)))).toEqual([`INVALID_VALUE ${AT}`]);
  });
});

describe('remove_item index (Requirement 6.6)', () => {
  const remove = (index: unknown): Raw =>
    withAction({ type: 'remove_item', targetObjectId: 'l', index });

  it('accepts an index of 0', () => {
    expect(run(remove(0))).toEqual([]);
  });

  it.each([
    ['-1', -1],
    ['1.5', 1.5],
  ])('rejects an index of %s with INVALID_VALUE', (_label, index) => {
    expect(summary(run(remove(index)))).toEqual([`INVALID_VALUE ${ACTION}/index`]);
  });
});

describe('fetch_news topics (Requirement 6.9)', () => {
  const news = (count: number): Raw =>
    withAction({
      type: 'fetch_news',
      targetObjectId: 'l',
      topics: Array.from({ length: count }, (_, i) => `topic ${i}`),
    });

  it('accepts 1 and 10 topics', () => {
    expect(run(news(1))).toEqual([]);
    expect(run(news(10))).toEqual([]);
  });

  it('rejects 0 topics with INVALID_VALUE', () => {
    expect(summary(run(news(0)))).toEqual([`INVALID_VALUE ${ACTION}/topics`]);
  });

  it('rejects 11 topics with LIMIT_EXCEEDED', () => {
    expect(summary(run(news(11)))).toEqual([`LIMIT_EXCEEDED ${ACTION}/topics`]);
  });
});

describe('exactly-one-of pairs (Requirements 6.4, 6.5, 6.11)', () => {
  it.each([
    ['set_value', { targetObjectId: 'f' }, 'value', 'x', 'fromObjectId', 'f2'],
    ['append_item', { targetObjectId: 'l' }, 'item', 'x', 'fromObjectId', 'f'],
    [
      'schedule_notification',
      { message: 'Wake up' },
      'at',
      '2027-01-01T09:00:00Z',
      'atFromObjectId',
      'f',
    ],
  ])('%s', (type, base, first, firstValue, second, secondValue) => {
    const make = (extra: Raw): Raw => withAction({ type, ...base, ...extra });

    expect(run(make({ [first]: firstValue }))).toEqual([]);
    expect(run(make({ [second]: secondValue }))).toEqual([]);
    expect(summary(run(make({ [first]: firstValue, [second]: secondValue })))).toEqual([
      `INVALID_VALUE ${ACTION}`,
    ]);
    expect(summary(run(make({})))).toEqual([`INVALID_VALUE ${ACTION}`]);
  });
});

describe('references of the new Actions (Requirements 6.4 to 6.10)', () => {
  it('accepts every new Action with valid references', () => {
    const actions: Raw[] = [
      { type: 'remove_item', targetObjectId: 'l', index: 0 },
      { type: 'show_message', text: 'Hello' },
      { type: 'run_ai_field', targetObjectId: 'ai1' },
      { type: 'fetch_news', targetObjectId: 'l', topics: ['tech'] },
      { type: 'transcribe_audio', targetObjectId: 'f' },
      { type: 'schedule_notification', message: 'Hi', atFromObjectId: 'f' },
    ];
    expect(run(fixture([], button('btn', actions)))).toEqual([]);
  });

  it.each([
    ['remove_item', { targetObjectId: 'f', index: 0 }, 'targetObjectId'],
    ['run_ai_field', { targetObjectId: 'f' }, 'targetObjectId'],
    ['fetch_news', { targetObjectId: 'f', topics: ['tech'] }, 'targetObjectId'],
    ['transcribe_audio', { targetObjectId: 'l' }, 'targetObjectId'],
    ['schedule_notification', { message: 'Hi', atFromObjectId: 'l' }, 'atFromObjectId'],
  ])('%s rejects an Object of the wrong type with WRONG_REFERENCE_TYPE', (type, rest, key) => {
    expect(summary(run(withAction({ type, ...rest })))).toEqual([
      `WRONG_REFERENCE_TYPE ${ACTION}/${key}`,
    ]);
  });

  it.each([
    ['remove_item', { targetObjectId: 'nope', index: 0 }, 'targetObjectId'],
    ['run_ai_field', { targetObjectId: 'nope' }, 'targetObjectId'],
    ['fetch_news', { targetObjectId: 'nope', topics: ['tech'] }, 'targetObjectId'],
    ['transcribe_audio', { targetObjectId: 'nope' }, 'targetObjectId'],
    ['schedule_notification', { message: 'Hi', atFromObjectId: 'nope' }, 'atFromObjectId'],
  ])('%s rejects a missing id with DANGLING_REFERENCE', (type, rest, key) => {
    expect(summary(run(withAction({ type, ...rest })))).toEqual([
      `DANGLING_REFERENCE ${ACTION}/${key}`,
    ]);
  });
});
