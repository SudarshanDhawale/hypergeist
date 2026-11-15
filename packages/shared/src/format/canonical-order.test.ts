import { describe, expect, it } from 'vitest';
import {
  ACTION_KEY_ORDER,
  ENTITY_KEY_ORDER,
  canonicalKeyViolations,
} from '../../test-support/oracles.ts';
import { ACTION_TYPES, OBJECT_TYPES } from './limits.ts';
import { parseStack } from './parse.ts';
import { serializeStack } from './serialize.ts';

// Golden test of Canonical_JSON key order (Requirement 9.5). The expected orders are written
// out below as literal lists from the design's "Canonical key order" table and Action table,
// and the independent oracle in test-support/oracles.ts checks the same table. Canonical
// order is the declaration order of the Zod shapes, so this test fails if Zod's output order
// or a schema's property order changes.
//
// Where the requirements list `fetch_news` as `topics` then `targetObjectId`, the design puts
// `targetObjectId` first for every Action that has one, and this test follows the design.

type Raw = Record<string, unknown>;

const COMMON = ['id', 'type', 'name', 'x', 'y', 'width', 'height'];

/** Every key list that the full stack below must produce, per entity label (design table). */
const EXPECTED_ENTITY_KEYS: Record<string, readonly string[][]> = {
  stack: [
    [
      'formatVersion',
      'id',
      'name',
      'cardWidth',
      'cardHeight',
      'startCardId',
      'remixedFrom',
      'cards',
    ],
  ],
  card: [['id', 'name', 'objects', 'links', 'onOpen']],
  link: [['id', 'label', 'targetCardId']],
  button: [[...COMMON, 'label', 'onClick']],
  field: [[...COMMON, 'value', 'placeholder', 'multiline', 'readOnly']],
  image: [[...COMMON, 'src', 'alt']],
  list: [[...COMMON, 'items', 'ordered']],
  'ai-field': [[...COMMON, 'prompt', 'inputObjectIds', 'value']],
};

/** Every key list that each Action variant in the stack below must produce (design table). */
const EXPECTED_ACTION_KEYS: Record<string, readonly string[][]> = {
  go_to_card: [['type', 'cardId']],
  set_value: [
    ['type', 'targetObjectId', 'value'],
    ['type', 'targetObjectId', 'fromObjectId'],
  ],
  append_item: [
    ['type', 'targetObjectId', 'item'],
    ['type', 'targetObjectId', 'fromObjectId'],
  ],
  remove_item: [['type', 'targetObjectId', 'index']],
  show_message: [['type', 'text']],
  run_ai_field: [['type', 'targetObjectId']],
  fetch_news: [['type', 'targetObjectId', 'topics']],
  transcribe_audio: [['type', 'targetObjectId']],
  schedule_notification: [
    ['type', 'message', 'at'],
    ['type', 'message', 'atFromObjectId'],
  ],
};

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copies a value and writes every object's keys in reverse order (arrays keep their order). */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }
  if (isRecord(value)) {
    const copy: Raw = {};
    for (const key of Object.keys(value).reverse()) {
      copy[key] = reverseKeys(value[key]);
    }
    return copy;
  }
  return value;
}

function common(id: string, type: string, y: number): Raw {
  return { id, type, name: id, x: 10, y, width: 100, height: 20 };
}

function fullStack(): Raw {
  return {
    formatVersion: 1,
    id: 'demo',
    name: 'Demo',
    cardWidth: 400,
    cardHeight: 300,
    startCardId: 'c1',
    remixedFrom: 'original',
    cards: [
      {
        id: 'c1',
        name: 'First',
        objects: [
          {
            ...common('btn', 'button', 0),
            label: 'Go',
            onClick: [
              { type: 'go_to_card', cardId: 'c2' },
              { type: 'set_value', targetObjectId: 'fld', value: 'hello' },
              { type: 'set_value', targetObjectId: 'fld', fromObjectId: 'fld2' },
              { type: 'append_item', targetObjectId: 'lst', item: 'milk' },
              { type: 'append_item', targetObjectId: 'lst', fromObjectId: 'fld' },
              { type: 'remove_item', targetObjectId: 'lst', index: 0 },
              { type: 'show_message', text: 'Done' },
              { type: 'run_ai_field', targetObjectId: 'ai' },
              { type: 'fetch_news', targetObjectId: 'lst', topics: ['science', 'sport'] },
              { type: 'transcribe_audio', targetObjectId: 'fld' },
              { type: 'schedule_notification', message: 'Call', at: '2026-12-01T09:00:00Z' },
              { type: 'schedule_notification', message: 'Call', atFromObjectId: 'fld' },
            ],
          },
          {
            ...common('fld', 'field', 30),
            value: 'a',
            placeholder: 'p',
            multiline: true,
            readOnly: false,
          },
          {
            ...common('fld2', 'field', 60),
            value: '',
            placeholder: '',
            multiline: false,
            readOnly: true,
          },
          { ...common('lst', 'list', 90), items: ['x', 'y'], ordered: true },
          { ...common('img', 'image', 120), src: 'https://example.com/a.png', alt: 'An image' },
          {
            ...common('ai', 'ai-field', 150),
            prompt: 'Summarise',
            inputObjectIds: ['fld', 'lst'],
            value: '',
          },
        ],
        links: [{ id: 'lnk', label: 'Next', targetCardId: 'c2' }],
        onOpen: [{ type: 'show_message', text: 'Welcome' }],
      },
      { id: 'c2', name: 'Second', objects: [], links: [], onOpen: [] },
    ],
  };
}

function serialized(candidate: unknown): { text: string; parsed: Raw } {
  const result = serializeStack(candidate);
  if (!result.ok) {
    throw new Error(`serializeStack failed: ${JSON.stringify(result.errors)}`);
  }
  const parsed: unknown = JSON.parse(result.value);
  if (!isRecord(parsed)) {
    throw new Error('Canonical_JSON is not an object');
  }
  return { text: result.value, parsed };
}

/** Collects the key list of every object, keyed by entity label, in document order. */
function collectKeyLists(stack: Raw): {
  entities: Map<string, string[][]>;
  actions: Map<string, string[][]>;
} {
  const entities = new Map<string, string[][]>();
  const actions = new Map<string, string[][]>();
  const add = (map: Map<string, string[][]>, label: string, value: Raw): void => {
    map.set(label, [...(map.get(label) ?? []), Object.keys(value)]);
  };
  const handler = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const action of value) {
      if (isRecord(action) && typeof action['type'] === 'string') {
        add(actions, action['type'], action);
      }
    }
  };

  add(entities, 'stack', stack);
  const cards = stack['cards'];
  if (!Array.isArray(cards)) return { entities, actions };
  for (const card of cards) {
    if (!isRecord(card)) continue;
    add(entities, 'card', card);
    handler(card['onOpen']);
    const links = card['links'];
    if (Array.isArray(links)) {
      for (const link of links) {
        if (isRecord(link)) add(entities, 'link', link);
      }
    }
    const objects = card['objects'];
    if (Array.isArray(objects)) {
      for (const object of objects) {
        if (isRecord(object) && typeof object['type'] === 'string') {
          add(entities, object['type'], object);
          handler(object['onClick']);
        }
      }
    }
  }
  return { entities, actions };
}

/** Distinct key lists, in order of first appearance. */
function distinct(lists: readonly string[][] | undefined): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const list of lists ?? []) {
    const signature = list.join('\u0000');
    if (!seen.has(signature)) {
      seen.add(signature);
      out.push(list);
    }
  }
  return out;
}

describe('canonical key order: golden table', () => {
  const scrambled = reverseKeys(fullStack());

  it('feeds the serializer keys in reverse of canonical order', () => {
    // Guards the test itself: the input is not already canonical, and the oracle sees that.
    expect(Object.keys(scrambled as Raw)[0]).toBe('cards');
    expect(canonicalKeyViolations(scrambled).length).toBeGreaterThan(0);
  });

  it('covers every Object type and every Action type', () => {
    const { entities, actions } = collectKeyLists(serialized(scrambled).parsed);
    for (const type of OBJECT_TYPES) {
      expect(entities.has(type), `object type ${type}`).toBe(true);
    }
    for (const type of ACTION_TYPES) {
      expect(actions.has(type), `action type ${type}`).toBe(true);
    }
  });

  it('writes the keys of Stack, Card, Link, and every Object type in table order', () => {
    const { entities } = collectKeyLists(serialized(scrambled).parsed);
    for (const [label, expected] of Object.entries(EXPECTED_ENTITY_KEYS)) {
      expect(distinct(entities.get(label)), label).toEqual(expected);
    }
    expect([...entities.keys()].sort()).toEqual(Object.keys(EXPECTED_ENTITY_KEYS).sort());
  });

  it('writes the keys of every Action type in table order', () => {
    const { actions } = collectKeyLists(serialized(scrambled).parsed);
    for (const [label, expected] of Object.entries(EXPECTED_ACTION_KEYS)) {
      expect(distinct(actions.get(label)), label).toEqual(expected);
    }
    expect([...actions.keys()].sort()).toEqual(Object.keys(EXPECTED_ACTION_KEYS).sort());
  });

  it('agrees with the oracle tables and reports no violation', () => {
    const { parsed } = serialized(scrambled);
    expect(canonicalKeyViolations(parsed)).toEqual([]);
    expect(Object.keys(ENTITY_KEY_ORDER).sort()).toEqual(Object.keys(EXPECTED_ENTITY_KEYS).sort());
    expect(Object.keys(ACTION_KEY_ORDER).sort()).toEqual(Object.keys(EXPECTED_ACTION_KEYS).sort());
    for (const [label, expected] of Object.entries(EXPECTED_ENTITY_KEYS)) {
      expect(expected[0]).toEqual([...ENTITY_KEY_ORDER[label as keyof typeof ENTITY_KEY_ORDER]]);
    }
  });

  it('puts targetObjectId before topics in fetch_news (the design wins over the requirement wording)', () => {
    const { actions } = collectKeyLists(serialized(scrambled).parsed);
    expect(actions.get('fetch_news')).toEqual([['type', 'targetObjectId', 'topics']]);
  });

  it('writes the same key order in the text itself, not only in the parsed value', () => {
    const { text } = serialized(scrambled);
    const firstKeys = [...text.matchAll(/^ {2}"(\w+)":/gm)].map((match) => match[1]);
    expect(firstKeys).toEqual(EXPECTED_ENTITY_KEYS['stack']?.[0]);
  });

  it('gives the same text whatever the input key order, and the text parses back', () => {
    const forward = serialized(fullStack());
    expect(serialized(scrambled).text).toBe(forward.text);
    const reparsed = parseStack(forward.text);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(serializeStack(reparsed.value)).toEqual({ ok: true, value: forward.text });
    }
  });

  it('omits remixedFrom when absent and keeps the other Stack keys in order', () => {
    const candidate = fullStack();
    delete candidate['remixedFrom'];
    const { parsed } = serialized(reverseKeys(candidate));
    expect(Object.keys(parsed)).toEqual([
      'formatVersion',
      'id',
      'name',
      'cardWidth',
      'cardHeight',
      'startCardId',
      'cards',
    ]);
    expect(canonicalKeyViolations(parsed)).toEqual([]);
  });
});
