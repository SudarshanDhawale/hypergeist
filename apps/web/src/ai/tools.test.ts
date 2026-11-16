import { describe, expect, it } from 'vitest';
import { OPERATIONS, OPERATION_NAMES, operationJsonSchema } from '@hypergeist/shared/engine';
import { z } from 'zod';
import {
  COMPACT_TOOLS_BUDGET,
  CreateStackParamsSchema,
  SayParamsSchema,
  buildToolRegistry,
  compactSchema,
  parseToolCall,
  toOpenAiTools,
  toPromptText,
} from './tools.ts';
import type { JsonObject, JsonValue } from './tools.ts';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LIMIT_KEYWORDS = [
  'pattern',
  'maxLength',
  'minLength',
  'maxItems',
  'minItems',
  'maximum',
  'minimum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'default',
  'title',
  '$schema',
];

/** Every schema node (not the property-name maps) of a JSON Schema tree. */
function schemaNodes(node: JsonValue, out: JsonObject[] = []): JsonObject[] {
  if (Array.isArray(node)) {
    for (const item of node) schemaNodes(item, out);
    return out;
  }
  if (!isObject(node)) return out;
  out.push(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' || key === '$defs') {
      if (isObject(value)) for (const sub of Object.values(value)) schemaNodes(sub, out);
    } else if (['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf'].includes(key)) {
      schemaNodes(value, out);
    }
  }
  return out;
}

/**
 * Walks the full and the compact tree together and checks that the compact one lost no
 * property, no `required` entry and no `type`, `enum` or `const`.
 */
function expectStructureKept(full: JsonValue, compact: JsonValue, path: string): void {
  if (Array.isArray(full)) {
    expect(Array.isArray(compact), path).toBe(true);
    const compactList = compact as readonly JsonValue[];
    expect(compactList.length, path).toBe(full.length);
    full.forEach((item, index) => {
      expectStructureKept(item, compactList[index] as JsonValue, `${path}/${index}`);
    });
    return;
  }
  if (!isObject(full)) return;
  expect(isObject(compact), path).toBe(true);
  const compactObject = compact as JsonObject;
  for (const keep of ['type', 'enum', 'const', 'required']) {
    if (!(keep in full)) continue;
    // A `type` next to a `const` or `enum` is a repeat, so the compact profile leaves it out.
    if (keep === 'type' && ('const' in full || 'enum' in full)) continue;
    expect(compactObject[keep], `${path}/${keep}`).toEqual(full[keep]);
  }
  for (const mapKey of ['properties', '$defs']) {
    const fullMap = full[mapKey];
    if (!isObject(fullMap)) continue;
    const compactMap = compactObject[mapKey];
    expect(isObject(compactMap), `${path}/${mapKey}`).toBe(true);
    expect(Object.keys(compactMap as JsonObject), `${path}/${mapKey}`).toEqual(
      Object.keys(fullMap),
    );
    for (const [name, sub] of Object.entries(fullMap)) {
      expectStructureKept(
        sub,
        (compactMap as JsonObject)[name] as JsonValue,
        `${path}/${mapKey}/${name}`,
      );
    }
  }
  for (const key of ['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf']) {
    if (key in full) {
      expectStructureKept(
        full[key] as JsonValue,
        compactObject[key] as JsonValue,
        `${path}/${key}`,
      );
    }
  }
}

const operationNames: readonly string[] = OPERATION_NAMES;

describe('buildToolRegistry: names', () => {
  it('has the seven Operations and say, and create_stack only for a new stack', () => {
    const without = buildToolRegistry({ newStack: false }).map((entry) => entry.name);
    expect(without).toEqual([...OPERATION_NAMES, 'say']);
    const withNew = buildToolRegistry({ newStack: true }).map((entry) => entry.name);
    expect(withNew).toEqual([...OPERATION_NAMES, 'say', 'create_stack']);
  });

  it('has no runtime Action names such as fetch_news', () => {
    const names = buildToolRegistry({ newStack: true }).map((entry) => entry.name);
    for (const action of [
      'fetch_news',
      'run_ai_field',
      'transcribe_audio',
      'schedule_notification',
    ]) {
      expect(names).not.toContain(action);
    }
  });

  it('builds twice to deeply equal values, in both profiles', () => {
    for (const profile of ['compact', 'full'] as const) {
      const a = buildToolRegistry({ newStack: true, profile });
      const b = buildToolRegistry({ newStack: true, profile });
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    }
  });
});

describe('buildToolRegistry: matches the engine', () => {
  for (const operation of OPERATIONS) {
    it(`${operation.name}: name and description equal OPERATIONS, full schema equals operationJsonSchema`, () => {
      for (const profile of ['full', 'compact'] as const) {
        const entry = buildToolRegistry({ newStack: false, profile }).find(
          (candidate) => candidate.name === operation.name,
        );
        expect(entry?.name).toBe(operation.name);
        expect(entry?.description).toBe(operation.description);
        expect(entry?.description.length).toBeGreaterThan(0);
      }
      const full = buildToolRegistry({ newStack: false, profile: 'full' }).find(
        (candidate) => candidate.name === operation.name,
      );
      expect(full?.parameters).toEqual(operationJsonSchema(operation.name));
    });
  }

  it('the compact profile is the default', () => {
    expect(buildToolRegistry({ newStack: true })).toEqual(
      buildToolRegistry({ newStack: true, profile: 'compact' }),
    );
  });
});

describe('the compact profile', () => {
  const full = buildToolRegistry({ newStack: true, profile: 'full' });
  const compact = buildToolRegistry({ newStack: true, profile: 'compact' });

  it('keeps every property name, every required list, every type, enum and const', () => {
    expect(compact.map((entry) => entry.name)).toEqual(full.map((entry) => entry.name));
    full.forEach((fullEntry, index) => {
      const compactEntry = compact[index];
      expect(compactEntry).toBeDefined();
      expectStructureKept(
        fullEntry.parameters,
        (compactEntry as { parameters: JsonObject }).parameters,
        fullEntry.name,
      );
    });
  });

  it('contains no limit keyword in any schema node', () => {
    for (const entry of compact) {
      for (const node of schemaNodes(entry.parameters)) {
        for (const keyword of LIMIT_KEYWORDS) {
          expect(Object.keys(node), `${entry.name} has ${keyword}`).not.toContain(keyword);
        }
      }
    }
  });

  it('cuts every description to at most 100 characters', () => {
    let seen = 0;
    for (const entry of compact) {
      for (const node of schemaNodes(entry.parameters)) {
        const description = node['description'];
        if (typeof description === 'string') {
          seen += 1;
          expect([...description].length).toBeLessThanOrEqual(100);
        }
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it('stays under the budget (the sizes are printed below)', () => {
    const compactSize = JSON.stringify(toOpenAiTools(compact)).length;
    const fullSize = JSON.stringify(toOpenAiTools(full)).length;
    const operationsFull = OPERATION_NAMES.reduce(
      (sum, name) => sum + JSON.stringify(operationJsonSchema(name)).length,
      0,
    );
    // The budget is a fixed constant: do not raise it, tighten `compactSchema` instead.
    expect(COMPACT_TOOLS_BUDGET).toBe(12_000);
    expect(
      compactSize,
      `compact ${compactSize}, full ${fullSize}, operation schemas ${operationsFull}`,
    ).toBeLessThan(COMPACT_TOOLS_BUDGET);
    expect(compactSize).toBeLessThan(fullSize);
  });
});

describe('compactSchema', () => {
  it('does not mutate its input and returns a new value', () => {
    const input: JsonObject = {
      $schema: 'x',
      type: 'object',
      properties: { a: { type: 'string', minLength: 1, description: 'First. Second.' } },
      required: ['a'],
      additionalProperties: false,
    };
    const copy = JSON.parse(JSON.stringify(input)) as JsonObject;
    const out = compactSchema(input);
    expect(input).toEqual(copy);
    expect(out).toEqual({
      type: 'object',
      properties: { a: { type: 'string', description: 'First.' } },
      required: ['a'],
      additionalProperties: false,
    });
  });

  it('treats a property named like a keyword as a property, not as a keyword', () => {
    const out = compactSchema({
      type: 'object',
      properties: {
        description: { type: 'string', description: 'The text.' },
        pattern: { type: 'string', minLength: 2 },
        default: { type: 'integer', maximum: 3 },
        title: { type: 'string' },
      },
      required: ['description', 'pattern'],
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        description: { type: 'string', description: 'The text.' },
        pattern: { type: 'string' },
        default: { type: 'integer' },
        title: { type: 'string' },
      },
      required: ['description', 'pattern'],
    });
  });

  it('cuts a long first sentence with an ellipsis, to at most 100 characters', () => {
    const out = compactSchema({ type: 'string', description: `${'word '.repeat(60)}end.` });
    const description = out['description'];
    expect(typeof description).toBe('string');
    expect([...(description as string)].length).toBeLessThanOrEqual(100);
    expect(description as string).toMatch(/…$/);
  });

  it('leaves out the type next to const or enum, but keeps every other type', () => {
    const out = compactSchema({
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['a', 'b'] },
        tag: { type: 'string', const: 'x' },
        plain: { type: 'string' },
      },
    });
    expect(out).toEqual({
      type: 'object',
      properties: { kind: { enum: ['a', 'b'] }, tag: { const: 'x' }, plain: { type: 'string' } },
    });
  });

  it('drops the description of integer, number and boolean properties only', () => {
    const out = compactSchema({
      type: 'object',
      properties: {
        n: { type: 'integer', description: 'A count.' },
        r: { type: 'number', description: 'A ratio.' },
        b: { type: 'boolean', description: 'A flag.' },
        s: { type: 'string', description: 'A word.' },
        a: { type: 'array', items: { type: 'string' }, description: 'A list.' },
      },
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        n: { type: 'integer' },
        r: { type: 'number' },
        b: { type: 'boolean' },
        s: { type: 'string', description: 'A word.' },
        a: { type: 'array', items: { type: 'string' }, description: 'A list.' },
      },
    });
  });

  it('keeps additionalProperties: false at the root and drops it below', () => {
    const out = compactSchema({
      type: 'object',
      properties: {
        inner: { type: 'object', properties: {}, additionalProperties: false },
        open: { type: 'object', additionalProperties: { type: 'string' } },
      },
      additionalProperties: false,
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        inner: { type: 'object', properties: {} },
        open: { type: 'object', additionalProperties: { type: 'string' } },
      },
      additionalProperties: false,
    });
  });

  it('ends a description at a colon', () => {
    const out = compactSchema({
      type: 'string',
      description: 'The id: lowercase letters and digits.',
    });
    expect(out['description']).toBe('The id.');
  });

  it('walks items, anyOf, oneOf, allOf, $defs and additionalProperties', () => {
    const out = compactSchema({
      $defs: { d: { type: 'string', maxLength: 3 } },
      anyOf: [{ type: 'string', minLength: 1 }, { $ref: '#/$defs/d' }],
      items: { type: 'integer', minimum: 0 },
      additionalProperties: { type: 'string', pattern: 'x' },
      oneOf: [{ const: 'a', description: 'One. Two.' }],
      allOf: [{ type: 'object', title: 't' }],
    });
    expect(out).toEqual({
      $defs: { d: { type: 'string' } },
      anyOf: [{ type: 'string' }, { $ref: '#/$defs/d' }],
      items: { type: 'integer' },
      additionalProperties: { type: 'string' },
      oneOf: [{ const: 'a', description: 'One.' }],
      allOf: [{ type: 'object' }],
    });
  });

  it('is deterministic', () => {
    const schema = toJsonObjectForTest(operationJsonSchema('add_object'));
    expect(compactSchema(schema)).toEqual(compactSchema(schema));
  });
});

function toJsonObjectForTest(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

describe('toOpenAiTools', () => {
  it('maps each entry to the OpenAI function shape, in order', () => {
    const registry = buildToolRegistry({ newStack: true });
    const tools = toOpenAiTools(registry);
    expect(tools).toHaveLength(registry.length);
    tools.forEach((tool, index) => {
      const entry = registry[index];
      expect(tool).toEqual({
        type: 'function',
        function: {
          name: entry?.name,
          description: entry?.description,
          parameters: entry?.parameters,
        },
      });
    });
  });
});

describe('toPromptText', () => {
  it('lists every tool with its parameter names and types, one line each', () => {
    const registry = buildToolRegistry({ newStack: true });
    const text = toPromptText(registry);
    const lines = text.split('\n');
    expect(lines).toHaveLength(registry.length);
    for (const entry of registry) {
      expect(text).toContain(`- ${entry.name}:`);
    }
    expect(text).toContain('text* (string)');
    expect(text).toContain('name* (string)');
    expect(text).toContain('cardId* (string)');
    expect(text).toContain('type* (one of "button", "field", "image", "list", "ai-field")');
  });

  it('is deterministic and small', () => {
    const registry = buildToolRegistry({ newStack: true });
    expect(toPromptText(registry)).toBe(toPromptText(registry));
    expect(toPromptText(registry).length).toBeLessThan(6000);
  });
});

describe('parseToolCall', () => {
  function errorsOf(name: string, args: string) {
    const result = parseToolCall(name, args);
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.errors;
  }

  it('accepts an Operation with an object and leaves the parameters to the engine', () => {
    const result = parseToolCall('create_card', '{"name":"Notes"}');
    expect(result).toEqual({ ok: true, name: 'create_card', params: { name: 'Notes' } });
    const odd = parseToolCall('delete_card', '{"anything":[1,2,{"x":null}]}');
    expect(odd).toEqual({
      ok: true,
      name: 'delete_card',
      params: { anything: [1, 2, { x: null }] },
    });
  });

  it('accepts say and create_stack', () => {
    expect(parseToolCall('say', '{"text":"Done."}')).toEqual({
      ok: true,
      name: 'say',
      params: { text: 'Done.' },
    });
    expect(parseToolCall('create_stack', '{"name":"Groceries"}')).toEqual({
      ok: true,
      name: 'create_stack',
      params: { name: 'Groceries' },
    });
  });

  it.each([
    'nope',
    '',
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'Say',
    'CREATE_CARD',
  ])('rejects the unknown tool name %j at /tool', (name) => {
    const errors = errorsOf(name, '{}');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('/tool');
    expect(errors[0]?.code).toBe('INVALID_VALUE');
  });

  it.each(['', 'not json', '{"name":', '{name: 1}', "{'a':1}", 'undefined'])(
    'rejects arguments that are not JSON text: %j',
    (args) => {
      const errors = errorsOf('create_card', args);
      expect(errors[0]?.path).toBe('/arguments');
      expect(errors[0]?.code).toBe('INVALID_JSON');
    },
  );

  it.each(['[]', '"x"', 'null', '5', 'true', '[{"name":"a"}]'])(
    'rejects JSON that is not an object: %s',
    (args) => {
      for (const name of ['create_card', 'say', 'create_stack']) {
        const errors = errorsOf(name, args);
        expect(errors[0]?.path).toBe('/arguments');
        expect(errors[0]?.code).toBe('WRONG_TYPE');
      }
    },
  );

  it('rejects a say call with a bad text', () => {
    expect(errorsOf('say', '{}')[0]).toMatchObject({
      code: 'MISSING_PROPERTY',
      path: '/arguments/text',
    });
    expect(errorsOf('say', '{"text":5}')[0]).toMatchObject({
      code: 'WRONG_TYPE',
      path: '/arguments/text',
    });
    expect(errorsOf('say', '{"text":""}')[0]).toMatchObject({ path: '/arguments/text' });
    expect(errorsOf('say', JSON.stringify({ text: 'x'.repeat(2001) }))[0]).toMatchObject({
      code: 'LIMIT_EXCEEDED',
      path: '/arguments/text',
    });
    expect(errorsOf('say', '{"text":"ok","extra":1}')[0]).toMatchObject({
      code: 'UNKNOWN_PROPERTY',
      path: '/arguments/extra',
    });
  });

  it('counts say text in code points: 2000 emoji pass, 2001 do not', () => {
    expect(parseToolCall('say', JSON.stringify({ text: '😀'.repeat(2000) })).ok).toBe(true);
    expect(parseToolCall('say', JSON.stringify({ text: '😀'.repeat(2001) })).ok).toBe(false);
  });

  it('rejects a create_stack call with a bad name', () => {
    expect(errorsOf('create_stack', '{}')[0]).toMatchObject({
      code: 'MISSING_PROPERTY',
      path: '/arguments/name',
    });
    expect(errorsOf('create_stack', '{"name":7}')[0]?.path).toBe('/arguments/name');
    expect(errorsOf('create_stack', '{"name":""}')[0]?.path).toBe('/arguments/name');
    const long = errorsOf('create_stack', JSON.stringify({ name: 'n'.repeat(101) }));
    expect(long[0]?.path).toBe('/arguments/name');
    expect(long[0]?.code).toBe('LIMIT_EXCEEDED');
    expect(parseToolCall('create_stack', JSON.stringify({ name: 'n'.repeat(100) })).ok).toBe(true);
    expect(errorsOf('create_stack', '{"name":"a","extra":true}')[0]).toMatchObject({
      code: 'UNKNOWN_PROPERTY',
      path: '/arguments/extra',
    });
  });

  it('never throws on hostile input, including a __proto__ key', () => {
    const inputs = [
      '{"__proto__":{"polluted":true}}',
      '{"constructor":{"prototype":1}}',
      `{"a":${'['.repeat(500)}${']'.repeat(500)}}`,
      '\u0000',
      '{"text":"\\ud800"}',
    ];
    for (const name of [...OPERATION_NAMES, 'say', 'create_stack', 'x']) {
      for (const input of inputs) {
        expect(() => parseToolCall(name, input)).not.toThrow();
      }
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('knows exactly the Operation names plus say and create_stack', () => {
    for (const name of operationNames) expect(parseToolCall(name, '{}').ok).toBe(true);
  });
});

describe('the Zod schemas of the two local tools', () => {
  it('give the full-profile parameters through z.toJSONSchema (draft 2020-12)', () => {
    const entries = buildToolRegistry({ newStack: true, profile: 'full' });
    const say = entries.find((entry) => entry.name === 'say');
    const create = entries.find((entry) => entry.name === 'create_stack');
    expect(say?.parameters).toEqual(z.toJSONSchema(SayParamsSchema));
    expect(create?.parameters).toEqual(z.toJSONSchema(CreateStackParamsSchema));
    expect(say?.parameters).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
    });
    expect(create?.parameters).toMatchObject({
      required: ['name'],
      properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
    });
  });

  it('are strict and count code points', () => {
    expect(SayParamsSchema.safeParse({ text: 'hi' }).success).toBe(true);
    expect(SayParamsSchema.safeParse({ text: 'hi', extra: 1 }).success).toBe(false);
    expect(SayParamsSchema.safeParse({ text: '😀'.repeat(2000) }).success).toBe(true);
    expect(SayParamsSchema.safeParse({ text: '😀'.repeat(2001) }).success).toBe(false);
    expect(CreateStackParamsSchema.safeParse({ name: 'Notes' }).success).toBe(true);
    expect(CreateStackParamsSchema.safeParse({ name: '' }).success).toBe(false);
  });
});
