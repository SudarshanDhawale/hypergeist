import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSchemaValidator } from '../../test-support/schema-validator.ts';
import { stackJsonSchema } from './json-schema.ts';
import { validateStack } from './validate.ts';

/**
 * Example tests for the Stack_Schema, judged by an independent JSON Schema validator (Ajv,
 * draft 2020-12). The schema covers structure only (design: "json-schema.ts"). Rules that
 * need more than one entity stay in the semantic validator, and the last block pins each of
 * them: such a stack passes the schema and fails `validateStack`.
 */

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Path = readonly (string | number)[];
type Container = Record<string, Json | undefined>;

function readJson(relativeUrl: string): Json {
  const text = readFileSync(new URL(relativeUrl, import.meta.url), 'utf8');
  return JSON.parse(text) as Json;
}

const allTypes = readJson('../../../../scripts/stack/fixtures/all-types-stack.json');
const demo = readJson('../../../../apps/web/src/stacks/thin-slice-todo.json');

/** Returns the node at `path` (arrays are indexed by their numeric string). */
function nodeAt(doc: Json, path: Path): Json {
  let node = doc;
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) {
      throw new Error(`No node at ${path.join('/')}`);
    }
    const next = (node as Container)[String(segment)];
    if (next === undefined) throw new Error(`No node at ${path.join('/')}`);
    node = next;
  }
  return node;
}

/** A deep copy of `doc` with the node at `path` replaced by `value`. */
function setAt(doc: Json, path: Path, value: Json): Json {
  const copy = structuredClone(doc);
  const parent = nodeAt(copy, path.slice(0, -1)) as Container;
  parent[String(path[path.length - 1])] = value;
  return copy;
}

/** A deep copy of `doc` without the property at `path`. */
function deleteAt(doc: Json, path: Path): Json {
  const copy = structuredClone(doc);
  const parent = nodeAt(copy, path.slice(0, -1)) as Container;
  delete parent[String(path[path.length - 1])];
  return copy;
}

/** A deep copy of `doc` where the array at `path` gets `item` appended. */
function pushAt(doc: Json, path: Path, item: Json): Json {
  const copy = structuredClone(doc);
  const array = nodeAt(copy, path);
  if (!Array.isArray(array)) throw new Error(`No array at ${path.join('/')}`);
  (array as Json[]).push(item);
  return copy;
}

/** Locations in the all-types fixture (see scripts/stack/fixtures/all-types-stack.json). */
const OBJECTS = ['cards', 0, 'objects'] as const;
const titleField = [...OBJECTS, 0] as const;
const logoImage = [...OBJECTS, 3] as const;
const summaryAiField = [...OBJECTS, 5] as const;
const goButton = [...OBJECTS, 6] as const;
const aiButton = [...OBJECTS, 7] as const;
const goActions = [...goButton, 'onClick'] as const;
const aiActions = [...aiButton, 'onClick'] as const;
const setValueLiteral = [...goActions, 1] as const;
const appendItemLiteral = [...goActions, 3] as const;
const scheduleAt = [...aiActions, 3] as const;

const validator = createSchemaValidator();
const schema = stackJsonSchema();
const check = validator.compile(schema);

function accepted(doc: Json): boolean {
  return check(doc).valid;
}

describe('stackJsonSchema checked by Ajv (draft 2020-12)', () => {
  it('is a valid draft 2020-12 schema', () => {
    expect(validator.isValidSchema(schema)).toBe(true);
  });

  it('is rejected by the meta-schema validator when it is not a schema (sanity check)', () => {
    expect(validator.isValidSchema({ type: 'not-a-type' })).toBe(false);
  });

  describe('accepts valid stacks', () => {
    it.each([
      { name: 'the demo stack', doc: demo },
      { name: 'the all-types fixture', doc: allTypes },
    ])('$name', ({ doc }) => {
      expect(check(doc)).toEqual({ valid: true });
      // The same stack is also valid for the validator, so the two agree.
      expect(validateStack(doc).valid).toBe(true);
    });

    it('counts text bounds in code points: 100 astral characters fit, 101 do not', () => {
      const fits = setAt(allTypes, ['name'], '😀'.repeat(100));
      const over = setAt(allTypes, ['name'], '😀'.repeat(101));
      expect(accepted(fits)).toBe(true);
      expect(validateStack(fits).valid).toBe(true);
      expect(accepted(over)).toBe(false);
      expect(validateStack(over).valid).toBe(false);
    });
  });

  describe('rejects structural violations', () => {
    // Each row is a structural defect. The schema must reject it, and so must the validator.
    const cases: readonly { readonly name: string; readonly doc: Json }[] = [
      // Missing required properties.
      { name: 'Stack without name', doc: deleteAt(allTypes, ['name']) },
      { name: 'Stack without cards', doc: deleteAt(allTypes, ['cards']) },
      { name: 'Card without id', doc: deleteAt(allTypes, ['cards', 0, 'id']) },
      { name: 'Card without onOpen', doc: deleteAt(allTypes, ['cards', 0, 'onOpen']) },
      { name: 'field without value', doc: deleteAt(allTypes, [...titleField, 'value']) },
      { name: 'button without label', doc: deleteAt(allTypes, [...goButton, 'label']) },
      { name: 'image without alt', doc: deleteAt(allTypes, [...logoImage, 'alt']) },
      {
        name: 'ai-field without prompt',
        doc: deleteAt(allTypes, [...summaryAiField, 'prompt']),
      },
      {
        name: 'fetch_news without topics',
        doc: deleteAt(allTypes, [...aiActions, 1, 'topics']),
      },
      // Wrong JSON types.
      { name: 'Stack name is a number', doc: setAt(allTypes, ['name'], 5) },
      { name: 'cardWidth is a string', doc: setAt(allTypes, ['cardWidth'], '512') },
      { name: 'cardWidth is not an integer', doc: setAt(allTypes, ['cardWidth'], 512.5) },
      { name: 'cards is an object', doc: setAt(allTypes, ['cards'], {}) },
      { name: 'object x is a string', doc: setAt(allTypes, [...titleField, 'x'], '8') },
      {
        name: 'field readOnly is a string',
        doc: setAt(allTypes, [...titleField, 'readOnly'], 'no'),
      },
      { name: 'button onClick is an object', doc: setAt(allTypes, [...goButton, 'onClick'], {}) },
      { name: 'list item is a number', doc: setAt(allTypes, [...OBJECTS, 2, 'items', 0], 1) },
      {
        name: 'inputObjectIds is a string',
        doc: setAt(allTypes, [...summaryAiField, 'inputObjectIds'], 'title-field'),
      },
      { name: 'the whole Stack is an array', doc: [] },
      { name: 'the whole Stack is null', doc: null },
      // Constants, patterns, and ranges the schema states.
      { name: 'formatVersion is 2', doc: setAt(allTypes, ['formatVersion'], 2) },
      { name: 'formatVersion is a string', doc: setAt(allTypes, ['formatVersion'], '1') },
      { name: 'Stack id breaks the Entity_ID pattern', doc: setAt(allTypes, ['id'], 'Bad Id') },
      { name: 'cardWidth below 64', doc: setAt(allTypes, ['cardWidth'], 63) },
      { name: 'cardWidth above 4096', doc: setAt(allTypes, ['cardWidth'], 4097) },
      { name: 'Stack name is empty', doc: setAt(allTypes, ['name'], '') },
      { name: 'cards is empty', doc: setAt(allTypes, ['cards'], []) },
      { name: 'object type is unknown', doc: setAt(allTypes, [...titleField, 'type'], 'slider') },
      {
        name: 'action type is unknown',
        doc: setAt(allTypes, [...goActions, 0, 'type'], 'teleport'),
      },
      {
        name: 'image src is http:',
        doc: setAt(allTypes, [...logoImage, 'src'], 'http://example.com/logo.png'),
      },
      {
        name: 'image src is an svg data URI',
        doc: setAt(allTypes, [...logoImage, 'src'], 'data:image/svg+xml;base64,AAAA'),
      },
      {
        name: 'schedule_notification at has a UTC offset',
        doc: setAt(allTypes, [...scheduleAt, 'at'], '2026-12-01T09:00:00+01:00'),
      },
      {
        name: 'schedule_notification at is not a timestamp',
        doc: setAt(allTypes, [...scheduleAt, 'at'], 'tomorrow'),
      },
      {
        name: 'remove_item index is negative',
        doc: setAt(allTypes, [...goActions, 5, 'index'], -1),
      },
      { name: 'fetch_news topics is empty', doc: setAt(allTypes, [...aiActions, 1, 'topics'], []) },
      {
        name: 'inputObjectIds repeats an id',
        doc: setAt(allTypes, [...summaryAiField, 'inputObjectIds'], ['title-field', 'title-field']),
      },
      {
        name: 'inputObjectIds has 11 entries',
        doc: setAt(
          allTypes,
          [...summaryAiField, 'inputObjectIds'],
          Array.from({ length: 11 }, (_, i) => `field-${i}`),
        ),
      },
      // Unknown properties.
      { name: 'Stack with an unknown property', doc: setAt(allTypes, ['extra'], true) },
      { name: 'Card with an unknown property', doc: setAt(allTypes, ['cards', 0, 'extra'], 1) },
      { name: 'field with an unknown property', doc: setAt(allTypes, [...titleField, 'extra'], 1) },
      { name: 'image with an unknown property', doc: setAt(allTypes, [...logoImage, 'extra'], 1) },
      {
        name: 'ai-field with an unknown property',
        doc: setAt(allTypes, [...summaryAiField, 'extra'], 1),
      },
      {
        name: 'Link with an unknown property',
        doc: setAt(allTypes, ['cards', 0, 'links', 0, 'extra'], 1),
      },
      {
        name: 'Action with an unknown property',
        doc: setAt(allTypes, [...goActions, 0, 'extra'], 1),
      },
      // Exactly-one-of pairs: both present.
      {
        name: 'set_value with both value and fromObjectId',
        doc: setAt(allTypes, [...setValueLiteral, 'fromObjectId'], 'notes-list'),
      },
      {
        name: 'append_item with both item and fromObjectId',
        doc: setAt(allTypes, [...appendItemLiteral, 'fromObjectId'], 'title-field'),
      },
      {
        name: 'schedule_notification with both at and atFromObjectId',
        doc: setAt(allTypes, [...scheduleAt, 'atFromObjectId'], 'when-field'),
      },
      // Exactly-one-of pairs: neither present.
      {
        name: 'set_value with neither value nor fromObjectId',
        doc: deleteAt(allTypes, [...setValueLiteral, 'value']),
      },
      {
        name: 'append_item with neither item nor fromObjectId',
        doc: deleteAt(allTypes, [...appendItemLiteral, 'item']),
      },
      {
        name: 'schedule_notification with neither at nor atFromObjectId',
        doc: deleteAt(allTypes, [...scheduleAt, 'at']),
      },
    ];

    it.each(cases)('$name', ({ doc }) => {
      const result = check(doc);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.errors.length).toBeGreaterThan(0);
      expect(validateStack(doc).valid).toBe(false);
    });
  });

  describe('deliberately does not enforce cross-entity rules (the validator does)', () => {
    /** A stack with `fields` fields on each of three cards, each field holding 10,000 characters. */
    function oversizeStack(): Json {
      const field = (id: string): Json => ({
        id,
        type: 'field',
        name: id,
        x: 0,
        y: 0,
        width: 8,
        height: 8,
        value: 'a'.repeat(10_000),
        placeholder: '',
        multiline: false,
        readOnly: false,
      });
      const card = (cardId: string): Json => ({
        id: cardId,
        name: cardId,
        objects: Array.from({ length: 100 }, (_, i) => field(`${cardId}-f${i}`)),
        links: [],
        onOpen: [],
      });
      return {
        formatVersion: 1,
        id: 'big',
        name: 'Big',
        cardWidth: 512,
        cardHeight: 342,
        startCardId: 'c0',
        cards: [card('c0'), card('c1'), card('c2')],
      };
    }

    // Each row: a stack the schema accepts although the validator rejects it, with the
    // validator's code and the pointer of the first offending location.
    const cases: readonly {
      readonly rule: string;
      readonly doc: () => Json;
      readonly code: string;
      readonly path: string;
    }[] = [
      {
        rule: 'unique Entity_IDs across cards, objects, and links',
        doc: () => setAt(allTypes, ['cards', 1, 'id'], 'home'),
        code: 'DUPLICATE_ID',
        path: '/cards/1/id',
      },
      {
        rule: 'startCardId names an existing card',
        doc: () => setAt(allTypes, ['startCardId'], 'nowhere'),
        code: 'DANGLING_REFERENCE',
        path: '/startCardId',
      },
      {
        rule: 'go_to_card names an existing card',
        doc: () => setAt(allTypes, [...goActions, 0, 'cardId'], 'nowhere'),
        code: 'DANGLING_REFERENCE',
        path: '/cards/0/objects/6/onClick/0/cardId',
      },
      {
        rule: 'a link targets an existing card',
        doc: () => setAt(allTypes, ['cards', 0, 'links', 0, 'targetCardId'], 'nowhere'),
        code: 'DANGLING_REFERENCE',
        path: '/cards/0/links/0/targetCardId',
      },
      {
        rule: 'an action target has the right object type',
        doc: () => setAt(allTypes, [...appendItemLiteral, 'targetObjectId'], 'title-field'),
        code: 'WRONG_REFERENCE_TYPE',
        path: '/cards/0/objects/6/onClick/3/targetObjectId',
      },
      {
        rule: 'an ai-field does not use itself as an input',
        doc: () => setAt(allTypes, [...summaryAiField, 'inputObjectIds'], ['summary']),
        code: 'WRONG_REFERENCE_TYPE',
        path: '/cards/0/objects/5/inputObjectIds/0',
      },
      {
        rule: 'an ai-field input is an object, not a card',
        doc: () => setAt(allTypes, [...summaryAiField, 'inputObjectIds'], ['other']),
        code: 'WRONG_REFERENCE_TYPE',
        path: '/cards/0/objects/5/inputObjectIds/0',
      },
      {
        rule: 'an object lies inside the card (x + width is at most cardWidth)',
        doc: () => setAt(allTypes, [...titleField, 'x'], 400),
        code: 'OUT_OF_BOUNDS',
        path: '/cards/0/objects/0',
      },
      {
        rule: 'a card has at most one link per target card',
        doc: () =>
          pushAt(allTypes, ['cards', 0, 'links'], {
            id: 'to-other-again',
            label: 'Other again',
            targetCardId: 'other',
          }),
        code: 'DUPLICATE_LINK',
        path: '/cards/0/links/1/targetCardId',
      },
      {
        rule: 'an https: image source has at most 2,000 characters (the schema allows 1,000,000)',
        doc: () =>
          setAt(allTypes, [...logoImage, 'src'], `https://example.com/${'a'.repeat(2000)}`),
        code: 'LIMIT_EXCEEDED',
        path: '/cards/0/objects/3/src',
      },
      {
        rule: 'the canonical text is at most 2 MiB',
        doc: oversizeStack,
        code: 'LIMIT_EXCEEDED',
        path: '',
      },
    ];

    it.each(cases)('$rule', ({ doc, code, path }) => {
      const stack = doc();
      expect(accepted(stack)).toBe(true);
      const result = validateStack(stack);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ code, path }));
    });
  });
});
