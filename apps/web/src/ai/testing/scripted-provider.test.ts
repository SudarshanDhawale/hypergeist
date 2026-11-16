import { beforeEach, describe, expect, it } from 'vitest';
import { providerError } from '../errors.ts';
import type { ChatRequest, ProviderResult } from '../types.ts';
import {
  createScriptedProvider,
  providerFailure,
  rawToolCall,
  reply,
  resetToolCallIds,
  toolCall,
} from './scripted-provider.ts';

function makeRequest(text = 'hello'): ChatRequest {
  return {
    messages: [{ role: 'user', content: text }],
    meta: { userMessage: text, round: 0, currentCardId: 'c1', selectedObjectId: null },
  };
}

function okReply(result: ProviderResult) {
  if (!result.ok) throw new Error('expected an ok result');
  return result.reply;
}

beforeEach(() => {
  resetToolCallIds();
});

describe('toolCall', () => {
  it('serializes the parameters to JSON text', () => {
    const call = toolCall('add_object', { cardId: 'c1', n: [1, 2] }, 'x');
    expect(call).toEqual({ id: 'x', name: 'add_object', arguments: '{"cardId":"c1","n":[1,2]}' });
    expect(JSON.parse(call.arguments)).toEqual({ cardId: 'c1', n: [1, 2] });
  });

  it('numbers automatic ids from 1 and restarts after resetToolCallIds', () => {
    expect(toolCall('a', {}).id).toBe('call-1');
    expect(toolCall('b', {}).id).toBe('call-2');
    resetToolCallIds();
    expect(toolCall('c', {}).id).toBe('call-1');
  });

  it('an explicit id does not use up a number', () => {
    expect(toolCall('a', {}, 'mine').id).toBe('mine');
    expect(toolCall('b', {}).id).toBe('call-1');
  });
});

describe('rawToolCall', () => {
  it('keeps the arguments text as is, even when it is not JSON', () => {
    expect(rawToolCall('add_object', '{not json', 'r1')).toEqual({
      id: 'r1',
      name: 'add_object',
      arguments: '{not json',
    });
  });

  it('shares the automatic id counter with toolCall', () => {
    expect(toolCall('a', {}).id).toBe('call-1');
    expect(rawToolCall('b', '').id).toBe('call-2');
  });
});

describe('reply', () => {
  it('defaults to an empty stop reply', () => {
    expect(reply()).toEqual({
      ok: true,
      reply: { content: null, toolCalls: [], finishReason: 'stop' },
    });
  });

  it('uses the finish reason tool_calls when calls are present', () => {
    const call = toolCall('say', { text: 'hi' });
    const result = okReply(reply({ calls: [call] }));
    expect(result.toolCalls).toEqual([call]);
    expect(result.finishReason).toBe('tool_calls');
  });

  it('uses stop for content only, and an empty calls list', () => {
    expect(okReply(reply({ content: 'hi' })).finishReason).toBe('stop');
    expect(okReply(reply({ content: 'hi', calls: [] })).finishReason).toBe('stop');
    expect(okReply(reply({ content: 'hi' })).content).toBe('hi');
  });

  it('lets an explicit finish reason win', () => {
    const call = toolCall('say', {});
    expect(okReply(reply({ calls: [call], finishReason: 'length' })).finishReason).toBe('length');
    expect(okReply(reply({ finishReason: 'other' })).finishReason).toBe('other');
  });
});

describe('providerFailure', () => {
  it('returns the error of the code from providerError', () => {
    expect(providerFailure('RATE_LIMITED')).toEqual({
      ok: false,
      error: providerError('RATE_LIMITED'),
    });
  });
});

describe('createScriptedProvider with an array', () => {
  it('has kind recorded by default and takes a kind option', () => {
    expect(createScriptedProvider([]).kind).toBe('recorded');
    expect(createScriptedProvider([], { kind: 'proxy' }).kind).toBe('proxy');
  });

  it('plays the results in order and then answers a plain stop reply', async () => {
    const first = reply({ content: 'one' });
    const second = providerFailure('SERVER');
    const provider = createScriptedProvider([first, second]);

    expect(await provider.chat(makeRequest())).toBe(first);
    expect(await provider.chat(makeRequest())).toBe(second);
    expect(await provider.chat(makeRequest())).toEqual(reply());
    expect(await provider.chat(makeRequest())).toEqual(reply());
    expect(provider.calls).toBe(4);
  });

  it('counts calls from zero', () => {
    expect(createScriptedProvider([]).calls).toBe(0);
    expect(createScriptedProvider([]).requests).toEqual([]);
  });
});

describe('createScriptedProvider with a function', () => {
  it('passes the request and a round counting from 0', async () => {
    const seen: { text: string; round: number }[] = [];
    const provider = createScriptedProvider((request, round) => {
      seen.push({ text: request.meta.userMessage, round });
      return reply({ content: `round ${round}` });
    });

    expect(okReply(await provider.chat(makeRequest('a'))).content).toBe('round 0');
    expect(okReply(await provider.chat(makeRequest('b'))).content).toBe('round 1');
    expect(seen).toEqual([
      { text: 'a', round: 0 },
      { text: 'b', round: 1 },
    ]);
  });

  it('accepts a function that returns a promise', async () => {
    const provider = createScriptedProvider(async (_request, round) => {
      await Promise.resolve();
      return reply({ content: `late ${round}` });
    });
    expect(okReply(await provider.chat(makeRequest())).content).toBe('late 0');
  });

  it('can answer from what the request contains', async () => {
    const provider = createScriptedProvider((request) =>
      request.meta.userMessage === 'fail' ? providerFailure('AUTH') : reply({ content: 'fine' }),
    );
    expect((await provider.chat(makeRequest('fail'))).ok).toBe(false);
    expect((await provider.chat(makeRequest('other'))).ok).toBe(true);
  });
});

describe('request recording', () => {
  it('records every request in order', async () => {
    const provider = createScriptedProvider([]);
    await provider.chat(makeRequest('a'));
    await provider.chat(makeRequest('b'));
    expect(provider.requests.map((request) => request.meta.userMessage)).toEqual(['a', 'b']);
    expect(provider.calls).toBe(2);
  });

  it('keeps a deep copy, so later changes to the original do not reach the record', async () => {
    const provider = createScriptedProvider([]);
    const request = {
      messages: [{ role: 'user' as const, content: 'before' }],
      meta: { userMessage: 'before', round: 0, currentCardId: null, selectedObjectId: null },
    };
    await provider.chat(request);

    // Mutate through a loosened view; the tests are the one place that does this on purpose.
    const loose = request as {
      messages: { content: string }[];
      meta: { userMessage: string };
    };
    const [firstMessage] = loose.messages;
    if (firstMessage === undefined) throw new Error('the request has one message');
    firstMessage.content = 'after';
    loose.messages.push({ content: 'extra' });
    loose.meta.userMessage = 'after';

    expect(provider.requests[0]).toEqual({
      messages: [{ role: 'user', content: 'before' }],
      meta: { userMessage: 'before', round: 0, currentCardId: null, selectedObjectId: null },
    });
    expect(provider.requests[0]).not.toBe(request);
  });
});

describe('abort', () => {
  it('returns ABORTED for an already aborted signal, without recording or calling the script', async () => {
    let scriptRuns = 0;
    const provider = createScriptedProvider(() => {
      scriptRuns += 1;
      return reply();
    });
    const controller = new AbortController();
    controller.abort();

    const result = await provider.chat(makeRequest(), controller.signal);
    expect(result).toEqual({ ok: false, error: providerError('ABORTED') });
    expect(scriptRuns).toBe(0);
    expect(provider.calls).toBe(0);
    expect(provider.requests).toEqual([]);
  });

  it('does not use up a script entry when the signal is already aborted', async () => {
    const provider = createScriptedProvider([reply({ content: 'first' })]);
    const controller = new AbortController();
    controller.abort();
    await provider.chat(makeRequest(), controller.signal);
    expect(okReply(await provider.chat(makeRequest())).content).toBe('first');
  });

  it('returns ABORTED when the signal fires while a function script is pending', async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const provider = createScriptedProvider(
      () =>
        new Promise<ProviderResult>((resolve) => {
          release = () => {
            resolve(reply({ content: 'too late' }));
          };
        }),
    );

    const pending = provider.chat(makeRequest(), controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: providerError('ABORTED') });
    // The request was seen before the abort, so it stays recorded.
    expect(provider.calls).toBe(1);
    release?.();
  });

  it('does not touch a result that arrives before an abort', async () => {
    const controller = new AbortController();
    const provider = createScriptedProvider(async () => reply({ content: 'in time' }));
    const result = await provider.chat(makeRequest(), controller.signal);
    expect(okReply(result).content).toBe('in time');
    controller.abort();
  });

  it('returns ABORTED when the script itself aborts the signal while it runs', async () => {
    const controller = new AbortController();
    const provider = createScriptedProvider(() => {
      controller.abort();
      return reply({ content: 'ignored' });
    });
    expect(await provider.chat(makeRequest(), controller.signal)).toEqual({
      ok: false,
      error: providerError('ABORTED'),
    });
  });
});
