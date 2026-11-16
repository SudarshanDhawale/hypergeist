import { applyOperation } from '@hypergeist/shared/engine';
import { validateStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbStack } from '../../../../packages/shared/test-support/arbitraries.ts';
import { deepCopy, deepFreeze } from '../../../../packages/shared/test-support/freeze.ts';
import {
  arbOperationTemplate,
  resolveOperation,
} from '../../../../packages/shared/test-support/operation-arbitraries.ts';
import type { OperationTemplate } from '../../../../packages/shared/test-support/operation-arbitraries.ts';
import {
  SEED_VARIABLE,
  getTestSeed,
  propertyParams,
} from '../../../../packages/shared/test-support/seed.ts';
import { startNewStack } from './new-stack.ts';
import {
  createScriptedProvider,
  providerFailure,
  rawToolCall,
  reply,
  resetToolCallIds,
} from './testing/scripted-provider.ts';
import { runTurn } from './turn.ts';
import type { TurnResult } from './turn.ts';
import type { ChatRequest, ProviderErrorCode, ProviderResult, ToolCall } from './types.ts';

/*
 * Property tests of the Turn loop against a scripted, hostile model.
 *
 * The model is a function. It keeps a mirror of the stack the Turn holds: for every round it
 * resolves operation templates against the mirror, applies the accepted calls to the mirror in
 * order (as the Turn does), and serializes the calls as native tool calls or as one JSON
 * object, depending on whether the request carried tools. Faults are mixed in by fast-check.
 * The mirror only makes the valid calls realistic; the checks below never depend on it.
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
      `Replay with: ${SEED_VARIABLE}=${seed} pnpm exec vitest run apps/web/src/ai/turn.property.test.ts\n`,
    );
    throw error;
  }
}

/** Explicit test timeout. A parallel full-suite run is slower than a single file run. */
const TEST_TIMEOUT_MS = 60_000;

const MAX_ROUNDS = 8;
const MAX_CALLS = 40;
const MAX_REJECTED = 6;
const SAY_MAX = 2000;
const BIG_TEXT = 50_000;
const MAX_ITEMS_PER_ROUND = 8;
const MAX_PLAN_ROUNDS = 10;

/* ---------- the plan: what the scripted model does, round by round ---------- */

type JsonStyle = 'plain' | 'fenced' | 'prose' | 'malformed';

type Item =
  | { readonly kind: 'op'; readonly template: OperationTemplate }
  /** The template with its fault removed: a call built from the real ids of the mirror. */
  | { readonly kind: 'clean-op'; readonly template: OperationTemplate }
  | {
      readonly kind: 'wrong-type';
      readonly template: OperationTemplate;
      readonly keyPick: number;
      readonly value: unknown;
    }
  | { readonly kind: 'unknown-tool'; readonly name: string }
  | { readonly kind: 'bad-json'; readonly name: string; readonly text: string }
  | { readonly kind: 'truncated'; readonly template: OperationTemplate; readonly cut: number }
  | { readonly kind: 'non-object'; readonly name: string; readonly text: string }
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'big-text' }
  | { readonly kind: 'repeat' }
  | { readonly kind: 'create-stack'; readonly name: string }
  | {
      readonly kind: 'flood';
      readonly flavor: 'say' | 'op';
      readonly count: number;
      readonly template: OperationTemplate;
    };

type Round =
  | {
      readonly kind: 'calls';
      readonly items: readonly Item[];
      readonly style: JsonStyle;
      readonly say: string | undefined;
      readonly bigContent: boolean;
      /** Abort the signal from inside the script, then return the reply anyway. */
      readonly abort: boolean;
    }
  | { readonly kind: 'empty'; readonly text: string | null }
  | { readonly kind: 'failure'; readonly code: ProviderErrorCode };

type Held = {
  readonly newStack: boolean;
  readonly stack: Stack;
  readonly currentCardId: string;
};

type Case = {
  readonly held: Held;
  readonly jsonMode: boolean;
  readonly plan: readonly Round[];
};

/* ---------- arbitraries ---------- */

const ERROR_CODES: readonly ProviderErrorCode[] = [
  'NETWORK',
  'CORS_OR_OFFLINE',
  'AUTH',
  'RATE_LIMITED',
  'QUOTA',
  'MODEL_NOT_FOUND',
  'BAD_REQUEST',
  'SERVER',
  'TIMEOUT',
  'ABORTED',
  'BAD_REPLY',
  'DEMO_ONLY',
];

/** Tool names that are not tools. Never `reply`: the Turn uses that name for unreadable JSON replies. */
const UNKNOWN_TOOL_NAMES = [
  'nope',
  '',
  'constructor',
  '__proto__',
  'toString',
  'Create_Card',
  'create_cards',
  'delete card',
  'say ',
  'x'.repeat(300),
];

const BAD_JSON_TEXTS = [
  '',
  '{',
  '{"a":',
  'not json',
  '{"a":1,}',
  "{'a':1}",
  'undefined',
  '{"a": NaN}',
  '{"text": "unterminated',
];

const NON_OBJECT_TEXTS = ['[]', '"x"', 'null', '42', 'true', '[{"a":1}]', '"{}"'];

const REPLACEMENTS: readonly unknown[] = [
  0,
  -1,
  3.5,
  1e21,
  'x',
  '',
  'a'.repeat(400),
  null,
  true,
  false,
  [],
  {},
  [1, 2],
  { a: 1 },
];

const TOOL_NAMES_FOR_BAD_ARGS = [
  'create_card',
  'delete_card',
  'add_object',
  'update_object',
  'remove_object',
  'link_cards',
  'set_action',
  'say',
  'create_stack',
];

const SAY_TEXTS = ['Working on it', 'Done', 'a'.repeat(2500), ''];
const STACK_NAMES = ['My day', 'Morning', '', ' ', 'n'.repeat(300), 'x'];
const EMPTY_TEXTS: readonly (string | null)[] = [
  null,
  '',
  'All done',
  '{"calls":[]}',
  '{"calls":[],"say":"hi"}',
];

const arbFraction: fc.Arbitrary<number> = fc.integer({ min: 0, max: 999_999 }).map((n) => n / 1e6);

type ItemWeights = {
  readonly clean: number;
  readonly op: number;
  readonly fault: number;
  readonly say: number;
  readonly createStack: number;
};

const MIXED_WEIGHTS: ItemWeights = { clean: 36, op: 3, fault: 1, say: 1, createStack: 1 };
/** Mostly faults, so many cases have no accepted call (Property 2). */
const REJECTING_WEIGHTS: ItemWeights = { clean: 0, op: 1, fault: 4, say: 1, createStack: 1 };

function arbItem(weights: ItemWeights): fc.Arbitrary<Item> {
  const fault = weights.fault;
  return fc.oneof(
    {
      weight: weights.clean,
      arbitrary: arbOperationTemplate.map((template): Item => ({
        kind: 'clean-op',
        template: { ...template, fault: 'none', unknownName: undefined },
      })),
    },
    {
      weight: weights.op,
      arbitrary: arbOperationTemplate.map((template): Item => ({ kind: 'op', template })),
    },
    {
      weight: fault,
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
      weight: fault,
      arbitrary: fc
        .oneof(
          fc.constantFrom(...UNKNOWN_TOOL_NAMES),
          fc.string({ maxLength: 40 }).filter((name) => name !== 'reply'),
        )
        .map((name): Item => ({ kind: 'unknown-tool', name })),
    },
    {
      weight: fault,
      arbitrary: fc
        .tuple(fc.constantFrom(...TOOL_NAMES_FOR_BAD_ARGS), fc.constantFrom(...BAD_JSON_TEXTS))
        .map(([name, text]): Item => ({ kind: 'bad-json', name, text })),
    },
    {
      weight: fault,
      arbitrary: fc
        .tuple(arbOperationTemplate, arbFraction)
        .map(([template, cut]): Item => ({ kind: 'truncated', template, cut })),
    },
    {
      weight: fault,
      arbitrary: fc
        .tuple(fc.constantFrom(...TOOL_NAMES_FOR_BAD_ARGS), fc.constantFrom(...NON_OBJECT_TEXTS))
        .map(([name, text]): Item => ({ kind: 'non-object', name, text })),
    },
    {
      weight: weights.say,
      arbitrary: fc.constantFrom(...SAY_TEXTS).map((text): Item => ({ kind: 'say', text })),
    },
    { weight: 1, arbitrary: fc.constant<Item>({ kind: 'big-text' }) },
    { weight: 2, arbitrary: fc.constant<Item>({ kind: 'repeat' }) },
    {
      weight: weights.createStack,
      arbitrary: fc
        .constantFrom(...STACK_NAMES)
        .map((name): Item => ({ kind: 'create-stack', name })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(
          fc.constantFrom<'say' | 'op'>('say', 'op'),
          fc.integer({ min: 35, max: 50 }),
          arbOperationTemplate,
        )
        .map(([flavor, count, template]): Item => ({ kind: 'flood', flavor, count, template })),
    },
  );
}

function arbRound(weights: ItemWeights): fc.Arbitrary<Round> {
  const arbCalls: fc.Arbitrary<Round> = fc
    .record({
      items: fc.array(arbItem(weights), { minLength: 1, maxLength: MAX_ITEMS_PER_ROUND }),
      style: fc.constantFrom<JsonStyle>(
        'plain',
        'plain',
        'plain',
        'plain',
        'plain',
        'fenced',
        'fenced',
        'prose',
        'prose',
        'malformed',
      ),
      say: fc.constantFrom<string | undefined>(
        undefined,
        undefined,
        'Working on it',
        'z'.repeat(2500),
      ),
      bigContent: fc.constantFrom(false, false, false, true),
      abort: fc.integer({ min: 0, max: 24 }).map((n) => n === 0),
    })
    .map((round): Round => ({ kind: 'calls', ...round }));
  return fc.oneof(
    { weight: 10, arbitrary: arbCalls },
    {
      weight: 1,
      arbitrary: fc.constantFrom(...EMPTY_TEXTS).map((text): Round => ({ kind: 'empty', text })),
    },
    {
      weight: 1,
      arbitrary: fc.constantFrom(...ERROR_CODES).map((code): Round => ({ kind: 'failure', code })),
    },
  );
}

/** A fresh empty stack for a new-stack Turn, or an arbitrary stack with one of its cards. */
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

function arbCase(weights: ItemWeights): fc.Arbitrary<Case> {
  return fc.record({
    held: arbHeld,
    jsonMode: fc.boolean(),
    plan: fc.array(arbRound(weights), { minLength: 0, maxLength: MAX_PLAN_ROUNDS, size: 'max' }),
  });
}

/* ---------- the scripted model ---------- */

type Emitted = { readonly name: string; readonly args: string };

/** What the Turn will hold after the calls so far, and how much of its budget is used. */
type Sim = { mirror: Stack; calls: number; rejected: number };

function tryParseObject(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isValidSay(params: Record<string, unknown> | null): boolean {
  if (params === null) return false;
  const keys = Object.keys(params);
  const text = params['text'];
  return (
    keys.length === 1 && typeof text === 'string' && text.length >= 1 && text.length <= SAY_MAX
  );
}

/** Mirrors what the Turn does with one call. Stops when the Turn's budgets are used up. */
function simulate(sim: Sim, call: Emitted, newStack: boolean): void {
  if (sim.calls >= MAX_CALLS || sim.rejected >= MAX_REJECTED) return;
  sim.calls += 1;
  const params = tryParseObject(call.args);
  if (call.name === 'say') {
    if (!isValidSay(params)) sim.rejected += 1;
    return;
  }
  if (call.name === 'create_stack') {
    const name = params !== null && Object.keys(params).length === 1 ? params['name'] : undefined;
    if (newStack && typeof name === 'string') {
      const candidate: Stack = { ...sim.mirror, name };
      if (validateStack(candidate).valid) {
        sim.mirror = candidate;
        return;
      }
    }
    sim.rejected += 1;
    return;
  }
  if (params === null) {
    sim.rejected += 1;
    return;
  }
  const result = applyOperation(sim.mirror, call.name, params);
  if (result.ok) sim.mirror = result.stack;
  else sim.rejected += 1;
}

type ScriptState = {
  sim: Sim;
  index: number;
  last: Emitted | undefined;
  /** Provider error codes the script returned, so a safety-net `SERVER` of the Turn is noticed. */
  readonly codes: Set<ProviderErrorCode>;
};

function stringify(params: unknown): string {
  return JSON.stringify(params) ?? 'null';
}

/** One item as the calls it stands for. `emit` records a call and updates the working mirror. */
function expandItem(item: Item, sim: Sim, state: ScriptState, emit: (call: Emitted) => void): void {
  switch (item.kind) {
    case 'op':
    case 'clean-op': {
      const resolved = resolveOperation(sim.mirror, item.template);
      emit({ name: resolved.name, args: stringify(resolved.params) });
      return;
    }
    case 'wrong-type': {
      const resolved = resolveOperation(sim.mirror, item.template);
      const params = resolved.params;
      if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
        const keys = Object.keys(params);
        const key = keys[Math.min(keys.length - 1, Math.floor(item.keyPick * keys.length))];
        if (key !== undefined) {
          emit({ name: resolved.name, args: stringify({ ...params, [key]: item.value }) });
          return;
        }
      }
      emit({ name: resolved.name, args: stringify(params) });
      return;
    }
    case 'unknown-tool':
      emit({ name: item.name, args: '{}' });
      return;
    case 'bad-json':
    case 'non-object':
      emit({ name: item.name, args: item.text });
      return;
    case 'truncated': {
      const resolved = resolveOperation(sim.mirror, item.template);
      const text = stringify(resolved.params);
      emit({ name: resolved.name, args: text.slice(0, Math.floor(item.cut * text.length)) });
      return;
    }
    case 'say':
      emit({ name: 'say', args: stringify({ text: item.text }) });
      return;
    case 'big-text':
      emit({ name: 'say', args: stringify({ text: 't'.repeat(BIG_TEXT) }) });
      return;
    case 'repeat':
      if (state.last !== undefined) emit(state.last);
      return;
    case 'create-stack':
      emit({ name: 'create_stack', args: stringify({ name: item.name }) });
      return;
    case 'flood':
      for (let n = 0; n < item.count; n += 1) {
        if (item.flavor === 'say') {
          emit({ name: 'say', args: stringify({ text: `note ${n}` }) });
        } else {
          const resolved = resolveOperation(sim.mirror, item.template);
          emit({ name: resolved.name, args: stringify(resolved.params) });
        }
      }
      return;
  }
}

function parseOrRaw(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function wrapJson(text: string, style: JsonStyle, big: boolean): string {
  switch (style) {
    case 'plain':
      return text;
    case 'fenced':
      return `\`\`\`json\n${text}\n\`\`\``;
    case 'prose':
      return `${big ? 'x'.repeat(BIG_TEXT) : 'Here you go:\n'}${text}\nDone`;
    case 'malformed':
      return text.slice(0, Math.floor(text.length / 2));
  }
}

type ScriptHandle = {
  readonly script: (request: ChatRequest) => ProviderResult;
  readonly state: ScriptState;
};

function buildScript(c: Case, input: Stack, controller: AbortController): ScriptHandle {
  const state: ScriptState = {
    sim: { mirror: input, calls: 0, rejected: 0 },
    index: 0,
    last: undefined,
    codes: new Set(),
  };

  const script = (request: ChatRequest): ProviderResult => {
    const native = request.tools !== undefined;
    const round = c.plan[state.index];
    state.index += 1;
    // Past the end of the plan the model has nothing more to do and says so in the right format.
    if (round === undefined) return native ? reply() : reply({ content: '{"calls":[]}' });

    if (round.kind === 'failure') {
      state.codes.add(round.code);
      return providerFailure(round.code);
    }

    if (round.kind === 'empty') {
      if (native) return reply({ content: round.text });
      const content = round.text ?? '';
      // An unreadable JSON reply counts as one rejection of the Turn.
      if (tryParseObject(content) === null) state.sim.rejected += 1;
      return reply({ content });
    }

    const work: Sim = { ...state.sim };
    const calls: Emitted[] = [];
    const emit = (call: Emitted): void => {
      calls.push(call);
      state.last = call;
      simulate(work, call, c.held.newStack);
    };
    for (const item of round.items) expandItem(item, work, state, emit);

    let result: ProviderResult;
    if (native) {
      state.sim = work;
      const toolCalls: ToolCall[] = calls.map((call) => rawToolCall(call.name, call.args));
      result = reply({
        content: round.bigContent ? 'y'.repeat(BIG_TEXT) : (round.say ?? null),
        calls: toolCalls,
      });
    } else {
      const body = stringify({
        calls: calls.map((call) => ({ tool: call.name, params: parseOrRaw(call.args) })),
        ...(round.say === undefined ? {} : { say: round.say }),
      });
      const readable =
        round.style !== 'malformed' &&
        calls.length <= MAX_CALLS &&
        (round.say === undefined || round.say.length <= SAY_MAX);
      if (readable) state.sim = work;
      else state.sim.rejected += 1;
      result = reply({ content: wrapJson(body, round.style, round.bigContent) });
    }
    if (round.abort) controller.abort();
    return result;
  };

  return { script, state };
}

/* ---------- running one case ---------- */

type Outcome = {
  readonly result: TurnResult;
  /** The input stack as it was before the Turn (a copy, never frozen). */
  readonly snapshot: Stack;
  readonly providerCalls: number;
  readonly emittedCodes: ReadonlySet<ProviderErrorCode>;
};

async function runCase(c: Case): Promise<Outcome> {
  resetToolCallIds();
  const snapshot = deepCopy(c.held.stack);
  // A frozen input: any write by the Turn throws, and the Turn would report a SERVER error.
  const input = deepFreeze(deepCopy(c.held.stack));
  const controller = new AbortController();
  const { script, state } = buildScript(c, input, controller);
  const provider = createScriptedProvider(script);
  let time = 0;
  const result = await runTurn({
    provider,
    stack: input,
    currentCardId: c.held.currentCardId,
    selectedObjectId: null,
    userMessage: 'Change the stack',
    history: [],
    newStack: c.held.newStack,
    jsonMode: c.jsonMode,
    signal: controller.signal,
    clock: () => {
      time += 1;
      return time;
    },
  });
  return { result, snapshot, providerCalls: provider.calls, emittedCodes: state.codes };
}

const STATUSES = ['done', 'partial', 'failed', 'aborted'] as const;

function acceptedSteps(result: TurnResult): number {
  return result.steps.filter((step) => step.ok).length;
}

/** Steps that stand for a tool call. An unreadable JSON reply is a step named `reply`, not a call. */
function callSteps(result: TurnResult): number {
  return result.steps.filter((step) => step.tool !== 'reply').length;
}

/** The checks that hold for every Turn, whatever the model does (the P1 list). */
function checkValidAndBounded(outcome: Outcome): void {
  const { result, snapshot } = outcome;
  expect(validateStack(result.after).valid, 'after is a valid stack').toBe(true);
  expect(STATUSES as readonly string[], 'status').toContain(result.status);
  expect(result.rounds, 'rounds').toBeLessThanOrEqual(MAX_ROUNDS);
  expect(outcome.providerCalls, 'provider requests').toBeLessThanOrEqual(MAX_ROUNDS + 1);
  expect(callSteps(result), 'accepted plus rejected call steps').toBeLessThanOrEqual(MAX_CALLS);
  expect(
    result.steps.filter((step) => !step.ok).length,
    'rejected steps in total',
  ).toBeLessThanOrEqual(MAX_REJECTED);
  // The safety net of the Turn reports SERVER. Unless the script returned SERVER itself, that
  // means the Turn threw: a bug, or a write to the frozen input.
  if (result.error !== undefined) {
    expect(outcome.emittedCodes.has(result.error.code), `unexpected ${result.error.code}`).toBe(
      true,
    );
  }
  if (result.before !== null) expect(result.before, 'before is the input').toEqual(snapshot);
}

/** Property 2: with no accepted call the stack is unchanged. */
function checkNoAcceptedNoChange(outcome: Outcome): void {
  if (acceptedSteps(outcome.result) === 0) {
    expect(outcome.result.after, 'no accepted step, so after equals the input').toEqual(
      outcome.snapshot,
    );
  }
}

/* ---------- tallies: what the generator really produced ---------- */

type Tally = {
  cases: number;
  readonly statuses: Record<(typeof STATUSES)[number], number>;
  readonly stops: Map<string, number>;
  withAccepted: number;
  withoutAccepted: number;
  newStack: number;
  jsonMode: number;
};

function newTally(): Tally {
  return {
    cases: 0,
    statuses: { done: 0, partial: 0, failed: 0, aborted: 0 },
    stops: new Map(),
    withAccepted: 0,
    withoutAccepted: 0,
    newStack: 0,
    jsonMode: 0,
  };
}

function record(tally: Tally, c: Case, result: TurnResult): void {
  tally.cases += 1;
  tally.statuses[result.status] += 1;
  tally.stops.set(result.stopReason, (tally.stops.get(result.stopReason) ?? 0) + 1);
  if (acceptedSteps(result) > 0) tally.withAccepted += 1;
  else tally.withoutAccepted += 1;
  if (c.held.newStack) tally.newStack += 1;
  if (c.jsonMode) tally.jsonMode += 1;
}

function report(label: string, tally: Tally): void {
  const share = (n: number): string =>
    `${n} (${Math.round((n / Math.max(1, tally.cases)) * 100)}%)`;
  const stops = [...tally.stops.entries()].map(([reason, n]) => `${reason}=${n}`).join(' ');
  process.stdout.write(
    `[turn.property] ${label}: seed=${getTestSeed()} runs=${tally.cases}` +
      ` done=${share(tally.statuses.done)} partial=${share(tally.statuses.partial)}` +
      ` failed=${share(tally.statuses.failed)} aborted=${share(tally.statuses.aborted)}` +
      ` | accepted-step cases=${tally.withAccepted} none=${tally.withoutAccepted}` +
      ` new-stack=${tally.newStack} json-mode=${tally.jsonMode} | stops: ${stops}\n`,
  );
}

/* ---------- the properties ---------- */

describe('runTurn against a hostile scripted model (property)', () => {
  it(
    'Feature: ai-orchestrator, Property 1: A Turn keeps the stack valid',
    async () => {
      // **Validates: Requirements 6.4, 6.7, 6.8, 7.2, 7.4, 13.1**
      const tally = newTally();
      await assertAsyncProperty(
        fc.asyncProperty(arbCase(MIXED_WEIGHTS), async (c) => {
          const outcome = await runCase(c);
          const { result, snapshot } = outcome;
          record(tally, c, result);

          checkValidAndBounded(outcome);

          // Status and steps agree.
          const accepted = acceptedSteps(result);
          if (result.status === 'partial') {
            expect(accepted, 'partial has an accepted step').toBeGreaterThan(0);
          }
          if (result.status === 'failed') {
            expect(accepted, 'failed has no accepted step').toBe(0);
            expect(result.after, 'failed leaves the stack unchanged').toEqual(snapshot);
          }
          if (result.status === 'done' && accepted === 0) {
            expect(result.steps, 'done with no accepted step has no rejected step').toEqual([]);
          }
          expect(result.status === 'aborted', 'aborted status and stop reason').toBe(
            result.stopReason === 'aborted',
          );
          expect(result.before === null, 'before is null exactly for a new stack').toBe(
            c.held.newStack,
          );
        }),
      );

      report('P1', tally);
      for (const status of STATUSES) {
        expect(tally.statuses[status], `status ${status} was seen`).toBeGreaterThan(0);
      }
      expect(tally.withAccepted, 'cases with an accepted step').toBeGreaterThan(0);
      expect(tally.newStack, 'new-stack cases').toBeGreaterThan(0);
      expect(tally.jsonMode, 'JSON-mode cases').toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Feature: ai-orchestrator, Property 2: A Turn with no accepted call changes nothing',
    async () => {
      // **Validates: Requirements 7.4, 13.2**
      const tally = newTally();
      await assertAsyncProperty(
        fc.asyncProperty(arbCase(REJECTING_WEIGHTS), async (c) => {
          const outcome = await runCase(c);
          record(tally, c, outcome.result);

          expect(validateStack(outcome.result.after).valid, 'after is a valid stack').toBe(true);
          checkNoAcceptedNoChange(outcome);
        }),
      );

      report('P2', tally);
      expect(tally.withoutAccepted, 'cases with no accepted step').toBeGreaterThan(0);
      expect(tally.withAccepted, 'cases with an accepted step').toBeGreaterThan(0);
      expect(tally.statuses.failed, 'status failed was seen').toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});
