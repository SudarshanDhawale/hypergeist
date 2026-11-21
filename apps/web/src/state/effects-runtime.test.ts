import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOperation, createStack } from '@hypergeist/shared/engine';
import type { EffectRequest, RunAiFieldEffect } from '@hypergeist/shared/engine';
import { parseStack, validateStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { createKeyHolder, loadScenarios } from '../ai/index.ts';
import type { AiSettings, Provider, ProviderError } from '../ai/index.ts';
import { createScriptedProvider, providerFailure, reply } from '../ai/testing/scripted-provider.ts';
import type { Script } from '../ai/testing/scripted-provider.ts';
import { PAST_MESSAGE, TOO_FAR_MESSAGE, TOO_MANY_MESSAGE } from '../reminders/reminder-logic.ts';
import { DUE_TIME_FORMAT_MESSAGE } from '../reminders/due-time.ts';
import type { Reminder, ReminderRepository, ReminderResult } from '../reminders/types.ts';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { createAiStore } from './ai-store.ts';
import {
  createEffectsRuntime,
  FIELD_TIMEOUT_MS,
  MAX_TIMER_MS,
  todayText,
} from './effects-runtime.ts';
import type { EffectsRuntimeDeps, NotificationPort } from './effects-runtime.ts';
import { createEffectsStore } from './effects-store.ts';
import { createStackStore } from './stack-store.ts';

/*
 * `applyOperation` is the real one unless a test switches `reject` on. That is the only way to
 * see a rejected operation: the open stack is always valid, so a real `update_object` of a text
 * that fits never fails.
 */
const mocks = vi.hoisted(() => ({ reject: false }));
vi.mock('@hypergeist/shared/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hypergeist/shared/engine')>();
  return {
    ...actual,
    applyOperation: (...args: Parameters<typeof actual.applyOperation>) =>
      mocks.reject
        ? { ok: false as const, errors: [], truncated: false }
        : actual.applyOperation(...args),
  };
});

/* ---------- fixtures ---------- */

const NOW = new Date(2026, 10, 18, 9, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const BASE: Stack = (() => {
  const parsed = parseStack(demoText);
  if (!parsed.ok) throw new Error('The bundled demo stack is not valid.');
  return parsed.value;
})();

/** The demo stack plus `count` ai-fields on its first card. */
function stackWithFields(count: number): { stack: Stack; ids: string[] } {
  let stack = BASE;
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = applyOperation(stack, 'add_object', {
      cardId: 'todo',
      type: 'ai-field',
      name: `Answer ${index + 1}`,
      prompt: `Summarise the tasks ${index + 1}.`,
      inputObjectIds: ['todo-input'],
      x: 16 + index * 4,
      y: 300,
      width: 200,
      height: 32,
    });
    if (!result.ok) throw new Error('The fixture ai-field was rejected.');
    stack = result.stack;
    const created = result.summary.created[0];
    if (created === undefined) throw new Error('The fixture ai-field has no id.');
    ids.push(created);
  }
  return { stack, ids };
}

function otherStack(): Stack {
  const made = createStack({ id: 'other-stack', name: 'Other' });
  if (!made.ok) throw new Error('The other stack is not valid.');
  return made.stack;
}

function fieldEffect(objectId: string, stack: Stack): RunAiFieldEffect {
  const field = stack.cards
    .flatMap((card) => card.objects)
    .find((object) => object.id === objectId);
  if (field?.type !== 'ai-field') throw new Error('Not an ai-field.');
  return {
    kind: 'run_ai_field',
    actionIndex: 0,
    targetObjectId: objectId,
    prompt: field.prompt,
    inputs: [{ objectId: 'todo-input', name: 'New item', text: 'eggs and milk' }],
  };
}

function remindEffect(at: string, message = 'Call the dentist'): EffectRequest {
  return { kind: 'schedule_notification', actionIndex: 0, message, at };
}

function localIso(year: number, month: number, day: number, hour: number, minute: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

function reminder(id: string, dueAt: number, state: Reminder['state'] = 'pending'): Reminder {
  return { id, stackId: 'thin-slice-todo', message: `Message ${id}`, dueAt, createdAt: NOW, state };
}

/* ---------- fakes ---------- */

/** A clock whose timers only run when a test advances it. */
function createClock(start: number) {
  let current = start;
  let sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => current,
    setTimeout: (run: () => void, ms: number): unknown => {
      sequence += 1;
      timers.set(sequence, { at: current + ms, run });
      return sequence;
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    /** Moves time and runs every timer that becomes due, earliest first. */
    advance(ms: number): void {
      const target = current + ms;
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < nextAt) {
            nextId = id;
            nextAt = timer.at;
          }
        }
        if (nextId === null) break;
        const timer = timers.get(nextId);
        timers.delete(nextId);
        current = Math.max(current, nextAt);
        timer?.run();
      }
      current = target;
    },
    /** Moves time without running timers, like a tab that slept. */
    jump(ms: number): void {
      current += ms;
    },
    count: () => timers.size,
    delays: () => [...timers.values()].map((timer) => timer.at - current),
  };
}

type RepoOptions = {
  readonly initial?: readonly Reminder[];
  readonly putFails?: boolean;
  readonly putThrows?: boolean;
  readonly listThrows?: boolean;
};

function createFakeRepo(options: RepoOptions = {}) {
  const records = new Map<string, Reminder>((options.initial ?? []).map((r) => [r.id, r]));
  const calls = { list: 0, put: 0, remove: 0 };
  const repo: ReminderRepository = {
    list(): Promise<ReminderResult<readonly Reminder[]>> {
      calls.list += 1;
      if (options.listThrows === true) return Promise.reject(new Error('list failed'));
      return Promise.resolve({ ok: true, value: [...records.values()] });
    },
    put(item): Promise<ReminderResult<void>> {
      calls.put += 1;
      if (options.putThrows === true) return Promise.reject(new Error('put failed'));
      if (options.putFails === true) {
        return Promise.resolve({
          ok: false,
          errors: [{ code: 'STORAGE_FAILED', message: 'raw storage text' }],
        });
      }
      records.set(item.id, item);
      return Promise.resolve({ ok: true, value: undefined });
    },
    remove(id): Promise<ReminderResult<void>> {
      calls.remove += 1;
      records.delete(id);
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
  return { repo, records, calls };
}

type Permission = 'default' | 'granted' | 'denied';

function createFakeNotification(
  initial: Permission,
  extra: { showThrows?: boolean; requestThrows?: boolean; requestRejects?: boolean } = {},
) {
  const state = {
    permission: initial,
    requests: 0,
    shown: [] as { title: string; body: string }[],
  };
  const port: NotificationPort = {
    permission: () => state.permission,
    requestPermission: () => {
      state.requests += 1;
      if (extra.requestThrows === true) throw new Error('request threw');
      if (extra.requestRejects === true) return Promise.reject(new Error('request rejected'));
      return Promise.resolve('granted');
    },
    show: (title, body) => {
      if (extra.showThrows === true) throw new Error('show threw');
      state.shown.push({ title, body });
    },
  };
  return { port, state };
}

function fakeFetch(): typeof fetch {
  return (() =>
    Promise.reject(new Error('The network must not be used in this test.'))) as typeof fetch;
}

/** A provider that answers when the test says so, and honors the abort signal. */
function gatedProvider(kind: Provider['kind'] = 'direct') {
  const waiting: { resolve: (text: string) => void }[] = [];
  const provider = createScriptedProvider(
    () =>
      new Promise((resolve) => {
        waiting.push({ resolve: (text) => resolve(reply({ content: text })) });
      }),
    { kind },
  );
  return { provider, waiting };
}

type Setup = {
  readonly stack?: Stack;
  readonly chain?: readonly Provider[];
  readonly settings?: AiSettings;
  readonly repo?: RepoOptions;
  readonly permission?: Permission | 'none';
  readonly notificationExtra?: Parameters<typeof createFakeNotification>[1];
  readonly withListeners?: boolean;
  readonly useRealChooser?: boolean;
  readonly refreshQuota?: () => Promise<void>;
  readonly chooseChain?: EffectsRuntimeDeps['chooseChain'];
  readonly nextId?: () => number;
};

function setup(options: Setup = {}) {
  const base = options.stack ?? BASE;
  const stackStore = createStackStore(base);
  const effectsStore = createEffectsStore();
  const aiStore = createAiStore();
  if (options.settings !== undefined) aiStore.getState().setSettings(options.settings);
  const clock = createClock(NOW);
  const fake = createFakeRepo(options.repo);
  const notification =
    options.permission === 'none'
      ? null
      : createFakeNotification(options.permission ?? 'granted', options.notificationExtra);
  const quota = { calls: 0 };
  let counter = 1;
  const handlers: { type: string; listener: () => void; removed: boolean }[] = [];
  const chain = options.chain ?? [];
  const deps: EffectsRuntimeDeps = {
    stackStore,
    effectsStore,
    aiStore,
    keyHolder: createKeyHolder(),
    scenarios: loadScenarios().scenarios,
    fetch: fakeFetch(),
    reminderRepo: fake.repo,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    refreshQuota:
      options.refreshQuota ??
      (() => {
        quota.calls += 1;
        return Promise.resolve();
      }),
    makeId: options.nextId ?? (() => counter++),
    ...(options.useRealChooser === true
      ? {}
      : {
          chooseChain:
            options.chooseChain ?? (() => ({ ok: true as const, chain, label: 'demo' as const })),
        }),
    ...(notification === null ? {} : { notification: notification.port }),
    ...(options.withListeners === true
      ? {
          addListener: (type: string, listener: () => void) => {
            const entry = { type, listener, removed: false };
            handlers.push(entry);
            return () => {
              entry.removed = true;
            };
          },
        }
      : {}),
  };
  const runtime = createEffectsRuntime(deps);
  const handle = (
    effects: readonly EffectRequest[],
    snapshot: Stack = stackStore.getState().stack,
  ) => {
    runtime.handle(effects, snapshot);
  };
  return {
    runtime,
    handle,
    stackStore,
    effectsStore,
    aiStore,
    clock,
    fake,
    notification,
    quota,
    handlers,
  };
}

/** Lets promise callbacks run. The fakes only use microtasks, so a macrotask is plenty. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function statusText(h: ReturnType<typeof setup>): string | undefined {
  return h.stackStore.getState().status?.text;
}

function valueOf(stack: Stack, objectId: string): string {
  const object = stack.cards.flatMap((card) => card.objects).find((o) => o.id === objectId);
  return object?.type === 'ai-field' ? object.value : '<missing>';
}

function textProvider(text: string, kind: Provider['kind'] = 'direct') {
  return createScriptedProvider([reply({ content: text })], { kind });
}

function errorProvider(code: ProviderError['code'], kind: Provider['kind'] = 'direct') {
  return createScriptedProvider(() => providerFailure(code), { kind });
}

function noMatchProvider() {
  const script: Script = () => ({
    ok: true,
    reply: { content: null, toolCalls: [], finishReason: 'stop', noMatch: true },
  });
  return createScriptedProvider(script, { kind: 'recorded' });
}

beforeEach(() => {
  mocks.reject = false;
});

afterEach(() => {
  mocks.reject = false;
});

/* ---------- todayText ---------- */

describe('todayText', () => {
  it('names the local date, the weekday and the time zone', () => {
    const text = todayText(new Date(2026, 10, 18, 12, 0, 0).getTime());
    expect(text).toMatch(/^2026-11-18, Wednesday, UTC[+-]\d{2}:\d{2}$/);
  });

  it('is total for a time that is not a date', () => {
    expect(todayText(Number.NaN)).toBe('unknown date');
  });
});

/* ---------- run_ai_field ---------- */

describe('run_ai_field', () => {
  it('writes the answer into the field, keeps the stack valid and refreshes the quota', async () => {
    const { stack, ids } = stackWithFields(1);
    const provider = textProvider('Buy eggs and milk.');
    const h = setup({ stack, chain: [provider] });
    const id = ids[0] ?? '';
    const effect = fieldEffect(id, stack);

    h.handle([effect]);
    expect(h.effectsStore.getState().running.has(`thin-slice-todo/${id}`)).toBe(true);
    await flush();

    const after = h.stackStore.getState().stack;
    expect(valueOf(after, id)).toBe('Buy eggs and milk.');
    expect(validateStack(after).valid).toBe(true);
    expect(h.effectsStore.getState().running.size).toBe(0);
    expect(h.quota.calls).toBe(1);
    expect(h.clock.count()).toBe(0);

    const request = provider.requests[0];
    expect(request).toBeDefined();
    const sent = JSON.parse(request?.messages[1]?.content ?? '{}') as {
      prompt: string;
      inputs: { name: string; text: string }[];
    };
    expect(sent.prompt).toBe(effect.prompt);
    expect(sent.inputs.map((input) => input.name)).toEqual(['New item', 'Today']);
    expect(sent.inputs[1]?.text).toBe(todayText(NOW));
  });

  it('reports a rejected operation and changes nothing', async () => {
    const { stack, ids } = stackWithFields(1);
    const h = setup({ stack, chain: [textProvider('An answer')] });
    mocks.reject = true;
    h.handle([fieldEffect(ids[0] ?? '', stack)]);
    await flush();

    expect(h.stackStore.getState().stack).toBe(stack);
    expect(statusText(h)).toBe(
      'The answer could not be put into the field, so nothing was changed.',
    );
    expect(h.effectsStore.getState().running.size).toBe(0);
    expect(h.quota.calls).toBe(1);
  });

  it('drops the answer when another stack is open, and leaves that stack alone', async () => {
    const { stack, ids } = stackWithFields(1);
    const gate = gatedProvider();
    const h = setup({ stack, chain: [gate.provider] });
    h.handle([fieldEffect(ids[0] ?? '', stack)]);
    await flush();

    const other = otherStack();
    h.stackStore.getState().replaceStack(other);
    gate.waiting[0]?.resolve('Late answer');
    await flush();

    expect(h.stackStore.getState().stack).toBe(other);
    expect(statusText(h)).toBe(
      'The stack changed while the field was working, so the answer was dropped.',
    );
    expect(h.effectsStore.getState().running.size).toBe(0);
  });

  it('drops the answer when the field was deleted meanwhile', async () => {
    const { stack, ids } = stackWithFields(1);
    const gate = gatedProvider();
    const h = setup({ stack, chain: [gate.provider] });
    const id = ids[0] ?? '';
    h.handle([fieldEffect(id, stack)]);
    await flush();

    const removed = applyOperation(stack, 'remove_object', { objectId: id });
    if (!removed.ok) throw new Error('remove_object was rejected.');
    h.stackStore.getState().applyStack(removed.stack);
    gate.waiting[0]?.resolve('Late answer');
    await flush();

    expect(h.stackStore.getState().stack).toBe(removed.stack);
    expect(statusText(h)).toContain('the answer was dropped');
  });

  it('writes into the current stack, not the snapshot', async () => {
    const { stack, ids } = stackWithFields(1);
    const gate = gatedProvider();
    const h = setup({ stack, chain: [gate.provider] });
    const id = ids[0] ?? '';
    h.handle([fieldEffect(id, stack)]);
    await flush();

    // The user types into the Field while the AI works.
    h.stackStore.getState().typeInField('todo-input', 'changed meanwhile');
    gate.waiting[0]?.resolve('Answer');
    await flush();

    const after = h.stackStore.getState().stack;
    expect(valueOf(after, id)).toBe('Answer');
    const input = after.cards[0]?.objects.find((object) => object.id === 'todo-input');
    expect(input?.type === 'field' ? input.value : '').toBe('changed meanwhile');
  });

  const CODES = [
    'NETWORK',
    'CORS_OR_OFFLINE',
    'AUTH',
    'RATE_LIMITED',
    'QUOTA',
    'MODEL_NOT_FOUND',
    'BAD_REQUEST',
    'SERVER',
    'TIMEOUT',
    'BAD_REPLY',
  ] as const;

  it.each(CODES)('shows a fixed message for %s and keeps the old value', async (code) => {
    const { stack, ids } = stackWithFields(1);
    const h = setup({ stack, chain: [errorProvider(code)] });
    h.handle([fieldEffect(ids[0] ?? '', stack)]);
    await flush();

    const text = statusText(h) ?? '';
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toContain('recorded example answer');
    expect(h.stackStore.getState().stack).toBe(stack);
    expect(h.effectsStore.getState().running.size).toBe(0);
    expect(h.quota.calls).toBe(1);
  });

  it('builds the message from the code only, never from provider text', async () => {
    const { stack, ids } = stackWithFields(1);
    const leaky: Provider = {
      kind: 'direct',
      chat: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'SERVER', message: 'secret body sk-123', hint: 'secret hint' },
        }),
    };
    const h = setup({ stack, chain: [leaky] });
    h.handle([fieldEffect(ids[0] ?? '', stack)]);
    await flush();
    expect(statusText(h)).toBe('The AI had a problem on its side. Try again in a moment.');
  });

  it('adds the recorded example note when the proxy fails and the recorded answer is used', async () => {
    const { stack, ids } = stackWithFields(1);
    const h = setup({
      stack,
      chain: [errorProvider('RATE_LIMITED', 'proxy'), textProvider('Recorded text', 'recorded')],
    });
    const id = ids[0] ?? '';
    h.handle([fieldEffect(id, stack)]);
    await flush();

    expect(valueOf(h.stackStore.getState().stack, id)).toBe('Recorded text');
    expect(statusText(h)).toBe(
      'The shared demo model is busy, so this answer is a recorded example.',
    );
  });

  it('says the demo could not be reached when the proxy fails for another reason', async () => {
    const { stack, ids } = stackWithFields(1);
    const h = setup({
      stack,
      chain: [errorProvider('SERVER', 'proxy'), textProvider('Recorded text', 'recorded')],
    });
    h.handle([fieldEffect(ids[0] ?? '', stack)]);
    await flush();
    expect(statusText(h)).toBe(
      'The demo model could not be reached, so this answer is a recorded example.',
    );
  });

  it('shows the plain DEMO_ONLY message when no recorded answer matches', async () => {
    const { stack, ids } = stackWithFields(1);
    const h = setup({ stack, chain: [errorProvider('SERVER', 'proxy'), noMatchProvider()] });
    h.handle([fieldEffect(ids[0] ?? '', stack)]);
    await flush();

    expect(statusText(h)).toBe('In demo mode this field only answers its recorded example.');
    expect(h.stackStore.getState().stack).toBe(stack);
  });

  it('cuts an oversize answer and says so', async () => {
    const { stack, ids } = stackWithFields(1);
    const h = setup({ stack, chain: [textProvider('x'.repeat(10_050))] });
    const id = ids[0] ?? '';
    h.handle([fieldEffect(id, stack)]);
    await flush();

    const after = h.stackStore.getState().stack;
    expect(valueOf(after, id)).toHaveLength(10_000);
    expect(validateStack(after).valid).toBe(true);
    expect(statusText(h)).toBe('The answer was cut to 10,000 characters.');
  });

  it('stops after 60 seconds and reports a timeout', async () => {
    const { stack, ids } = stackWithFields(1);
    const gate = gatedProvider();
    const h = setup({ stack, chain: [gate.provider] });
    h.handle([fieldEffect(ids[0] ?? '', stack)]);
    await flush();
    expect(h.clock.delays()).toEqual([FIELD_TIMEOUT_MS]);

    h.clock.advance(FIELD_TIMEOUT_MS - 1);
    await flush();
    expect(h.effectsStore.getState().running.size).toBe(1);

    h.clock.advance(1);
    await flush();
    expect(statusText(h)).toBe('The AI field took too long.');
    expect(h.effectsStore.getState().running.size).toBe(0);
    expect(h.stackStore.getState().stack).toBe(stack);
    expect(h.quota.calls).toBe(1);
  });

  it('frees the slot at the timeout even when the provider ignores the abort signal', async () => {
    const { stack, ids } = stackWithFields(1);
    const deaf: Provider = { kind: 'direct', chat: () => new Promise(() => undefined) };
    const h = setup({ stack, chain: [deaf] });
    h.handle([fieldEffect(ids[0] ?? '', stack)]);
    await flush();
    h.clock.advance(FIELD_TIMEOUT_MS);
    await flush();
    expect(statusText(h)).toBe('The AI field took too long.');
    expect(h.effectsStore.getState().running.size).toBe(0);
  });

  it('ignores a second press of the same field while it runs', async () => {
    const { stack, ids } = stackWithFields(1);
    const gate = gatedProvider();
    const h = setup({ stack, chain: [gate.provider] });
    const effect = fieldEffect(ids[0] ?? '', stack);
    h.handle([effect]);
    h.handle([effect]);
    h.handle([effect, effect]);
    await flush();
    expect(gate.provider.calls).toBe(1);

    gate.waiting[0]?.resolve('Done');
    await flush();
    // After it finished, the field may run again.
    h.handle([effect]);
    await flush();
    expect(gate.provider.calls).toBe(2);
  });

  it('runs at most 3 fields at once and starts the 4th when one finishes', async () => {
    const { stack, ids } = stackWithFields(4);
    const gate = gatedProvider();
    const h = setup({ stack, chain: [gate.provider] });
    h.handle(ids.map((id) => fieldEffect(id, stack)));
    await flush();

    expect(gate.provider.calls).toBe(3);
    // The waiting field already shows as busy.
    expect(h.effectsStore.getState().running.size).toBe(4);

    gate.waiting[0]?.resolve('First');
    await flush();
    expect(gate.provider.calls).toBe(4);

    for (const waiting of gate.waiting.slice(1)) waiting.resolve('More');
    await flush();
    expect(h.effectsStore.getState().running.size).toBe(0);
    for (const id of ids) {
      expect(valueOf(h.stackStore.getState().stack, id)).not.toBe('');
    }
    expect(validateStack(h.stackStore.getState().stack).valid).toBe(true);
    expect(h.quota.calls).toBe(4);
  });

  it('does not fall back to the demo in own mode with missing settings', async () => {
    const { stack, ids } = stackWithFields(1);
    const h = setup({
      stack,
      useRealChooser: true,
      settings: { provider: 'own', baseUrl: '', model: '' },
    });
    h.handle([fieldEffect(ids[0] ?? '', stack)]);
    await flush();

    expect(statusText(h)).toBe('Enter a base URL, a model name and a key to use your own model.');
    expect(h.effectsStore.getState().running.size).toBe(0);
    expect(h.quota.calls).toBe(0);
    expect(h.stackStore.getState().stack).toBe(stack);
  });

  it('never throws when the chain chooser throws, and says so', async () => {
    const { stack, ids } = stackWithFields(1);
    const h = setup({
      stack,
      chooseChain: () => {
        throw new Error('boom');
      },
    });
    expect(() => {
      h.handle([fieldEffect(ids[0] ?? '', stack)]);
    }).not.toThrow();
    expect(statusText(h)).toBe('Something went wrong. The field was not changed.');
    expect(h.effectsStore.getState().running.size).toBe(0);
  });

  it('never rejects when the quota refresh throws or rejects', async () => {
    const { stack, ids } = stackWithFields(2);
    for (const refreshQuota of [
      () => Promise.reject(new Error('quota failed')),
      (): Promise<void> => {
        throw new Error('quota threw');
      },
    ]) {
      const h = setup({ stack, chain: [textProvider('Fine')], refreshQuota });
      h.handle([fieldEffect(ids[0] ?? '', stack)]);
      await flush();
      expect(valueOf(h.stackStore.getState().stack, ids[0] ?? '')).toBe('Fine');
      expect(h.effectsStore.getState().running.size).toBe(0);
    }
  });

  it('ignores effects that are not its own', async () => {
    const h = setup();
    const news: EffectRequest = {
      kind: 'fetch_news',
      actionIndex: 0,
      targetObjectId: 'x',
      topics: ['tech'],
    };
    h.handle([news, { kind: 'transcribe_audio', actionIndex: 1, targetObjectId: 'x' }]);
    await flush();
    expect(statusText(h)).toBeUndefined();
    expect(h.effectsStore.getState().running.size).toBe(0);
  });
});

/* ---------- schedule_notification ---------- */

describe('schedule_notification', () => {
  const LIMIT = 'It fires only while HyperGeist is open or installed.';

  it('stores a pending reminder and says when it fires', async () => {
    const h = setup({ permission: 'granted' });
    h.handle([remindEffect(localIso(2026, 11, 18, 17, 0))]);
    await flush();

    expect(statusText(h)).toBe(`Reminder set for 2026-11-18 17:00. ${LIMIT}`);
    const stored = h.effectsStore.getState().reminders;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      stackId: 'thin-slice-todo',
      message: 'Call the dentist',
      dueAt: new Date(2026, 10, 18, 17, 0).getTime(),
      createdAt: NOW,
      state: 'pending',
    });
    expect([...h.fake.records.values()]).toEqual(stored);
    expect(h.clock.delays()).toEqual([8 * HOUR]);
  });

  it('rejects a past time with the plain message and stores nothing', async () => {
    const h = setup();
    h.handle([remindEffect(localIso(2026, 11, 18, 8, 0))]);
    await flush();
    expect(statusText(h)).toBe(PAST_MESSAGE);
    expect(h.effectsStore.getState().reminders).toEqual([]);
    expect(h.fake.calls.put).toBe(0);
    expect(h.clock.count()).toBe(0);
  });

  it('rejects a time more than 366 days away', async () => {
    const h = setup();
    h.handle([remindEffect(localIso(2028, 1, 1, 9, 0))]);
    await flush();
    expect(statusText(h)).toBe(TOO_FAR_MESSAGE);
    expect(h.fake.calls.put).toBe(0);
  });

  it('rejects text that is not a time', async () => {
    const h = setup();
    h.handle([remindEffect('next Thursday')]);
    await flush();
    expect(statusText(h)).toBe(DUE_TIME_FORMAT_MESSAGE);
    expect(h.fake.calls.put).toBe(0);
  });

  it('rejects the 51st pending reminder', async () => {
    const h = setup();
    const fifty = Array.from({ length: 50 }, (_, index) => reminder(`seed-${index}`, NOW + DAY));
    h.effectsStore.getState().setReminders(fifty);
    h.handle([remindEffect(localIso(2026, 11, 19, 9, 0))]);
    await flush();
    expect(statusText(h)).toBe(TOO_MANY_MESSAGE);
    expect(h.effectsStore.getState().reminders).toHaveLength(50);
    expect(h.fake.calls.put).toBe(0);
  });

  it('counts reminders that are still being stored against the limit', async () => {
    const h = setup();
    const forty9 = Array.from({ length: 49 }, (_, index) => reminder(`seed-${index}`, NOW + DAY));
    h.effectsStore.getState().setReminders(forty9);
    h.handle([
      remindEffect(localIso(2026, 11, 19, 9, 0), 'one'),
      remindEffect(localIso(2026, 11, 19, 10, 0), 'two'),
    ]);
    // The second one is refused at once, before the first one is stored.
    expect(statusText(h)).toBe(TOO_MANY_MESSAGE);
    await flush();
    expect(h.effectsStore.getState().reminders).toHaveLength(50);
    expect(h.fake.calls.put).toBe(1);
  });

  describe('permission', () => {
    it('asks once, synchronously inside the call, when the permission is default', () => {
      const h = setup({ permission: 'default' });
      h.handle([
        remindEffect(localIso(2026, 11, 18, 17, 0), 'one'),
        remindEffect(localIso(2026, 11, 18, 18, 0), 'two'),
      ]);
      // Nothing was awaited yet.
      expect(h.notification?.state.requests).toBe(1);
    });

    it.each(['granted', 'denied'] as const)('does not ask when it is %s', (permission) => {
      const h = setup({ permission });
      h.handle([remindEffect(localIso(2026, 11, 18, 17, 0))]);
      expect(h.notification?.state.requests).toBe(0);
    });

    it('does not ask for a time that is rejected', () => {
      const h = setup({ permission: 'default' });
      h.handle([remindEffect(localIso(2026, 11, 18, 8, 0))]);
      h.handle([remindEffect('soon')]);
      expect(h.notification?.state.requests).toBe(0);
    });

    it('does not ask without a notification port', async () => {
      const h = setup({ permission: 'none' });
      expect(() => {
        h.handle([remindEffect(localIso(2026, 11, 18, 17, 0))]);
      }).not.toThrow();
      await flush();
      expect(h.effectsStore.getState().reminders).toHaveLength(1);
    });

    it('survives a permission request that throws or rejects', async () => {
      for (const notificationExtra of [{ requestThrows: true }, { requestRejects: true }]) {
        const h = setup({ permission: 'default', notificationExtra });
        expect(() => {
          h.handle([remindEffect(localIso(2026, 11, 18, 17, 0))]);
        }).not.toThrow();
        await flush();
        expect(h.effectsStore.getState().reminders).toHaveLength(1);
      }
    });

    it('says plainly when notifications are blocked', async () => {
      const h = setup({ permission: 'denied' });
      h.handle([remindEffect(localIso(2026, 11, 18, 17, 0))]);
      await flush();
      expect(statusText(h)).toBe(
        `Reminder set for 2026-11-18 17:00. ${LIMIT} Notifications are blocked, so the reminder shows inside HyperGeist only.`,
      );
    });

    it('says plainly when the browser has no notifications', async () => {
      const h = setup({ permission: 'none' });
      h.handle([remindEffect(localIso(2026, 11, 18, 17, 0))]);
      await flush();
      expect(statusText(h)).toBe(
        `Reminder set for 2026-11-18 17:00. ${LIMIT} This browser cannot show notifications, so the reminder shows inside HyperGeist only.`,
      );
    });
  });

  it('draws another id when the first one is taken', async () => {
    const taken = reminder('rem-1', NOW + DAY);
    const numbers = [1, 1, 2];
    const h = setup({ nextId: () => numbers.shift() ?? 99 });
    h.effectsStore.getState().setReminders([taken]);
    h.handle([remindEffect(localIso(2026, 11, 18, 17, 0))]);
    await flush();
    const ids = h.effectsStore.getState().reminders.map((r) => r.id);
    expect(ids).toEqual(['rem-1', 'rem-2']);
  });

  it('reports a storage failure without throwing, and frees the slot', async () => {
    for (const repo of [{ putFails: true }, { putThrows: true }]) {
      const h = setup({ repo });
      expect(() => {
        h.handle([remindEffect(localIso(2026, 11, 18, 17, 0))]);
      }).not.toThrow();
      await flush();
      expect(statusText(h)).toBe('The reminder could not be saved.');
      expect(h.effectsStore.getState().reminders).toEqual([]);
      expect(h.clock.count()).toBe(0);
    }
  });
});

/* ---------- firing ---------- */

describe('firing', () => {
  it('marks a due reminder fired, notifies, adds an in-app notice and persists it', async () => {
    const h = setup({ permission: 'granted' });
    h.handle([remindEffect(localIso(2026, 11, 18, 17, 0), 'Call the dentist')]);
    await flush();

    h.clock.advance(8 * HOUR - 1);
    await flush();
    expect(h.effectsStore.getState().reminders[0]?.state).toBe('pending');
    expect(h.effectsStore.getState().notices).toEqual([]);

    h.clock.advance(1);
    await flush();
    const [fired] = h.effectsStore.getState().reminders;
    expect(fired?.state).toBe('fired');
    expect(h.fake.records.get(fired?.id ?? '')?.state).toBe('fired');
    expect(h.effectsStore.getState().notices).toEqual([
      { id: `reminder-${fired?.id ?? ''}`, text: 'Reminder: Call the dentist' },
    ]);
    expect(h.notification?.state.shown).toEqual([
      { title: 'HyperGeist reminder', body: 'Call the dentist' },
    ]);
    expect(h.clock.count()).toBe(0);
  });

  it('shows only the in-app notice when notifications are not granted', async () => {
    for (const permission of ['default', 'denied', 'none'] as const) {
      const h = setup({ permission });
      h.handle([remindEffect(localIso(2026, 11, 18, 17, 0))]);
      await flush();
      h.clock.advance(8 * HOUR);
      await flush();
      expect(h.notification?.state.shown ?? []).toEqual([]);
      expect(h.effectsStore.getState().notices).toHaveLength(1);
    }
  });

  it('still shows the in-app notice when Notification throws', async () => {
    const h = setup({ permission: 'granted', notificationExtra: { showThrows: true } });
    h.handle([remindEffect(localIso(2026, 11, 18, 17, 0))]);
    await flush();
    expect(() => {
      h.clock.advance(8 * HOUR);
    }).not.toThrow();
    await flush();
    expect(h.effectsStore.getState().reminders[0]?.state).toBe('fired');
    expect(h.effectsStore.getState().notices).toHaveLength(1);
  });

  it('fires every reminder that is due together, and arms the timer for the next', async () => {
    const h = setup();
    h.handle([
      remindEffect(localIso(2026, 11, 18, 10, 0), 'first'),
      remindEffect(localIso(2026, 11, 18, 10, 0), 'second'),
      remindEffect(localIso(2026, 11, 18, 12, 0), 'third'),
    ]);
    await flush();
    expect(h.clock.delays()).toEqual([HOUR]);

    h.clock.advance(HOUR);
    await flush();
    const states = h.effectsStore.getState().reminders.map((r) => [r.message, r.state]);
    expect(states).toEqual([
      ['first', 'fired'],
      ['second', 'fired'],
      ['third', 'pending'],
    ]);
    expect(h.clock.delays()).toEqual([2 * HOUR]);

    h.clock.advance(2 * HOUR);
    await flush();
    expect(h.effectsStore.getState().notices).toHaveLength(3);
  });

  it('never fires a reminder twice', async () => {
    const h = setup({ withListeners: true });
    await h.runtime.init();
    h.handle([remindEffect(localIso(2026, 11, 18, 10, 0))]);
    await flush();
    h.clock.advance(HOUR);
    await flush();
    for (const entry of h.handlers) entry.listener();
    h.clock.advance(DAY);
    await flush();
    expect(h.notification?.state.shown).toHaveLength(1);
    expect(h.effectsStore.getState().notices).toHaveLength(1);
    expect(h.fake.calls.put).toBe(2);
  });

  it('caps one timer at 2147483647 ms and arms again for the rest', async () => {
    const h = setup();
    const due = NOW + 30 * DAY;
    const text = (() => {
      const date = new Date(due);
      return localIso(
        date.getFullYear(),
        date.getMonth() + 1,
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
      );
    })();
    h.handle([remindEffect(text)]);
    await flush();
    const exactDue = h.effectsStore.getState().reminders[0]?.dueAt ?? 0;
    expect(h.clock.delays()).toEqual([MAX_TIMER_MS]);

    h.clock.advance(MAX_TIMER_MS);
    await flush();
    expect(h.effectsStore.getState().reminders[0]?.state).toBe('pending');
    expect(h.clock.delays()).toEqual([exactDue - (NOW + MAX_TIMER_MS)]);

    h.clock.advance(exactDue - (NOW + MAX_TIMER_MS));
    await flush();
    expect(h.effectsStore.getState().reminders[0]?.state).toBe('fired');
  });

  it('survives a repository that fails while saving the fired state', async () => {
    const h = setup({ repo: { putThrows: false } });
    h.handle([remindEffect(localIso(2026, 11, 18, 10, 0))]);
    await flush();
    h.fake.repo.put = () => Promise.reject(new Error('disk full'));
    h.clock.advance(HOUR);
    await flush();
    expect(h.effectsStore.getState().reminders[0]?.state).toBe('fired');
    expect(h.effectsStore.getState().notices).toHaveLength(1);
  });
});

/* ---------- init, listeners, cancel, dispose ---------- */

describe('init', () => {
  it('loads reminders, marks overdue ones missed, persists that and arms the timer', async () => {
    const h = setup({
      repo: {
        initial: [
          reminder('late', NOW - HOUR),
          reminder('exact', NOW),
          reminder('soon', NOW + 2 * HOUR),
          reminder('old-fired', NOW - DAY, 'fired'),
        ],
      },
    });
    await h.runtime.init();

    const byId = Object.fromEntries(
      h.effectsStore.getState().reminders.map((r) => [r.id, r.state]),
    );
    expect(byId).toEqual({
      late: 'missed',
      exact: 'missed',
      soon: 'pending',
      'old-fired': 'fired',
    });
    expect(h.fake.records.get('late')?.state).toBe('missed');
    expect(h.fake.records.get('exact')?.state).toBe('missed');
    expect(h.fake.calls.put).toBe(2);
    expect(h.clock.delays()).toEqual([2 * HOUR]);
    // A missed reminder is listed, not announced.
    expect(h.effectsStore.getState().notices).toEqual([]);
    expect(h.notification?.state.shown).toEqual([]);
  });

  it('loads only once when called twice', async () => {
    const h = setup();
    await Promise.all([h.runtime.init(), h.runtime.init()]);
    await h.runtime.init();
    expect(h.fake.calls.list).toBe(1);
  });

  it('does not throw when the repository throws', async () => {
    const h = setup({ repo: { listThrows: true }, withListeners: true });
    await expect(h.runtime.init()).resolves.toBeUndefined();
    expect(h.effectsStore.getState().reminders).toEqual([]);
    expect(h.handlers).toHaveLength(2);
  });

  it('re-checks on visibilitychange and on focus', async () => {
    const h = setup({ withListeners: true });
    await h.runtime.init();
    expect(h.handlers.map((entry) => entry.type).sort()).toEqual(['focus', 'visibilitychange']);

    h.handle([remindEffect(localIso(2026, 11, 18, 10, 0), 'one')]);
    h.handle([remindEffect(localIso(2026, 11, 18, 12, 0), 'two')]);
    await flush();

    // The tab slept: the clock moved but the throttled timer did not run.
    h.clock.jump(HOUR + MINUTE);
    const visibility = h.handlers.find((entry) => entry.type === 'visibilitychange');
    visibility?.listener();
    await flush();
    expect(h.effectsStore.getState().reminders.map((r) => r.state)).toEqual(['fired', 'pending']);
    expect(h.effectsStore.getState().notices).toHaveLength(1);

    h.clock.jump(2 * HOUR);
    h.handlers.find((entry) => entry.type === 'focus')?.listener();
    await flush();
    expect(h.effectsStore.getState().reminders.map((r) => r.state)).toEqual(['fired', 'fired']);
  });
});

describe('cancelReminder and dismissReminder', () => {
  it('cancels a pending reminder: gone from the list and the repository, timer cleared', async () => {
    const h = setup();
    h.handle([remindEffect(localIso(2026, 11, 18, 10, 0))]);
    await flush();
    const id = h.effectsStore.getState().reminders[0]?.id ?? '';
    expect(h.clock.count()).toBe(1);

    h.runtime.cancelReminder(id);
    await flush();
    expect(h.effectsStore.getState().reminders).toEqual([]);
    expect(h.fake.records.size).toBe(0);
    expect(h.clock.count()).toBe(0);
  });

  it('arms the timer for the next reminder after a cancel', async () => {
    const h = setup();
    h.handle([
      remindEffect(localIso(2026, 11, 18, 10, 0), 'one'),
      remindEffect(localIso(2026, 11, 18, 12, 0), 'two'),
    ]);
    await flush();
    const first = h.effectsStore.getState().reminders[0]?.id ?? '';
    h.runtime.cancelReminder(first);
    expect(h.clock.delays()).toEqual([3 * HOUR]);
  });

  it('removes a fired or missed reminder on dismiss and leaves a pending one', async () => {
    const h = setup({
      repo: {
        initial: [
          reminder('missed-one', NOW - HOUR),
          reminder('pending-one', NOW + HOUR),
          reminder('fired-one', NOW - DAY, 'fired'),
        ],
      },
    });
    await h.runtime.init();

    h.runtime.dismissReminder('pending-one');
    h.runtime.cancelReminder('fired-one');
    expect(h.effectsStore.getState().reminders).toHaveLength(3);

    h.runtime.dismissReminder('missed-one');
    h.runtime.dismissReminder('fired-one');
    await flush();
    expect(h.effectsStore.getState().reminders.map((r) => r.id)).toEqual(['pending-one']);
    expect([...h.fake.records.keys()]).toEqual(['pending-one']);
  });

  it('ignores an unknown id', async () => {
    const h = setup();
    expect(() => {
      h.runtime.cancelReminder('nope');
      h.runtime.dismissReminder('nope');
    }).not.toThrow();
    expect(h.fake.calls.remove).toBe(0);
  });
});

describe('dispose', () => {
  it('clears the timer and removes the listeners', async () => {
    const h = setup({ withListeners: true });
    await h.runtime.init();
    h.handle([remindEffect(localIso(2026, 11, 18, 10, 0))]);
    await flush();
    expect(h.clock.count()).toBe(1);

    h.runtime.dispose();
    expect(h.clock.count()).toBe(0);
    expect(h.handlers.every((entry) => entry.removed)).toBe(true);

    // Nothing fires or starts after dispose.
    h.clock.advance(DAY);
    await flush();
    expect(h.notification?.state.shown).toEqual([]);
    h.handle([remindEffect(localIso(2026, 11, 18, 12, 0))]);
    await flush();
    expect(h.clock.count()).toBe(0);
  });

  it('stops running fields and drops queued ones', async () => {
    const { stack, ids } = stackWithFields(4);
    const gate = gatedProvider();
    const h = setup({ stack, chain: [gate.provider] });
    h.handle(ids.map((id) => fieldEffect(id, stack)));
    await flush();
    expect(gate.provider.calls).toBe(3);

    h.runtime.dispose();
    await flush();
    expect(gate.provider.calls).toBe(3);
    expect(h.effectsStore.getState().running.size).toBe(0);
    expect(h.stackStore.getState().stack).toBe(stack);
    expect(h.clock.count()).toBe(0);
  });

  it('may be started again with init', async () => {
    const h = setup({ withListeners: true, repo: { initial: [reminder('soon', NOW + HOUR)] } });
    await h.runtime.init();
    h.runtime.dispose();
    expect(h.clock.count()).toBe(0);

    await h.runtime.init();
    expect(h.fake.calls.list).toBe(2);
    expect(h.clock.delays()).toEqual([HOUR]);
    expect(h.handlers.filter((entry) => !entry.removed)).toHaveLength(2);
    h.clock.advance(HOUR);
    await flush();
    expect(h.effectsStore.getState().reminders[0]?.state).toBe('fired');
  });

  it('is safe to call twice', () => {
    const h = setup();
    expect(() => {
      h.runtime.dispose();
      h.runtime.dispose();
    }).not.toThrow();
  });
});
