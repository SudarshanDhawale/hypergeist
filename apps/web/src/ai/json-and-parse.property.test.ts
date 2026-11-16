import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertProperty } from '../../../../packages/shared/test-support/seed.ts';
import { extractJson, parseJsonReply } from './json-mode.ts';
import { buildToolRegistry, parseToolCall } from './tools.ts';

/* ------------------------------------------------------------------------------------------ */
/* Shared arbitraries                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** A JSON object whose value survives `JSON.stringify` then `JSON.parse` unchanged. */
const arbJsonObject: fc.Arbitrary<Record<string, unknown>> = fc
  .dictionary(fc.string({ maxLength: 12 }), fc.jsonValue(), { maxKeys: 6 })
  .map((object) => JSON.parse(JSON.stringify(object)) as Record<string, unknown>);

/** Prose around the JSON. It has no `{`, so the scan cannot start in the wrong place. */
const arbProse: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ maxLength: 120 }),
    fc.string({ unit: 'grapheme', maxLength: 60 }),
    fc.constantFrom('', ' ', '\n', 'Here is the plan:\n', '\nHope that helps.', 'Sure!'),
  )
  .filter((text) => !text.includes('{'));

type Wrapping = 'none' | 'fence' | 'fence-json';

const arbWrapping: fc.Arbitrary<Wrapping> = fc.constantFrom('none', 'fence', 'fence-json');

function wrap(body: string, wrapping: Wrapping): string {
  switch (wrapping) {
    case 'none':
      return body;
    case 'fence':
      return `\`\`\`\n${body}\n\`\`\``;
    case 'fence-json':
      return `\`\`\`json\n${body}\n\`\`\``;
  }
}

/** Arbitrary strings, including lone surrogates, braces, quotes, fences and long repetitions. */
const arbHostileText: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 200 }),
  fc.string({ unit: 'grapheme', maxLength: 100 }),
  fc.string({ unit: 'binary-ascii', maxLength: 200 }),
  fc
    .tuple(
      fc.constantFrom(
        '{',
        '}',
        '{"',
        '"\\',
        '\\',
        '```',
        '```json\n',
        '{}',
        '{a}',
        '{"a":',
        '\ud800',
      ),
      fc.integer({ min: 1, max: 50_000 }),
    )
    .map(([piece, count]) => piece.repeat(Math.ceil(Math.min(count, 50_000) / piece.length))),
  fc
    .tuple(fc.string({ maxLength: 50 }), fc.integer({ min: 100, max: 50_000 }))
    .map(([piece, length]) =>
      piece.length === 0 ? 'x'.repeat(length) : piece.repeat(Math.ceil(length / piece.length)),
    ),
);

/* ------------------------------------------------------------------------------------------ */
/* Property 5                                                                                  */
/* ------------------------------------------------------------------------------------------ */

describe('JSON extraction (property)', () => {
  it('Feature: ai-orchestrator, Property 5: JSON extraction is robust (wrapped objects)', () => {
    // **Validates: Requirements 8.2**
    assertProperty(
      fc.property(
        arbJsonObject,
        arbWrapping,
        arbProse,
        arbProse,
        (object, wrapping, before, after) => {
          const text = `${before}${wrap(JSON.stringify(object), wrapping)}${after}`;
          const result = extractJson(text);
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.value).toEqual(object);
        },
      ),
      { numRuns: 200 },
    );
  }, 60_000);

  it('Feature: ai-orchestrator, Property 5: JSON extraction is robust (arbitrary strings)', () => {
    // **Validates: Requirements 8.2**
    assertProperty(
      fc.property(arbHostileText, (text) => {
        const extracted = extractJson(text);
        expect(typeof extracted.ok).toBe('boolean');
        if (!extracted.ok) expect(extracted.errors.length).toBeGreaterThan(0);

        const parsed = parseJsonReply(text);
        expect(typeof parsed.ok).toBe('boolean');
        if (!parsed.ok) expect(parsed.errors.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});

/* ------------------------------------------------------------------------------------------ */
/* Property 6                                                                                  */
/* ------------------------------------------------------------------------------------------ */

const REGISTRY = buildToolRegistry({ newStack: true });
const REGISTRY_NAMES: readonly string[] = REGISTRY.map((entry) => entry.name);
const OPERATION_TOOL_NAMES: readonly string[] = REGISTRY_NAMES.filter(
  (name) => name !== 'say' && name !== 'create_stack',
);
const HOSTILE_NAMES: readonly string[] = [
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'prototype',
  '',
  ' say',
  'SAY',
  'say ',
];

const arbToolName: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.constantFrom(...REGISTRY_NAMES),
  fc.constantFrom(...HOSTILE_NAMES),
);

const arbArguments: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.string({ unit: 'binary', maxLength: 200 }),
  fc.jsonValue().map((value) => JSON.stringify(value)),
  fc.constant(''),
  fc.constantFrom('null', '[]', '{}', '"text"', '0', 'true', '{"text":"hi"}', '{"name":"Notes"}'),
);

describe('parseToolCall (property)', () => {
  it('Feature: ai-orchestrator, Property 6: Tool parsing is total (arbitrary input)', () => {
    // **Validates: Requirements 6.8, 13.1**
    assertProperty(
      fc.property(arbToolName, arbArguments, (name, rawArguments) => {
        const result = parseToolCall(name, rawArguments);
        expect(typeof result.ok).toBe('boolean');
        if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
        if (!REGISTRY_NAMES.includes(name)) expect(result.ok).toBe(false);
      }),
      { numRuns: 300 },
    );
  }, 60_000);

  it('Feature: ai-orchestrator, Property 6: Tool parsing is total (unknown names never succeed)', () => {
    // **Validates: Requirements 6.8, 13.1**
    const arbUnknownName = arbToolName.filter((name) => !REGISTRY_NAMES.includes(name));
    assertProperty(
      fc.property(arbUnknownName, arbJsonObject, (name, object) => {
        const result = parseToolCall(name, JSON.stringify(object));
        expect(result.ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  }, 60_000);

  it('Feature: ai-orchestrator, Property 6: Tool parsing is total (operations with object JSON)', () => {
    // **Validates: Requirements 6.8, 13.1**
    assertProperty(
      fc.property(fc.constantFrom(...OPERATION_TOOL_NAMES), arbJsonObject, (name, object) => {
        const result = parseToolCall(name, JSON.stringify(object));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.name).toBe(name);
      }),
      { numRuns: 200 },
    );
  }, 60_000);
});
