import { applyOperation, createStack } from '@hypergeist/shared/engine';
import type { EffectRequest } from '@hypergeist/shared/engine';
import { parseStack, validateStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SEED_VARIABLE,
  getTestSeed,
  propertyParams,
} from '../../../../packages/shared/test-support/seed.ts';
import { createKeyHolder, loadScenarios } from '../ai/index.ts';
import type { Provider } from '../ai/index.ts';
import { providerFailure } from '../ai/testing/scripted-provider.ts';
import type { ProviderErrorCode, ProviderResult } from '../ai/types.ts';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { createAiStore } from './ai-store.ts';
import { createEffectsRuntime, FIELD_TIMEOUT_MS } from './effects-runtime.ts';
import { createEffectsStore } from './effects-store.ts';
import { createStackStore } from './stack-store.ts';

/*
 * Property: whatever the model answers (text of any length, errors, no match), and whenever the
 * user deletes a field, switches stacks or lets a run time out, the open stack stays valid, a
 * stack that was switched to is never written to, and every run ends with its field unmarked.
 */

/* ---------- helpers: async property, report (same pattern as ai/turn.property.test.ts) ---------- */

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
      `Replay with: ${SEED_VARIABLE}=${seed} pnpm exec vitest run apps/web/src/state/effects-runtime.property.test.ts\n`,
    );
    throw error;
  }
}

/** Explicit test timeout. A parallel full-suite run is slower than a single file run. */
const TEST_TIMEOUT_MS = 60_000;

const FIELD_COUNT = 4;

/* ---------- fixtures ---------- */

const MAIN: { stack: Stack; ids: string[] } = (() => {
  const parsed = parseStack(demoText);
  if (!parsed.ok) throw new Error('The bundled demo stack is not valid.');
  let stack = parsed.value;
  const ids: string[] = [];
  for (let index = 0; index < FIELD_COUNT; index += 1) {
    const added = applyOperation(stack, 'add_object', {
      cardId: 'todo',
      type: 'ai-field',
      prompt: `Summarise the tasks ${index + 1}.`,
      inputObjectIds: ['todo-input'],
      x: 16 + index * 4,
      y: 300,
      width: 200,
      height: 32,
    });
    if (!added.ok) throw new Error('The fixture ai-field was rejected.');
    stack = added.stack;
    ids.push(added.summary.created[0] ?? '');
  }
  return { stack, ids };
})();

const OTHER: Stack = (() => {
  const made = createStack({ id: 'other-stack', name: 'Other' });
  if (!made.ok) throw new Error('The other stack is not valid.');
  return made.stack;
})();

const SCENARIOS = loadScenarios().scenarios;

/* ---------- the plan ---------- */

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

type Outcome =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'error'; readonly code: ProviderErrorCode }
  | { readonly kind: 'nomatch' };

type Action =
  | { readonly kind: 'run'; readonly field: number; readonly outcome: Outcome }
  | { readonly kind: 'settle'; readonly pick: number }
  | { readonly kind: 'delete'; readonly field: number }
  | { readonly kind: 'switch'; readonly to: 'main' | 'other' }
  | { readonly kind: 'type'; readonly text: string }
  | { readonly kind: 'timeout' };

const arbText: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc
    .tuple(fc.constantFrom('x', 'é', '😀', '  ', '\n', ' '), fc.integer({ min: 0, max: 12_000 }))
    .map(([unit, count]) => unit.repeat(count)),
);

const arbOutcome: fc.Arbitrary<Outcome> = fc.oneof(
  arbText.map((text): Outcome => ({ kind: 'ok', text })),
  fc.constantFrom(...ERROR_CODES).map((code): Outcome => ({ kind: 'error', code })),
  fc.constant<Outcome>({ kind: 'nomatch' }),
);

const arbAction: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('run' as const),
      field: fc.integer({ min: 0, max: FIELD_COUNT - 1 }),
      outcome: arbOutcome,
    }),
  },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('settle' as const), pick: fc.nat(10) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('delete' as const),
      field: fc.integer({ min: 0, max: FIELD_COUNT - 1 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('switch' as const),
      to: fc.constantFrom('main' as const, 'other' as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('type' as const), text: arbText }) },
  { weight: 1, arbitrary: fc.constant<Action>({ kind: 'timeout' }) },
);

function resultOf(outcome: Outcome): ProviderResult {
  switch (outcome.kind) {
    case 'ok':
      return {
        ok: true,
        reply: { content: outcome.text, toolCalls: [], finishReason: 'stop' },
      };
    case 'error':
      return providerFailure(outcome.code);
    case 'nomatch':
      return {
        ok: true,
        reply: { content: null, toolCalls: [], finishReason: 'stop', noMatch: true },
      };
  }
}

/* ---------- the run ---------- */

async function microtasks(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

async function play(actions: readonly Action[]): Promise<void> {
  const stackStore = createStackStore(MAIN.stack);
  const effectsStore = createEffectsStore();
  const aiStore = createAiStore();

  // A clock that only moves on the `timeout` action.
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>();

  /** The chat calls that wait for an answer: resolve with the planned outcome or on abort. */
  const waiting: { settle: () => void }[] = [];
  let nextOutcome: Outcome = { kind: 'nomatch' };

  function providerFor(outcome: Outcome): Provider {
    return {
      kind: 'direct',
      chat: (_request, signal) =>
        new Promise<ProviderResult>((resolve) => {
          const settle = () => {
            resolve(resultOf(outcome));
          };
          waiting.push({ settle });
          signal?.addEventListener('abort', () => {
            resolve(providerFailure('ABORTED'));
          });
        }),
    };
  }

  let ids = 0;
  const runtime = createEffectsRuntime({
    stackStore,
    effectsStore,
    aiStore,
    keyHolder: createKeyHolder(),
    scenarios: SCENARIOS,
    fetch: (() => Promise.reject(new Error('No network in this test.'))) as typeof fetch,
    reminderRepo: {
      list: () => Promise.resolve({ ok: true, value: [] }),
      put: () => Promise.resolve({ ok: true, value: undefined }),
      remove: () => Promise.resolve({ ok: true, value: undefined }),
    },
    now: () => now,
    setTimeout: (run, ms) => {
      sequence += 1;
      timers.set(sequence, { at: now + ms, run });
      return sequence;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    refreshQuota: () => Promise.resolve(),
    makeId: () => {
      ids += 1;
      return ids;
    },
    chooseChain: () => ({ ok: true, chain: [providerFor(nextOutcome)], label: 'demo' }),
  });

  // What the user did to the open stack. An answer must never undo any of it.
  let openId = MAIN.stack.id;
  const deleted = new Set<string>();

  function assertInvariants(): void {
    const current = stackStore.getState().stack;
    expect(validateStack(current).valid).toBe(true);
    // A late answer never switches the stack that is open.
    expect(current.id).toBe(openId);
    if (current.id === OTHER.id) {
      // A stack that was switched to is never written to.
      expect(current).toBe(OTHER);
    } else {
      // A deleted field never comes back.
      const present = new Set(current.cards.flatMap((card) => card.objects.map((o) => o.id)));
      for (const id of deleted) expect(present.has(id)).toBe(false);
    }
  }

  for (const action of actions) {
    switch (action.kind) {
      case 'run': {
        nextOutcome = action.outcome;
        const targetObjectId = MAIN.ids[action.field] ?? '';
        const effect: EffectRequest = {
          kind: 'run_ai_field',
          actionIndex: 0,
          targetObjectId,
          prompt: `Summarise the tasks ${action.field + 1}.`,
          inputs: [{ objectId: 'todo-input', name: 'New item', text: 'eggs' }],
        };
        runtime.handle([effect], MAIN.stack);
        break;
      }
      case 'settle': {
        const entry = waiting.splice(action.pick % Math.max(waiting.length, 1), 1)[0];
        entry?.settle();
        break;
      }
      case 'delete': {
        const current = stackStore.getState().stack;
        const objectId = MAIN.ids[action.field] ?? '';
        const removed = applyOperation(current, 'remove_object', { objectId });
        if (removed.ok) {
          stackStore.getState().applyStack(removed.stack);
          deleted.add(objectId);
        }
        break;
      }
      case 'switch':
        stackStore.getState().replaceStack(action.to === 'main' ? MAIN.stack : OTHER);
        openId = action.to === 'main' ? MAIN.stack.id : OTHER.id;
        // Opening the stack again brings every field back.
        deleted.clear();
        break;
      case 'type':
        stackStore.getState().typeInField('todo-input', action.text.slice(0, 200));
        break;
      case 'timeout': {
        now += FIELD_TIMEOUT_MS;
        for (const [id, timer] of [...timers]) {
          if (timer.at <= now) {
            timers.delete(id);
            timer.run();
          }
        }
        break;
      }
    }
    await microtasks();
    assertInvariants();
  }

  // Let every run end: answer what still waits, then flush.
  for (
    let round = 0;
    round < FIELD_COUNT * 2 && (waiting.length > 0 || effectsStore.getState().running.size > 0);
    round += 1
  ) {
    for (const entry of waiting.splice(0)) entry.settle();
    await microtasks();
  }
  assertInvariants();
  expect(effectsStore.getState().running.size).toBe(0);
  expect(timers.size).toBe(0);
  runtime.dispose();
}

describe('effects runtime properties', () => {
  it(
    'random field results, deletions and stack switches keep the open stack valid',
    async () => {
      await assertAsyncProperty(
        fc.asyncProperty(fc.array(arbAction, { minLength: 1, maxLength: 25 }), async (actions) => {
          await play(actions);
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
