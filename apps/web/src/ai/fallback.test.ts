import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { deepFreeze } from '../../../../packages/shared/test-support/freeze.ts';
import thinSliceText from '../stacks/thin-slice-todo.json?raw';
import { providerError } from './errors.ts';
import { chooseProviderChain, demoNote, runTurnWithFallback } from './fallback.ts';
import type { FallbackTurnResult } from './fallback.ts';
import { loadScenarios } from './scenario-set.ts';
import type { Scenario } from './scenario-set.ts';
import type { TurnInput } from './turn.ts';
import type { Provider, ProviderErrorCode, ProviderKind } from './types.ts';
import {
  createScriptedProvider,
  providerFailure,
  reply,
  resetToolCallIds,
  toolCall,
} from './testing/scripted-provider.ts';
import type { Script } from './testing/scripted-provider.ts';

/* ---------- fixtures and helpers ---------- */

function loadThinSlice(): Stack {
  const parsed = parseStack(JSON.parse(thinSliceText));
  if (!parsed.ok) throw new Error('the thin-slice stack must be valid');
  return parsed.value;
}

const THIN: Stack = loadThinSlice();
const SCENARIOS: readonly Scenario[] = loadScenarios().scenarios;

type RunOptions = Partial<Omit<TurnInput, 'provider'>>;

function baseInput(options: RunOptions = {}): Omit<TurnInput, 'provider'> {
  return {
    stack: THIN,
    currentCardId: 'todo',
    selectedObjectId: null,
    userMessage: 'Add a note card',
    history: [],
    newStack: false,
    jsonMode: false,
    clock: () => 0,
    ...options,
  };
}

function scripted(kind: ProviderKind, script: Script) {
  return createScriptedProvider(script, { kind });
}

/** A provider that fails with `code` on every request (also the JSON-mode retry). */
function failing(kind: ProviderKind, code: ProviderErrorCode) {
  return scripted(kind, () => providerFailure(code));
}

/** A provider whose first round is a clean answer with one accepted `create_card`. */
function answering(kind: ProviderKind) {
  return scripted(kind, [
    reply({ calls: [toolCall('create_card', { name: 'Notes', id: 'notes' })] }),
    reply({ content: 'Added a card.' }),
  ]);
}

/** A call the engine rejects: the card does not exist. */
function badCall() {
  return toolCall('add_object', {
    cardId: 'no-such-card',
    type: 'field',
    x: 0,
    y: 0,
    width: 40,
    height: 20,
  });
}

function cardIds(stack: Stack): string[] {
  return stack.cards.map((card) => card.id);
}

beforeEach(() => {
  resetToolCallIds();
});

/** Codes after which the next provider is tried, and codes after which it is not. */
const FALLBACK_CODES: readonly ProviderErrorCode[] = [
  'RATE_LIMITED',
  'QUOTA',
  'NETWORK',
  'SERVER',
  'TIMEOUT',
  'BAD_REPLY',
  'CORS_OR_OFFLINE',
];
const NO_FALLBACK_CODES: readonly ProviderErrorCode[] = [
  'AUTH',
  'ABORTED',
  'MODEL_NOT_FOUND',
  'BAD_REQUEST',
  'DEMO_ONLY',
];

/* ---------- chooseProviderChain ---------- */

describe('chooseProviderChain', () => {
  const noFetch = vi.fn(() => {
    throw new Error('the network must not be used');
  }) as unknown as typeof fetch;
  const KEY = 'sk-test-DISTINCTIVE-key-1a2b3c4d5e';

  function choose(
    settings: { provider: 'demo' | 'own'; baseUrl: string; model: string },
    getKey: () => string | undefined = () => KEY,
    fetchFn: typeof fetch = noFetch,
  ) {
    return chooseProviderChain({ settings, getKey, fetch: fetchFn, scenarios: SCENARIOS });
  }

  it('gives [direct] for own settings that are complete', () => {
    const chosen = choose({ provider: 'own', baseUrl: 'https://api.example.test/v1/', model: 'm' });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    expect(chosen.label).toBe('own');
    expect(chosen.chain.map((p) => p.kind)).toEqual(['direct']);
  });

  it('gives [proxy, recorded] for demo, whatever the own fields hold', () => {
    const chosen = choose({ provider: 'demo', baseUrl: '', model: '' }, () => undefined);
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    expect(chosen.label).toBe('demo');
    expect(chosen.chain.map((p) => p.kind)).toEqual(['proxy', 'recorded']);
  });

  it('refuses own settings with an invalid base URL and says why', () => {
    const chosen = choose({ provider: 'own', baseUrl: 'http://example.test/v1', model: 'm' });
    expect(chosen.ok).toBe(false);
    if (chosen.ok) return;
    expect(chosen.message).toContain('localhost');
    expect(chosen.message).not.toContain(KEY);
  });

  it('refuses own settings with no key, including a blank key', () => {
    const settings = {
      provider: 'own',
      baseUrl: 'https://api.example.test/v1',
      model: 'm',
    } as const;
    for (const getKey of [() => undefined, () => '   ']) {
      const chosen = choose(settings, getKey);
      expect(chosen).toEqual({ ok: false, message: 'Enter a key to use your own model.' });
    }
  });

  it('refuses own settings with a blank model', () => {
    const chosen = choose({ provider: 'own', baseUrl: 'https://api.example.test/v1', model: '  ' });
    expect(chosen).toEqual({ ok: false, message: 'Enter a model name to use your own model.' });
  });

  it('names everything that is missing in one sentence', () => {
    expect(choose({ provider: 'own', baseUrl: '', model: '' }, () => undefined)).toEqual({
      ok: false,
      message: 'Enter a base URL, a model name and a key to use your own model.',
    });
    expect(choose({ provider: 'own', baseUrl: '', model: 'm' }, () => undefined)).toEqual({
      ok: false,
      message: 'Enter a base URL and a key to use your own model.',
    });
  });

  it('builds providers without touching the network or reading the key into a result', () => {
    const chosen = choose({ provider: 'own', baseUrl: 'https://api.example.test/v1', model: 'm' });
    expect(chosen.ok).toBe(true);
    expect(JSON.stringify(chosen)).not.toContain(KEY);
    expect(noFetch).not.toHaveBeenCalled();
  });

  it('sends the demo proxy request to proxyEndpoint when given', async () => {
    const urls: string[] = [];
    const fetchFn = ((input: string | URL | Request) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 500 }));
    }) as typeof fetch;
    const chosen = chooseProviderChain({
      settings: { provider: 'demo', baseUrl: '', model: '' },
      getKey: () => undefined,
      fetch: fetchFn,
      scenarios: SCENARIOS,
      proxyEndpoint: '/custom/chat',
    });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    const proxy = chosen.chain[0];
    expect(proxy?.kind).toBe('proxy');
    await proxy?.chat({
      messages: [{ role: 'user', content: 'hi' }],
      meta: { userMessage: 'hi', round: 0, currentCardId: null, selectedObjectId: null },
    });
    expect(urls).toEqual(['/custom/chat']);
  });
});

/* ---------- runTurnWithFallback: when it falls back ---------- */

describe('runTurnWithFallback falls back', () => {
  it.each(FALLBACK_CODES)('after %s, and the next provider answers', async (code) => {
    const first = failing('proxy', code);
    const second = answering('recorded');
    const result = await runTurnWithFallback([first, second], baseInput());
    expect(first.calls).toBe(1);
    expect(second.calls).toBeGreaterThan(0);
    expect(result.status).toBe('done');
    expect(result.providerKind).toBe('recorded');
    expect(cardIds(result.after)).toContain('notes');
    expect(result.fallback).toEqual({ from: 'proxy', to: 'recorded', error: providerError(code) });
  });

  it('also when the first Turn only had rejected steps', async () => {
    const first = scripted('proxy', [reply({ calls: [badCall()] }), providerFailure('SERVER')]);
    const second = answering('recorded');
    const result = await runTurnWithFallback([first, second], baseInput());
    expect(first.calls).toBe(2);
    expect(result.fallback?.error.code).toBe('SERVER');
    expect(result.status).toBe('done');
  });

  it('runs the whole Turn again from the original stack and input', async () => {
    const first = scripted('proxy', [reply({ calls: [badCall()] }), providerFailure('TIMEOUT')]);
    const second = answering('recorded');
    const input = baseInput({
      selectedObjectId: 'todo-title',
      history: [
        { role: 'user', text: 'Hello there' },
        { role: 'assistant', text: 'Hi, how can I help?' },
      ],
    });
    await runTurnWithFallback([first, second], input);
    const firstRequest = first.requests[0];
    const secondRequest = second.requests[0];
    expect(firstRequest).toBeDefined();
    expect(secondRequest).toEqual(firstRequest);
    expect(secondRequest?.meta.round).toBe(0);
    expect(secondRequest?.meta.currentCardId).toBe('todo');
    expect(secondRequest?.meta.selectedObjectId).toBe('todo-title');
  });

  it('passes history, limits and the message through to the next provider', async () => {
    const first = failing('proxy', 'RATE_LIMITED');
    const second = scripted('recorded', [
      reply({ calls: [toolCall('create_card', { name: 'A', id: 'a' })] }),
      reply({ calls: [toolCall('create_card', { name: 'B', id: 'b' })] }),
    ]);
    const result = await runTurnWithFallback(
      [first, second],
      baseInput({
        userMessage: 'Please add two cards',
        history: [{ role: 'user', text: 'EARLIER-MESSAGE' }],
        limits: { maxRequests: 1 },
      }),
    );
    const request = second.requests[0];
    expect(request?.meta.userMessage).toBe('Please add two cards');
    expect(JSON.stringify(request?.messages)).toContain('EARLIER-MESSAGE');
    expect(second.calls).toBe(1);
    expect(result.stopReason).toBe('limit-requests');
    expect(result.status).toBe('partial');
    expect(cardIds(result.after)).toContain('a');
    expect(cardIds(result.after)).not.toContain('b');
  });

  it('takes every field from the final run and leaks nothing of the first', async () => {
    const first = scripted('proxy', [reply({ calls: [badCall()] }), providerFailure('SERVER')]);
    const second = answering('recorded');
    const result = await runTurnWithFallback([first, second], baseInput());
    expect(result.providerKind).toBe('recorded');
    expect(result.rounds).toBe(second.calls);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.tool).toBe('create_card');
    expect(result.steps.every((step) => step.ok)).toBe(true);
    expect(result.say).toEqual(['Added a card.']);
    expect(result.before).toBe(THIN);
    expect(result.error).toBeUndefined();
  });

  it('takes usedJsonMode from the final run', async () => {
    const first = failing('proxy', 'SERVER');
    // The second provider rejects tools, so its Turn switches to JSON mode, then fails.
    const second = scripted('recorded', [
      providerFailure('BAD_REQUEST'),
      providerFailure('SERVER'),
    ]);
    const result = await runTurnWithFallback([first, second], baseInput());
    expect(result.usedJsonMode).toBe(true);
    expect(result.providerKind).toBe('recorded');
    expect(result.fallback?.from).toBe('proxy');
  });

  it('keeps before as null when the Turn starts a new stack', async () => {
    const first = failing('proxy', 'NETWORK');
    const second = answering('recorded');
    const result = await runTurnWithFallback([first, second], baseInput({ newStack: true }));
    expect(result.before).toBeNull();
    expect(result.fallback).toBeDefined();
  });

  it('does not change or throw on a frozen input', async () => {
    const input = baseInput({ history: [{ role: 'user', text: 'earlier' }] });
    deepFreeze(input.stack);
    deepFreeze(input.history);
    const result = await runTurnWithFallback(
      [failing('proxy', 'SERVER'), answering('recorded')],
      input,
    );
    expect(result.status).toBe('done');
    expect(cardIds(THIN)).not.toContain('notes');
  });
});

/* ---------- runTurnWithFallback: when it does not ---------- */

describe('runTurnWithFallback does not fall back', () => {
  it.each(NO_FALLBACK_CODES)('after %s', async (code) => {
    const first = failing('proxy', code);
    const second = answering('recorded');
    const result = await runTurnWithFallback([first, second], baseInput());
    expect(second.calls).toBe(0);
    expect(result.fallback).toBeUndefined();
    expect('fallback' in result).toBe(false);
    expect(result.providerKind).toBe('proxy');
    expect(result.after).toBe(THIN);
    if (code === 'ABORTED') {
      expect(result.status).toBe('aborted');
    } else {
      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe(code);
    }
  });

  it('after accepted steps, even when the error is transient', async () => {
    const first = scripted('proxy', [
      reply({ calls: [toolCall('create_card', { name: 'Kept', id: 'kept' })] }),
      providerFailure('SERVER'),
    ]);
    const second = answering('recorded');
    const result = await runTurnWithFallback([first, second], baseInput());
    expect(second.calls).toBe(0);
    expect(result.fallback).toBeUndefined();
    expect(result.status).toBe('partial');
    expect(result.stopReason).toBe('provider-error');
    expect(cardIds(result.after)).toContain('kept');
  });

  it('when the first provider succeeds', async () => {
    const first = answering('proxy');
    const second = answering('recorded');
    const result = await runTurnWithFallback([first, second], baseInput());
    expect(second.calls).toBe(0);
    expect(result.fallback).toBeUndefined();
    expect(result.providerKind).toBe('proxy');
  });

  it('for a chain of one, even after a transient error', async () => {
    const only = failing('direct', 'RATE_LIMITED');
    const result = await runTurnWithFallback([only], baseInput());
    expect(only.calls).toBe(1);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('RATE_LIMITED');
    expect(result.fallback).toBeUndefined();
  });

  it('for the own-key chain from chooseProviderChain', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response('{}', { status: 503 })),
    ) as unknown as typeof fetch;
    const chosen = chooseProviderChain({
      settings: { provider: 'own', baseUrl: 'https://api.example.test/v1', model: 'm' },
      getKey: () => 'sk-test-own-key-123456',
      fetch: fetchFn,
      scenarios: SCENARIOS,
    });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    const result = await runTurnWithFallback(chosen.chain, baseInput());
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('SERVER');
    expect(result.providerKind).toBe('direct');
    expect(result.fallback).toBeUndefined();
    expect(demoNote(result)).toBeNull();
  });

  it('when the caller has aborted, even if the provider ignored the signal', async () => {
    const controller = new AbortController();
    const second = answering('recorded');
    const stubborn: Provider = {
      kind: 'proxy',
      chat() {
        controller.abort();
        return Promise.resolve(providerFailure('NETWORK'));
      },
    };
    const result = await runTurnWithFallback(
      [stubborn, second],
      baseInput({ signal: controller.signal }),
    );
    expect(second.calls).toBe(0);
    expect(result.fallback).toBeUndefined();
  });
});

/* ---------- runTurnWithFallback: chain ends ---------- */

describe('runTurnWithFallback at the end of the chain', () => {
  it('stops at the last provider and reports its failure with the fallback attached', async () => {
    const first = failing('proxy', 'RATE_LIMITED');
    const second = failing('recorded', 'SERVER');
    const result = await runTurnWithFallback([first, second], baseInput());
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('SERVER');
    expect(result.providerKind).toBe('recorded');
    expect(result.after).toBe(THIN);
    expect(result.fallback).toEqual({
      from: 'proxy',
      to: 'recorded',
      error: providerError('RATE_LIMITED'),
    });
  });

  it('walks a longer chain and describes the last hop only', async () => {
    const a = failing('proxy', 'NETWORK');
    const b = failing('direct', 'TIMEOUT');
    const c = answering('recorded');
    const result = await runTurnWithFallback([a, b, c], baseInput());
    expect([a.calls, b.calls].every((n) => n === 1)).toBe(true);
    expect(result.status).toBe('done');
    expect(result.fallback).toEqual({
      from: 'direct',
      to: 'recorded',
      error: providerError('TIMEOUT'),
    });
  });

  it('stops a longer chain at a code that never falls back', async () => {
    const a = failing('proxy', 'NETWORK');
    const b = failing('direct', 'AUTH');
    const c = answering('recorded');
    const result = await runTurnWithFallback([a, b, c], baseInput());
    expect(c.calls).toBe(0);
    expect(result.error?.code).toBe('AUTH');
    expect(result.fallback?.to).toBe('direct');
  });

  it('answers an empty chain with a failed result and no request', async () => {
    const result = await runTurnWithFallback([], baseInput());
    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('provider-error');
    expect(result.error).toEqual(providerError('BAD_REQUEST'));
    expect(result.after).toBe(THIN);
    expect(result.before).toBe(THIN);
    expect(result.steps).toEqual([]);
    expect(result.rounds).toBe(0);
    expect(result.fallback).toBeUndefined();
    const fresh = await runTurnWithFallback([], baseInput({ newStack: true }));
    expect(fresh.before).toBeNull();
    expect(fresh.after).toBe(THIN);
  });
});

/* ---------- with the real providers ---------- */

describe('the demo chain end to end', () => {
  function demoChain(status: number, body: unknown) {
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    ) as unknown as typeof fetch;
    const chosen = chooseProviderChain({
      settings: { provider: 'demo', baseUrl: '', model: '' },
      getKey: () => undefined,
      fetch: fetchFn,
      scenarios: SCENARIOS,
    });
    if (!chosen.ok) throw new Error('the demo chain must be available');
    return { chain: chosen.chain, fetchFn };
  }

  it('answers a recorded example when the proxy is rate limited', async () => {
    const { chain, fetchFn } = demoChain(429, { error: { code: 'RATE_LIMITED' } });
    const result = await runTurnWithFallback(chain, baseInput({ userMessage: 'Add a button' }));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('done');
    expect(result.providerKind).toBe('recorded');
    expect(result.fallback?.from).toBe('proxy');
    expect(result.fallback?.to).toBe('recorded');
    expect(result.fallback?.error.code).toBe('RATE_LIMITED');
    const before = THIN.cards.find((card) => card.id === 'todo')?.objects.length ?? 0;
    const after = result.after.cards.find((card) => card.id === 'todo')?.objects.length ?? 0;
    expect(after).toBe(before + 1);
    expect(demoNote(result)).toBe(
      'The shared demo model is busy, so this answer is a recorded example.',
    );
  });

  it('answers the example list for an unknown prompt, without changing the stack', async () => {
    const { chain } = demoChain(500, {});
    const result = await runTurnWithFallback(chain, baseInput({ userMessage: 'Do something odd' }));
    expect(result.status).toBe('done');
    expect(result.providerKind).toBe('recorded');
    expect(result.after).toBe(THIN);
    expect(result.say.join(' ')).toContain('Add a button');
    expect(demoNote(result)).toBe(
      'The demo model could not be reached, so this answer is a recorded example.',
    );
  });
});

/* ---------- demoNote ---------- */

describe('demoNote', () => {
  const BUSY = 'The shared demo model is busy, so this answer is a recorded example.';
  const UNREACHABLE = 'The demo model could not be reached, so this answer is a recorded example.';

  async function fellBack(code: ProviderErrorCode): Promise<FallbackTurnResult> {
    return runTurnWithFallback([failing('proxy', code), answering('recorded')], baseInput());
  }

  it.each([
    ['RATE_LIMITED', BUSY],
    ['QUOTA', BUSY],
    ['NETWORK', UNREACHABLE],
    ['CORS_OR_OFFLINE', UNREACHABLE],
    ['TIMEOUT', UNREACHABLE],
    ['SERVER', UNREACHABLE],
    ['BAD_REPLY', UNREACHABLE],
  ] as const)('gives a plain sentence for a fallback after %s', async (code, sentence) => {
    expect(demoNote(await fellBack(code))).toBe(sentence);
  });

  it('is null when there was no fallback', async () => {
    const proxyAnswer = await runTurnWithFallback([answering('proxy')], baseInput());
    expect(demoNote(proxyAnswer)).toBeNull();
    const failed = await runTurnWithFallback([failing('proxy', 'AUTH')], baseInput());
    expect(demoNote(failed)).toBeNull();
  });

  it('is null for a recorded answer that was not a fallback', async () => {
    const result = await runTurnWithFallback([answering('recorded')], baseInput());
    expect(result.providerKind).toBe('recorded');
    expect(demoNote(result)).toBeNull();
  });

  it('is null for a fallback that is not proxy to recorded', async () => {
    const result = await runTurnWithFallback(
      [failing('direct', 'SERVER'), answering('proxy')],
      baseInput(),
    );
    expect(result.fallback?.from).toBe('direct');
    expect(demoNote(result)).toBeNull();
  });
});
