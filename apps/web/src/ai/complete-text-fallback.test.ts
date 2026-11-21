import { describe, expect, it } from 'vitest';
import { providerError } from './errors.ts';
import { completeTextWithFallback } from './complete-text-fallback.ts';
import { demoNote } from './fallback.ts';
import { createRecordedProvider } from './recorded-provider.ts';
import { loadScenarios } from './scenario-set.ts';
import { createScriptedProvider, providerFailure, reply } from './testing/scripted-provider.ts';
import type { Provider, ProviderErrorCode, ProviderKind } from './types.ts';

const ARGS = {
  prompt: 'Summarize my notes',
  inputs: [{ objectId: 'n', name: 'Notes', text: 'Milk' }],
};

function failing(kind: ProviderKind, code: ProviderErrorCode) {
  return createScriptedProvider(() => providerFailure(code), { kind });
}

function answering(kind: ProviderKind, text = 'A summary.') {
  return createScriptedProvider([reply({ content: text })], { kind });
}

describe('completeTextWithFallback', () => {
  it('returns the first answer without fallback', async () => {
    const first = answering('proxy');
    const second = answering('recorded', 'Other');
    const out = await completeTextWithFallback([first, second], ARGS);
    expect(out.result).toEqual({ ok: true, text: 'A summary.', truncated: false });
    expect(out.fallback).toBeUndefined();
    expect('fallback' in out).toBe(false);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
    expect(demoNote(out)).toBeNull();
  });

  it('falls back from a proxy error to the recorded answer and gives the demo note', async () => {
    const proxy = failing('proxy', 'RATE_LIMITED');
    const recorded = answering('recorded', 'Recorded text.');
    const out = await completeTextWithFallback([proxy, recorded], ARGS);
    expect(out.result).toEqual({ ok: true, text: 'Recorded text.', truncated: false });
    expect(out.fallback).toEqual({
      from: 'proxy',
      to: 'recorded',
      error: providerError('RATE_LIMITED'),
    });
    expect(demoNote(out)).toBe(
      'The shared demo model is busy, so this answer is a recorded example.',
    );
    // The next provider got the original arguments.
    expect(recorded.requests[0]).toEqual(proxy.requests[0]);
  });

  it.each(['NETWORK', 'SERVER', 'TIMEOUT', 'BAD_REPLY', 'CORS_OR_OFFLINE', 'QUOTA'] as const)(
    'falls back after %s',
    async (code) => {
      const out = await completeTextWithFallback(
        [failing('proxy', code), answering('recorded')],
        ARGS,
      );
      expect(out.result.ok).toBe(true);
      expect(out.fallback?.error.code).toBe(code);
      expect(demoNote(out)).not.toBeNull();
    },
  );

  it.each(['AUTH', 'ABORTED', 'BAD_REQUEST', 'DEMO_ONLY', 'MODEL_NOT_FOUND'] as const)(
    'does not fall back after %s',
    async (code) => {
      const second = answering('recorded');
      const out = await completeTextWithFallback([failing('proxy', code), second], ARGS);
      expect(out.result).toEqual({ ok: false, error: providerError(code) });
      expect(out.fallback).toBeUndefined();
      expect(second.calls).toBe(0);
      expect(demoNote(out)).toBeNull();
    },
  );

  it('does not fall back when the signal is aborted, even if the provider ignored it', async () => {
    const controller = new AbortController();
    const stubborn: Provider = {
      kind: 'proxy',
      chat() {
        controller.abort();
        return Promise.resolve(providerFailure('NETWORK'));
      },
    };
    const second = answering('recorded');
    const out = await completeTextWithFallback([stubborn, second], {
      ...ARGS,
      signal: controller.signal,
    });
    expect(out.result.ok).toBe(false);
    expect(out.fallback).toBeUndefined();
    expect(second.calls).toBe(0);
  });

  it('does not send a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const first = answering('proxy');
    const second = answering('recorded');
    const out = await completeTextWithFallback([first, second], {
      ...ARGS,
      signal: controller.signal,
    });
    expect(out.result).toEqual({ ok: false, error: providerError('ABORTED') });
    expect(first.calls + second.calls).toBe(0);
  });

  it('keeps the fallback when the last provider also fails', async () => {
    const out = await completeTextWithFallback(
      [failing('proxy', 'SERVER'), failing('recorded', 'BAD_REPLY')],
      ARGS,
    );
    expect(out.result).toEqual({ ok: false, error: providerError('BAD_REPLY') });
    expect(out.fallback).toEqual({
      from: 'proxy',
      to: 'recorded',
      error: providerError('SERVER'),
    });
  });

  it('tries each provider of a longer chain in order', async () => {
    const out = await completeTextWithFallback(
      [failing('direct', 'SERVER'), failing('proxy', 'NETWORK'), answering('recorded')],
      ARGS,
    );
    expect(out.result.ok).toBe(true);
    expect(out.fallback).toEqual({
      from: 'proxy',
      to: 'recorded',
      error: providerError('NETWORK'),
    });
  });

  it('stops at the first error that does not allow a fallback', async () => {
    const third = answering('recorded');
    const out = await completeTextWithFallback(
      [failing('direct', 'SERVER'), failing('proxy', 'AUTH'), third],
      ARGS,
    );
    expect(out.result).toEqual({ ok: false, error: providerError('AUTH') });
    expect(out.fallback?.to).toBe('proxy');
    expect(third.calls).toBe(0);
  });

  it('uses the recorded provider in a real demo chain (no match is DEMO_ONLY)', async () => {
    const recorded = createRecordedProvider(loadScenarios().scenarios);
    const out = await completeTextWithFallback([failing('proxy', 'SERVER'), recorded], ARGS);
    expect(out.result).toEqual({ ok: false, error: providerError('DEMO_ONLY') });
    expect(out.fallback?.from).toBe('proxy');
  });

  it('treats a provider that throws as NETWORK and falls back', async () => {
    const throwing: Provider = {
      kind: 'proxy',
      chat() {
        throw new Error('boom');
      },
    };
    const rejecting: Provider = {
      kind: 'proxy',
      chat() {
        return Promise.reject(new Error('boom'));
      },
    };
    for (const broken of [throwing, rejecting]) {
      const out = await completeTextWithFallback([broken, answering('recorded')], ARGS);
      expect(out.result.ok).toBe(true);
      expect(out.fallback?.error.code).toBe('NETWORK');
    }
    const alone = await completeTextWithFallback([throwing], ARGS);
    expect(alone.result).toEqual({ ok: false, error: providerError('NETWORK') });
    expect(alone.fallback).toBeUndefined();
  });

  it('gives BAD_REQUEST for an empty chain and for a bad prompt, with no request', async () => {
    const empty = await completeTextWithFallback([], ARGS);
    expect(empty).toEqual({ result: { ok: false, error: providerError('BAD_REQUEST') } });

    const first = answering('proxy');
    const second = answering('recorded');
    const bad = await completeTextWithFallback([first, second], { ...ARGS, prompt: '' });
    expect(bad.result).toEqual({ ok: false, error: providerError('BAD_REQUEST') });
    expect(first.calls + second.calls).toBe(0);
  });

  it('does not change its arguments', async () => {
    const args = {
      prompt: 'Summarize',
      inputs: [{ objectId: 'n', name: 'Notes', text: 'Milk' }],
    };
    const copy = structuredClone(args);
    Object.freeze(args.inputs[0]);
    Object.freeze(args.inputs);
    Object.freeze(args);
    await completeTextWithFallback([failing('proxy', 'SERVER'), answering('recorded')], args);
    expect(args).toEqual(copy);
  });
});
