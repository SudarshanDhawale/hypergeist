import { applyOperation } from '@hypergeist/shared/engine';
import type { Stack } from '@hypergeist/shared/format';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbStack } from '../../../../packages/shared/test-support/arbitraries.ts';
import {
  arbOperationTemplate,
  resolveOperation,
} from '../../../../packages/shared/test-support/operation-arbitraries.ts';
import type { OperationTemplate } from '../../../../packages/shared/test-support/operation-arbitraries.ts';
import {
  SEED_VARIABLE,
  assertProperty,
  getTestSeed,
  propertyParams,
} from '../../../../packages/shared/test-support/seed.ts';
import { detectCapabilities } from './capabilities.ts';
import { createDirectProvider } from './direct-provider.ts';
import { PROVIDER_ERROR_CODES, errorFromHttp, errorFromProxy, errorFromThrown } from './errors.ts';
import { startNewStack } from './new-stack.ts';
import { createKeyHolder } from './settings.ts';
import { runTurn } from './turn.ts';
import type { TurnResult } from './turn.ts';
import type { ChatRequest } from './types.ts';

/*
 * Feature: ai-orchestrator, Property 4: The key never leaks.
 *
 * A random key is held by a key holder. The real direct provider talks to a fake `fetch` that
 * records every call and replays scripted OpenAI-shaped replies: tool calls built from
 * operations against a mirror of the stack (as in `turn.property.test.ts`), rejected calls,
 * HTTP errors whose bodies echo the key, thrown errors whose message carries the key, and
 * malformed bodies that carry the key.
 *
 * What the app controls is checked in every case: the key appears only in the `authorization`
 * header of each fetch call (not in the URL, not in another header, not in the body), the
 * provider, the Turn and the mappers never return it. What a model writes is not under the
 * app's control, so the replies of one test never contain the key, and the replies of the
 * other test echo the key in `say` text, content and unused fields. For that test only what
 * the app itself produces is checked (errors, step descriptions, repair and result messages).
 */

/* ---------- helpers: async property, report ---------- */

/*
 * `assertProperty` in the shared test support is synchronous and a Turn is asynchronous, so this
 * file has a thin async twin that uses the same seed and parameter helpers and prints the same
 * seed on failure (same pattern as `persistence/repository.property.test.ts`).
 */
async function assertAsyncProperty<T>(
  property: fc.IAsyncProperty<T>,
  overrides?: Partial<fc.Parameters<T>>,
): Promise<void> {
  try {
    await fc.assert(property, propertyParams<T>(overrides));
  } catch (error: unknown) {
    const seed = getTestSeed();
    process.stderr.write(`Property failed with ${SEED_VARIABLE}=${seed}\n`);
    process.stderr.write(
      `Replay with: ${SEED_VARIABLE}=${seed} pnpm exec vitest run apps/web/src/ai/key-leak.property.test.ts\n`,
    );
    throw error;
  }
}

/** Explicit test timeout. A parallel full-suite run is slower than a single file run. */
const TEST_TIMEOUT_MS = 60_000;

const BASE_URL = 'https://api.example.test/v1';
const BASE_ORIGIN = 'https://api.example.test';
const MODEL = 'test-model';

/* ---------- arbitraries: the key and small helpers ---------- */

const ALPHANUMERIC = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'];

/** `sk-test-` and 16 to 48 letters or digits. */
const arbKey: fc.Arbitrary<string> = fc
  .string({ unit: fc.constantFrom(...ALPHANUMERIC), minLength: 16, maxLength: 48 })
  .map((tail) => `sk-test-${tail}`);

const arbFraction: fc.Arbitrary<number> = fc.integer({ min: 0, max: 999_999 }).map((n) => n / 1e6);

/** Some text with the key in the middle. */
function around(key: string, before: string, after: string): string {
  return `${before}${key}${after}`;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

/* ---------- the fake fetch ---------- */

/** One recorded call of the fake `fetch`. Header names are lower-cased. */
type RecordedCall = {
  readonly url: string;
  readonly method: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string | undefined;
};

type Responder = (call: RecordedCall, index: number) => Response;

type FakeFetch = {
  readonly fetch: typeof fetch;
  readonly calls: RecordedCall[];
};

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function createFakeFetch(responder: Responder): FakeFetch {
  const calls: RecordedCall[] = [];
  const fake = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const headers = new Map<string, string>();
    new Headers(init?.headers).forEach((value, name) => {
      headers.set(name.toLowerCase(), value);
    });
    const call: RecordedCall = {
      url: urlOf(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    // A responder that throws makes the promise reject, like a network failure of `fetch`.
    return new Promise<Response>((resolve, reject) => {
      try {
        resolve(responder(call, calls.length - 1));
      } catch (error: unknown) {
        reject(error);
      }
    });
  };
  return { fetch: fake as typeof fetch, calls };
}

/* ---------- scripted responses ---------- */

type BodyShape = 'json' | 'text' | 'html' | 'quota';
type ThrowFlavor = 'type-error' | 'error' | 'dom-exception';
type MalformedShape = 'not-json' | 'wrong-shape' | 'empty-choices' | 'bad-args' | 'cut-off';

function errorBody(key: string, shape: BodyShape): string {
  switch (shape) {
    case 'json':
      return JSON.stringify({
        error: { message: `Incorrect API key provided: ${key}.`, type: 'invalid_request_error' },
      });
    case 'text':
      return `Unauthorized request for ${key}`;
    case 'html':
      return `<html><body><h1>Bad gateway</h1><p>${key}</p></body></html>`;
    case 'quota':
      return JSON.stringify({ error: { message: `You exceeded your quota, key ${key}` } });
  }
}

function httpErrorResponse(key: string, status: number, shape: BodyShape): Response {
  return new Response(errorBody(key, shape), { status });
}

function throwFlavor(key: string, flavor: ThrowFlavor): never {
  switch (flavor) {
    case 'type-error':
      throw new TypeError(`Failed to fetch https://user:${key}@api.example.test/v1`);
    case 'error':
      throw new Error(`connect ECONNREFUSED, Authorization: Bearer ${key}`);
    case 'dom-exception':
      throw new DOMException(`The operation failed for ${key}`, 'NetworkError');
  }
}

function malformedResponse(key: string, shape: MalformedShape): Response {
  switch (shape) {
    case 'not-json':
      return new Response(`oops, the key is ${key}`, { status: 200 });
    case 'wrong-shape':
      return new Response(JSON.stringify({ error: key, choices: 'none' }), { status: 200 });
    case 'empty-choices':
      return new Response(JSON.stringify({ choices: [], note: key }), { status: 200 });
    case 'bad-args':
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ function: { name: 'x', arguments: { secret: key } } }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    case 'cut-off':
      return new Response(`{"choices":[{"message":{"content":"${key}`, { status: 200 });
  }
}

const arbBodyShape: fc.Arbitrary<BodyShape> = fc.constantFrom('json', 'text', 'html', 'quota');
const arbThrowFlavor: fc.Arbitrary<ThrowFlavor> = fc.constantFrom(
  'type-error',
  'error',
  'dom-exception',
);
const arbMalformedShape: fc.Arbitrary<MalformedShape> = fc.constantFrom(
  'not-json',
  'wrong-shape',
  'empty-choices',
  'bad-args',
  'cut-off',
);
const arbHttpStatus: fc.Arbitrary<number> = fc.constantFrom(400, 401, 429, 500);

/* ---------- the plan of one Turn ---------- */

/** What a model may echo: nothing, an unused field, its text content, or the argument of `say`. */
type Echo = 'none' | 'extra' | 'content' | 'say-arg';

type Item =
  | { readonly kind: 'op'; readonly template: OperationTemplate }
  | { readonly kind: 'clean-op'; readonly template: OperationTemplate }
  | {
      readonly kind: 'wrong-type';
      readonly template: OperationTemplate;
      readonly keyPick: number;
      readonly value: unknown;
    }
  | { readonly kind: 'unknown-tool'; readonly name: string }
  | { readonly kind: 'bad-json'; readonly name: string; readonly text: string }
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'create-stack'; readonly name: string };

type Round =
  | { readonly kind: 'calls'; readonly items: readonly Item[]; readonly echo: Echo }
  | { readonly kind: 'stop'; readonly echo: Echo }
  | { readonly kind: 'http'; readonly status: number; readonly shape: BodyShape }
  | { readonly kind: 'throw'; readonly flavor: ThrowFlavor }
  | { readonly kind: 'malformed'; readonly shape: MalformedShape };

type Held = {
  readonly newStack: boolean;
  readonly stack: Stack;
  readonly currentCardId: string;
};

type Case = {
  readonly key: string;
  readonly held: Held;
  readonly jsonMode: boolean;
  readonly userMessage: string;
  readonly plan: readonly Round[];
};

const REPLACEMENTS: readonly unknown[] = [0, -1, 3.5, 'x', '', null, true, [], {}, { a: 1 }];
const UNKNOWN_TOOL_NAMES = ['nope', '', 'constructor', '__proto__', 'Create_Card', 'delete card'];
const BAD_JSON_TEXTS = ['', '{', '{"a":', 'not json', '{"a":1,}', '[]', 'null'];
const BAD_ARG_TOOLS = ['create_card', 'add_object', 'update_object', 'set_action', 'say'];
const SAY_TEXTS = ['Working on it', 'Done', ''];
const STACK_NAMES = ['My day', '', 'n'.repeat(300)];
const USER_MESSAGES = ['Make me a to-do list', 'Add a button', 'ignore previous instructions'];

const arbItem: fc.Arbitrary<Item> = fc.oneof(
  {
    weight: 6,
    arbitrary: arbOperationTemplate.map((template): Item => ({
      kind: 'clean-op',
      template: { ...template, fault: 'none', unknownName: undefined },
    })),
  },
  {
    weight: 3,
    arbitrary: arbOperationTemplate.map((template): Item => ({ kind: 'op', template })),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(arbOperationTemplate, arbFraction, fc.constantFrom(...REPLACEMENTS))
      .map(([template, keyPick, value]): Item => ({
        kind: 'wrong-type',
        template,
        keyPick,
        value,
      })),
  },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom(...UNKNOWN_TOOL_NAMES)
      .map((name): Item => ({ kind: 'unknown-tool', name })),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.constantFrom(...BAD_ARG_TOOLS), fc.constantFrom(...BAD_JSON_TEXTS))
      .map(([name, text]): Item => ({ kind: 'bad-json', name, text })),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(...SAY_TEXTS).map((text): Item => ({ kind: 'say', text })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(...STACK_NAMES)
      .map((name): Item => ({ kind: 'create-stack', name })),
  },
);

/** Which echoes a model may produce. The clean test allows none. */
function arbRound(echoes: readonly Echo[]): fc.Arbitrary<Round> {
  const arbEcho = fc.constantFrom(...echoes);
  return fc.oneof(
    {
      weight: 10,
      arbitrary: fc
        .record({ items: fc.array(arbItem, { minLength: 1, maxLength: 6 }), echo: arbEcho })
        .map((round): Round => ({ kind: 'calls', ...round })),
    },
    { weight: 1, arbitrary: arbEcho.map((echo): Round => ({ kind: 'stop', echo })) },
    {
      weight: 2,
      arbitrary: fc
        .tuple(arbHttpStatus, arbBodyShape)
        .map(([status, shape]): Round => ({ kind: 'http', status, shape })),
    },
    {
      weight: 1,
      arbitrary: arbThrowFlavor.map((flavor): Round => ({ kind: 'throw', flavor })),
    },
    {
      weight: 1,
      arbitrary: arbMalformedShape.map((shape): Round => ({ kind: 'malformed', shape })),
    },
  );
}

const arbHeld: fc.Arbitrary<Held> = fc.oneof(
  {
    weight: 1,
    arbitrary: fc.constant(0).map((): Held => {
      const start = startNewStack({ takenIds: [] });
      return { newStack: true, stack: start.stack, currentCardId: start.currentCardId };
    }),
  },
  {
    weight: 2,
    arbitrary: fc.tuple(arbStack, arbFraction).map(([stack, pick]): Held => {
      const index = Math.min(stack.cards.length - 1, Math.floor(pick * stack.cards.length));
      return { newStack: false, stack, currentCardId: stack.cards[index]?.id ?? '' };
    }),
  },
);

function arbCase(echoes: readonly Echo[]): fc.Arbitrary<Case> {
  return fc.record({
    key: arbKey,
    held: arbHeld,
    jsonMode: fc.boolean(),
    userMessage: fc.constantFrom(...USER_MESSAGES),
    plan: fc.array(arbRound(echoes), { minLength: 0, maxLength: 8, size: 'max' }),
  });
}

/* ---------- turning a plan into OpenAI-shaped replies ---------- */

type Emitted = { readonly name: string; readonly args: string };

function stringify(params: unknown): string {
  return JSON.stringify(params) ?? 'null';
}

function parseOrRaw(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One item as the calls it stands for. `mirror` is the stack the earlier accepted calls made. */
function expandItem(item: Item, mirror: Stack): readonly Emitted[] {
  switch (item.kind) {
    case 'op':
    case 'clean-op': {
      const resolved = resolveOperation(mirror, item.template);
      return [{ name: resolved.name, args: stringify(resolved.params) }];
    }
    case 'wrong-type': {
      const resolved = resolveOperation(mirror, item.template);
      const params = resolved.params;
      if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
        const keys = Object.keys(params);
        const key = keys[Math.min(keys.length - 1, Math.floor(item.keyPick * keys.length))];
        if (key !== undefined) {
          return [{ name: resolved.name, args: stringify({ ...params, [key]: item.value }) }];
        }
      }
      return [{ name: resolved.name, args: stringify(params) }];
    }
    case 'unknown-tool':
      return [{ name: item.name, args: '{}' }];
    case 'bad-json':
      return [{ name: item.name, args: item.text }];
    case 'say':
      return [{ name: 'say', args: stringify({ text: item.text }) }];
    case 'create-stack':
      return [{ name: 'create_stack', args: stringify({ name: item.name }) }];
  }
}

/** Keeps the mirror close to what the Turn holds, so the valid calls stay realistic. */
function advanceMirror(mirror: Stack, call: Emitted): Stack {
  const params = parseOrRaw(call.args);
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return mirror;
  const result = applyOperation(mirror, call.name, params);
  return result.ok ? result.stack : mirror;
}

/** A valid reply. `extra` holds fields no one reads, with the key in them. */
function okResponse(
  native: boolean,
  calls: readonly Emitted[],
  content: string | null,
  extraKey: string | undefined,
): Response {
  const extras =
    extraKey === undefined ? {} : { system_fingerprint: extraKey, usage: { note: extraKey } };
  const message = native
    ? {
        role: 'assistant',
        content,
        ...(extraKey === undefined ? {} : { reasoning: extraKey }),
        tool_calls: calls.map((call, index) => ({
          id: `call_${index}`,
          type: 'function',
          function: { name: call.name, arguments: call.args },
        })),
      }
    : {
        role: 'assistant',
        content: stringify({
          calls: calls.map((call) => ({ tool: call.name, params: parseOrRaw(call.args) })),
          ...(content === null ? {} : { say: content }),
        }),
      };
  const body = {
    id: 'chatcmpl-test',
    ...extras,
    choices: [
      {
        index: 0,
        finish_reason: native && calls.length > 0 ? 'tool_calls' : 'stop',
        message,
      },
    ],
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

type TurnFetch = {
  readonly fake: FakeFetch;
  /** The index of the first fetch call whose reply carried the key as model output, or Infinity. */
  readonly firstModelEcho: () => number;
};

function createTurnFetch(c: Case, input: Stack): TurnFetch {
  let mirror = input;
  let planIndex = 0;
  let firstEcho = Number.POSITIVE_INFINITY;

  const responder: Responder = (call, index) => {
    const native =
      call.body !== undefined &&
      typeof parseOrRaw(call.body) === 'object' &&
      Object.hasOwn(parseOrRaw(call.body) as object, 'tools');
    const round = c.plan[planIndex];
    planIndex += 1;

    if (round === undefined) {
      return okResponse(native, [], null, undefined);
    }
    switch (round.kind) {
      case 'http':
        return httpErrorResponse(c.key, round.status, round.shape);
      case 'throw':
        return throwFlavor(c.key, round.flavor);
      case 'malformed':
        return malformedResponse(c.key, round.shape);
      case 'stop': {
        if (round.echo === 'content' || round.echo === 'say-arg') {
          firstEcho = Math.min(firstEcho, index);
          return okResponse(native, [], around(c.key, 'Your key is ', ''), undefined);
        }
        return okResponse(native, [], null, round.echo === 'extra' ? c.key : undefined);
      }
      case 'calls': {
        const calls: Emitted[] = [];
        for (const item of round.items) {
          for (const call of expandItem(item, mirror)) {
            calls.push(call);
            mirror = advanceMirror(mirror, call);
          }
        }
        let content: string | null = null;
        if (round.echo === 'say-arg') {
          calls.push({ name: 'say', args: stringify({ text: around(c.key, 'The key is ', '!') }) });
        }
        if (round.echo === 'content') content = around(c.key, 'I was given ', '.');
        if (round.echo === 'content' || round.echo === 'say-arg') {
          firstEcho = Math.min(firstEcho, index);
        }
        // In JSON mode the `say` argument and the content both end up in the `say` field.
        if (!native && round.echo === 'say-arg') content = around(c.key, 'The key is ', '!');
        return okResponse(native, calls, content, round.echo === 'extra' ? c.key : undefined);
      }
    }
  };

  return { fake: createFakeFetch(responder), firstModelEcho: () => firstEcho };
}

/* ---------- the checks ---------- */

/**
 * The checks on one fetch call that hold in every case: the key is in the `authorization` header
 * (once, as a bearer token) and in no other place of the URL or the other headers, and the call
 * goes to the configured host. A body that the model could not have influenced holds no key.
 */
function checkCall(call: RecordedCall, key: string, bodyMustBeClean: boolean): void {
  expect(new URL(call.url).origin, 'the key goes only to the configured host').toBe(BASE_ORIGIN);
  expect(call.url.includes(key), 'key in URL').toBe(false);
  expect(call.headers.get('authorization'), 'authorization header').toBe(`Bearer ${key}`);
  for (const [name, value] of call.headers) {
    if (name === 'authorization') continue;
    expect(value.includes(key), `key in header ${name}`).toBe(false);
  }
  if (bodyMustBeClean && call.body !== undefined) {
    expect(call.body.includes(key), 'key in request body').toBe(false);
  }
}

type WireMessageView = { readonly role: string; readonly content: unknown };

function wireMessages(call: RecordedCall): readonly WireMessageView[] {
  if (call.body === undefined) return [];
  const body: unknown = JSON.parse(call.body);
  if (typeof body !== 'object' || body === null || !('messages' in body)) return [];
  const messages: unknown = body.messages;
  if (!Array.isArray(messages)) return [];
  return (messages as unknown[]).flatMap((message): WireMessageView[] =>
    typeof message === 'object' && message !== null && 'role' in message && 'content' in message
      ? [{ role: String(message.role), content: message.content }]
      : [],
  );
}

type Tally = {
  cases: number;
  withError: number;
  withAccepted: number;
  withRejected: number;
  jsonMode: number;
  newStack: number;
  fetchCalls: number;
  repairMessages: number;
  modelEchoes: number;
  /** Requests after a model echo whose body holds the key: the model's own words sent back. */
  echoedBodies: number;
};

function newTally(): Tally {
  return {
    cases: 0,
    withError: 0,
    withAccepted: 0,
    withRejected: 0,
    jsonMode: 0,
    newStack: 0,
    fetchCalls: 0,
    repairMessages: 0,
    modelEchoes: 0,
    echoedBodies: 0,
  };
}

function report(label: string, tally: Tally): void {
  process.stdout.write(
    `[key-leak.property] ${label}: seed=${getTestSeed()} runs=${tally.cases}` +
      ` fetch-calls=${tally.fetchCalls} with-error=${tally.withError}` +
      ` accepted=${tally.withAccepted} rejected=${tally.withRejected}` +
      ` repair-messages=${tally.repairMessages} json-mode=${tally.jsonMode}` +
      ` new-stack=${tally.newStack} model-echoes=${tally.modelEchoes}` +
      ` echoed-bodies=${tally.echoedBodies}\n`,
  );
}

type RunOutcome = {
  readonly result: TurnResult;
  readonly fake: FakeFetch;
  readonly firstModelEcho: number;
};

async function runCase(c: Case): Promise<RunOutcome> {
  const holder = createKeyHolder();
  holder.set(c.key);
  const turnFetch = createTurnFetch(c, c.held.stack);
  // Timers are stubbed so no real 60-second timer is ever started.
  const provider = createDirectProvider({
    baseUrl: BASE_URL,
    model: MODEL,
    getKey: () => holder.get(),
    fetch: turnFetch.fake.fetch,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
  let time = 0;
  const result = await runTurn({
    provider,
    stack: c.held.stack,
    currentCardId: c.held.currentCardId,
    selectedObjectId: null,
    userMessage: c.userMessage,
    history: [],
    newStack: c.held.newStack,
    jsonMode: c.jsonMode,
    clock: () => {
      time += 1;
      return time;
    },
  });
  return { result, fake: turnFetch.fake, firstModelEcho: turnFetch.firstModelEcho() };
}

function record(tally: Tally, c: Case, outcome: RunOutcome): void {
  const { result, fake } = outcome;
  tally.cases += 1;
  tally.fetchCalls += fake.calls.length;
  if (result.error !== undefined) tally.withError += 1;
  if (result.steps.some((step) => step.ok)) tally.withAccepted += 1;
  if (result.steps.some((step) => !step.ok)) tally.withRejected += 1;
  if (c.jsonMode || result.usedJsonMode) tally.jsonMode += 1;
  if (c.held.newStack) tally.newStack += 1;
  if (outcome.firstModelEcho !== Number.POSITIVE_INFINITY) tally.modelEchoes += 1;
  for (const [index, call] of fake.calls.entries()) {
    if (index > outcome.firstModelEcho && call.body?.includes(c.key) === true) {
      tally.echoedBodies += 1;
    }
    for (const message of wireMessages(call)) {
      if (
        (message.role === 'tool' || message.role === 'user') &&
        typeof message.content === 'string' &&
        message.content.includes('was rejected')
      ) {
        tally.repairMessages += 1;
      }
    }
  }
}

/* ---------- the properties ---------- */

describe('the key never leaks (property)', () => {
  it(
    'Feature: ai-orchestrator, Property 4: The key never leaks (a Turn, replies without the key)',
    async () => {
      // **Validates: Requirements 2.6, 7.5, 12.1, 13.4**
      const tally = newTally();
      await assertAsyncProperty(
        fc.asyncProperty(arbCase(['none', 'none', 'extra']), async (c) => {
          // `extra` is a field no one reads and is the only echo here: the model never writes
          // the key, so nothing the app sends or returns may contain it.
          const outcome = await runCase(c);
          record(tally, c, outcome);
          const { result, fake } = outcome;
          const key = c.key;

          expect(fake.calls.length, 'at least one request is made').toBeGreaterThan(0);
          for (const call of fake.calls) {
            checkCall(call, key, true);
            // Assertion 2: no message content of a request body holds the key.
            for (const message of wireMessages(call)) {
              expect(
                JSON.stringify(message.content).includes(key),
                `key in a ${message.role}`,
              ).toBe(false);
            }
            // Exactly one place holds the key: the authorization header.
            const everything = [
              call.url,
              call.method,
              call.body ?? '',
              ...[...call.headers].map(([name, value]) => `${name}: ${value}`),
            ].join('\n');
            expect(countOccurrences(everything, key), 'occurrences of the key').toBe(1);
          }

          // Everything the Turn returns, say text included, is free of the key.
          expect(JSON.stringify(result).includes(key), 'key in the Turn result').toBe(false);
          if (result.error !== undefined) {
            expect(JSON.stringify(result.error).includes(key), 'key in the error').toBe(false);
          }
        }),
      );

      report('Turn, clean replies', tally);
      expect(tally.withError, 'cases that ended with a provider error').toBeGreaterThan(0);
      expect(tally.withAccepted, 'cases with an accepted call').toBeGreaterThan(0);
      expect(tally.withRejected, 'cases with a rejected call').toBeGreaterThan(0);
      expect(tally.repairMessages, 'repair messages sent to the model').toBeGreaterThan(0);
      expect(tally.jsonMode, 'JSON-mode cases').toBeGreaterThan(0);
      expect(tally.newStack, 'new-stack cases').toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Feature: ai-orchestrator, Property 4: The key never leaks (a Turn, replies that echo the key)',
    async () => {
      // **Validates: Requirements 2.6, 7.5, 12.1, 13.4**
      const tally = newTally();
      await assertAsyncProperty(
        fc.asyncProperty(arbCase(['none', 'extra', 'content', 'say-arg']), async (c) => {
          // The model may write the key in its text, in a `say` argument and in unused fields,
          // and the provider may echo it in error bodies. Only what the app produces is checked.
          const outcome = await runCase(c);
          record(tally, c, outcome);
          const { result, fake, firstModelEcho } = outcome;
          const key = c.key;

          for (const [index, call] of fake.calls.entries()) {
            // A request after a model echo may carry the model's own words back, so its body is
            // not required to be clean, but the URL and every other header still are.
            checkCall(call, key, index <= firstModelEcho);
            // The system prompt, the context, the user messages and the tool results (the repair
            // messages) are the app's own words and never hold the key. Assistant messages are
            // the model's own words, and are checked only before the first echo.
            for (const message of wireMessages(call)) {
              if (message.role === 'assistant' && index > firstModelEcho) continue;
              expect(
                JSON.stringify(message.content).includes(key),
                `key in a ${message.role}`,
              ).toBe(false);
            }
          }

          // The result without `say`, which is the model's output: the error, the step
          // descriptions and errors, and both stacks.
          const withoutSay = { ...result, say: [] };
          expect(JSON.stringify(withoutSay).includes(key), 'key in the Turn result').toBe(false);
          if (result.error !== undefined) {
            expect(JSON.stringify(result.error).includes(key), 'key in the error').toBe(false);
          }
          for (const step of result.steps) {
            expect(step.description.includes(key), 'key in a step description').toBe(false);
          }
        }),
      );

      report('Turn, echoing replies', tally);
      expect(tally.withError, 'cases that ended with a provider error').toBeGreaterThan(0);
      expect(tally.withAccepted, 'cases with an accepted call').toBeGreaterThan(0);
      expect(tally.repairMessages, 'repair messages sent to the model').toBeGreaterThan(0);
      expect(tally.modelEchoes, 'cases where the model echoed the key').toBeGreaterThan(0);
      // The check is not vacuous: the model's own words do come back in later requests.
      expect(tally.echoedBodies, 'later requests that carry the model echo').toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Feature: ai-orchestrator, Property 4: The key never leaks (direct provider results and errors)',
    async () => {
      // **Validates: Requirements 2.6, 12.1, 13.4**
      type ProviderCase =
        | { readonly kind: 'http'; readonly status: number; readonly shape: BodyShape }
        | { readonly kind: 'throw'; readonly flavor: ThrowFlavor }
        | { readonly kind: 'malformed'; readonly shape: MalformedShape };
      const arbProviderCase: fc.Arbitrary<ProviderCase> = fc.oneof(
        fc
          .tuple(fc.integer({ min: 400, max: 599 }), arbBodyShape)
          .map(([status, shape]): ProviderCase => ({ kind: 'http', status, shape })),
        arbThrowFlavor.map((flavor): ProviderCase => ({ kind: 'throw', flavor })),
        arbMalformedShape.map((shape): ProviderCase => ({ kind: 'malformed', shape })),
      );
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'hello' }],
        meta: { userMessage: 'hello', round: 0, currentCardId: null, selectedObjectId: null },
      };
      let failures = 0;
      await assertAsyncProperty(
        fc.asyncProperty(arbKey, arbProviderCase, async (key, providerCase) => {
          const fake = createFakeFetch(() => {
            switch (providerCase.kind) {
              case 'http':
                return httpErrorResponse(key, providerCase.status, providerCase.shape);
              case 'throw':
                return throwFlavor(key, providerCase.flavor);
              case 'malformed':
                return malformedResponse(key, providerCase.shape);
            }
          });
          const provider = createDirectProvider({
            baseUrl: `${BASE_URL}/`,
            model: MODEL,
            getKey: () => key,
            fetch: fake.fetch,
            setTimeout: () => 0,
            clearTimeout: () => undefined,
          });
          const result = await provider.chat(request);
          expect(fake.calls.length).toBe(1);
          for (const call of fake.calls) checkCall(call, key, true);
          // Every case here is a failure of the provider or of its reply: no text of the
          // response or of the thrown value may reach the result.
          expect(result.ok, 'a failure is reported as a value').toBe(false);
          expect(JSON.stringify(result).includes(key), 'key in the provider result').toBe(false);
          if (!result.ok) {
            failures += 1;
            expect(PROVIDER_ERROR_CODES).toContain(result.error.code);
          }
        }),
      );
      expect(failures, 'runs').toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Feature: ai-orchestrator, Property 4: The key never leaks (capability detection)',
    async () => {
      // **Validates: Requirements 2.6, 12.1, 13.4**
      type ModelsStep =
        | { readonly kind: 'list'; readonly ids: readonly string[] }
        | { readonly kind: 'http'; readonly status: number; readonly shape: BodyShape }
        | { readonly kind: 'throw'; readonly flavor: ThrowFlavor }
        | { readonly kind: 'malformed'; readonly shape: MalformedShape };
      type ProbeStep =
        | { readonly kind: 'tool-call' }
        | { readonly kind: 'no-tool-call' }
        | { readonly kind: 'http'; readonly status: number; readonly shape: BodyShape }
        | { readonly kind: 'throw'; readonly flavor: ThrowFlavor }
        | { readonly kind: 'malformed'; readonly shape: MalformedShape };

      const arbModelsStep: fc.Arbitrary<ModelsStep> = fc.oneof(
        fc
          .subarray(['test-model', 'llama-3', 'whisper-1', 'gpt-x-transcribe', 'other'])
          .map((ids): ModelsStep => ({ kind: 'list', ids })),
        fc
          .tuple(fc.constantFrom(401, 403, 404, 429, 500), arbBodyShape)
          .map(([status, shape]): ModelsStep => ({ kind: 'http', status, shape })),
        arbThrowFlavor.map((flavor): ModelsStep => ({ kind: 'throw', flavor })),
        arbMalformedShape.map((shape): ModelsStep => ({ kind: 'malformed', shape })),
      );
      const arbProbeStep: fc.Arbitrary<ProbeStep> = fc.oneof(
        fc.constant<ProbeStep>({ kind: 'tool-call' }),
        fc.constant<ProbeStep>({ kind: 'no-tool-call' }),
        fc
          .tuple(fc.constantFrom(400, 401, 403, 429, 500), arbBodyShape)
          .map(([status, shape]): ProbeStep => ({ kind: 'http', status, shape })),
        arbThrowFlavor.map((flavor): ProbeStep => ({ kind: 'throw', flavor })),
        arbMalformedShape.map((shape): ProbeStep => ({ kind: 'malformed', shape })),
      );

      let reachable = 0;
      let unreachable = 0;
      await assertAsyncProperty(
        fc.asyncProperty(arbKey, arbModelsStep, arbProbeStep, async (key, models, probe) => {
          const fake = createFakeFetch((call) => {
            const step = call.url.endsWith('/models') ? models : probe;
            switch (step.kind) {
              case 'list':
                // `note` echoes the key in a field the app does not read.
                return new Response(
                  JSON.stringify({ note: key, data: step.ids.map((id) => ({ id })) }),
                  { status: 200 },
                );
              case 'tool-call':
                return okResponse(true, [{ name: 'noop', args: '{}' }], null, key);
              case 'no-tool-call':
                return okResponse(true, [], null, key);
              case 'http':
                return httpErrorResponse(key, step.status, step.shape);
              case 'throw':
                return throwFlavor(key, step.flavor);
              case 'malformed':
                return malformedResponse(key, step.shape);
            }
          });
          const holder = createKeyHolder();
          holder.set(key);
          const found = await detectCapabilities({
            baseUrl: BASE_URL,
            model: MODEL,
            getKey: () => holder.get(),
            fetch: fake.fetch,
            setTimeout: () => 0,
            clearTimeout: () => undefined,
          });
          expect(fake.calls.length, 'at least the model list is requested').toBeGreaterThan(0);
          for (const call of fake.calls) checkCall(call, key, true);
          expect(JSON.stringify(found).includes(key), 'key in the capability report').toBe(false);
          if (found.reachable) reachable += 1;
          else unreachable += 1;
        }),
      );
      expect(reachable, 'reachable runs').toBeGreaterThan(0);
      expect(unreachable, 'unreachable runs').toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Feature: ai-orchestrator, Property 4: The key never leaks (error mappers)',
    () => {
      // **Validates: Requirements 2.6, 12.1, 13.4**
      const arbText = fc.string({ maxLength: 40 });
      const arbStatus: fc.Arbitrary<number> = fc.oneof(
        fc.integer({ min: -10, max: 1000 }),
        fc.constantFrom(400, 401, 402, 403, 404, 418, 422, 429, 500, 502, 503),
        fc.double({ noNaN: false }),
      );
      const arbWords = fc.constantFrom('', ' quota ', ' billing ', ' insufficient funds ');

      assertProperty(
        fc.property(
          arbKey,
          arbText,
          arbText,
          arbWords,
          arbStatus,
          (key, before, after, words, status) => {
            const body = around(key, before, `${words}${after}`);
            const outputs = [errorFromHttp(status, body), errorFromHttp(status)];
            for (const output of outputs) {
              expect(JSON.stringify(output).includes(key), 'key in errorFromHttp').toBe(false);
              expect(PROVIDER_ERROR_CODES).toContain(output.code);
            }
          },
        ),
        propertyParams({ numRuns: 300 }),
      );

      assertProperty(
        fc.property(
          arbKey,
          arbText,
          arbText,
          fc.constantFrom('type-error', 'error', 'string', 'object', 'key', 'null', 'dom'),
          fc.boolean(),
          fc.boolean(),
          (key, before, after, flavor, timedOut, aborted) => {
            const text = around(key, before, after);
            const thrown: unknown = (() => {
              switch (flavor) {
                case 'type-error':
                  return new TypeError(text);
                case 'error':
                  return new Error(text, { cause: key });
                case 'string':
                  return text;
                case 'object':
                  return { message: text, key, toString: () => text };
                case 'key':
                  return key;
                case 'null':
                  return null;
                case 'dom':
                  return new DOMException(text, 'AbortError');
              }
            })();
            const output = errorFromThrown(thrown, { timedOut, aborted });
            expect(JSON.stringify(output).includes(key), 'key in errorFromThrown').toBe(false);
            expect(PROVIDER_ERROR_CODES).toContain(output.code);
          },
        ),
        propertyParams({ numRuns: 300 }),
      );

      assertProperty(
        fc.property(
          arbKey,
          arbText,
          arbStatus,
          fc.constantFrom(
            'key',
            'wrapped',
            'RATE_LIMITED',
            'DAILY_CAP',
            'MODEL_NOT_ALLOWED',
            'none',
          ),
          (key, extra, status, flavor) => {
            const code: unknown = (() => {
              switch (flavor) {
                case 'key':
                  return around(key, extra, '');
                case 'wrapped':
                  return { code: key, message: extra + key };
                case 'none':
                  return undefined;
                default:
                  return flavor;
              }
            })();
            const output = errorFromProxy(code, status);
            expect(JSON.stringify(output).includes(key), 'key in errorFromProxy').toBe(false);
            expect(PROVIDER_ERROR_CODES).toContain(output.code);
          },
        ),
        propertyParams({ numRuns: 300 }),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
