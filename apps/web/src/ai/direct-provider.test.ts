import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_ERROR_CODES, errorFromHttp, providerError } from './errors.ts';
import { createDirectProvider } from './direct-provider.ts';
import type { ChatRequest, ProviderErrorCode, ProviderResult } from './types.ts';

const KEY = 'sk-test-DISTINCTIVE-key-9f8e7d6c5b4a';
const BASE = 'https://api.example.test/v1';

const REQUEST: ChatRequest = {
  messages: [
    { role: 'system', content: 'You edit stacks.' },
    { role: 'user', content: 'add a card' },
  ],
  meta: { userMessage: 'add a card', round: 0, currentCardId: 'c1', selectedObjectId: null },
};

const GOOD_BODY = {
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [
          {
            id: 't1',
            type: 'function',
            function: { name: 'create_card', arguments: '{"id":"c2"}' },
          },
        ],
      },
    },
  ],
};

type FetchCall = { readonly url: string; readonly init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A fake fetch that records its calls and answers with `answer`. */
function fakeFetch(answer: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(answer(call));
  });
  return { fetch: fn as unknown as typeof fetch, calls, fn };
}

function make(
  fetchFn: typeof fetch,
  extra: Partial<Parameters<typeof createDirectProvider>[0]> = {},
) {
  return createDirectProvider({
    baseUrl: BASE,
    model: 'test-model',
    getKey: () => KEY,
    fetch: fetchFn,
    ...extra,
  });
}

function errorCode(result: ProviderResult): ProviderErrorCode {
  if (result.ok) throw new Error('expected an error result');
  return result.error.code;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createDirectProvider: request', () => {
  it('has kind direct', () => {
    expect(make(fakeFetch(() => jsonResponse(GOOD_BODY)).fetch).kind).toBe('direct');
  });

  it('posts to <base>/chat/completions', async () => {
    const f = fakeFetch(() => jsonResponse(GOOD_BODY));
    await make(f.fetch).chat(REQUEST);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(`${BASE}/chat/completions`);
    expect(f.calls[0]?.init.method).toBe('POST');
  });

  it('strips trailing slashes from the base URL', async () => {
    const f = fakeFetch(() => jsonResponse(GOOD_BODY));
    await make(f.fetch, { baseUrl: `${BASE}/` }).chat(REQUEST);
    await make(f.fetch, { baseUrl: `${BASE}///` }).chat(REQUEST);
    expect(f.calls.map((c) => c.url)).toEqual([
      `${BASE}/chat/completions`,
      `${BASE}/chat/completions`,
    ]);
  });

  it('sends content-type and authorization, and no other header carries the key', async () => {
    const f = fakeFetch(() => jsonResponse(GOOD_BODY));
    await make(f.fetch).chat(REQUEST);
    const headers = f.calls[0]?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(Object.keys(headers).sort()).toEqual(['authorization', 'content-type']);
    for (const [name, value] of Object.entries(headers)) {
      if (name !== 'authorization') expect(value).not.toContain(KEY);
    }
  });

  it('sets redirect error and credentials omit', async () => {
    const f = fakeFetch(() => jsonResponse(GOOD_BODY));
    await make(f.fetch).chat(REQUEST);
    expect(f.calls[0]?.init.redirect).toBe('error');
    expect(f.calls[0]?.init.credentials).toBe('omit');
  });

  it('puts the model and wire fields in the body and never the key', async () => {
    const f = fakeFetch(() => jsonResponse(GOOD_BODY));
    await make(f.fetch, { maxTokens: 512 }).chat(REQUEST);
    const rawBody = f.calls[0]?.init.body;
    expect(typeof rawBody).toBe('string');
    const body = JSON.parse(String(rawBody)) as Record<string, unknown>;
    expect(body['model']).toBe('test-model');
    expect(body['stream']).toBe(false);
    expect(body['max_tokens']).toBe(512);
    expect(body).not.toHaveProperty('meta');
    expect(String(rawBody)).not.toContain(KEY);
  });

  it('never puts the key in the URL', async () => {
    const f = fakeFetch(() => jsonResponse(GOOD_BODY));
    await make(f.fetch).chat(REQUEST);
    expect(f.calls[0]?.url).not.toContain(KEY);
  });

  it('reads the key through getKey at fetch time', async () => {
    let current: string | undefined = 'sk-first-aaaaaaaa';
    const f = fakeFetch(() => jsonResponse(GOOD_BODY));
    const provider = make(f.fetch, { getKey: () => current });
    await provider.chat(REQUEST);
    current = 'sk-second-bbbbbbbb';
    await provider.chat(REQUEST);
    const auth = f.calls.map((c) => (c.init.headers as Record<string, string>)['authorization']);
    expect(auth).toEqual(['Bearer sk-first-aaaaaaaa', 'Bearer sk-second-bbbbbbbb']);
  });
});

describe('createDirectProvider: missing key', () => {
  it.each([undefined, '', '   '])('gives AUTH without a fetch for key %j', async (key) => {
    const f = fakeFetch(() => jsonResponse(GOOD_BODY));
    const result = await make(f.fetch, { getKey: () => key }).chat(REQUEST);
    expect(result).toEqual({ ok: false, error: providerError('AUTH') });
    expect(f.fn).not.toHaveBeenCalled();
  });
});

describe('createDirectProvider: successful reply', () => {
  it('returns a reply with tool calls', async () => {
    const f = fakeFetch(() => jsonResponse(GOOD_BODY));
    const result = await make(f.fetch).chat(REQUEST);
    expect(result).toEqual({
      ok: true,
      reply: {
        content: null,
        toolCalls: [{ id: 't1', name: 'create_card', arguments: '{"id":"c2"}' }],
        finishReason: 'tool_calls',
      },
    });
  });

  it('returns a text-only reply', async () => {
    const f = fakeFetch(() =>
      jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }] }),
    );
    const result = await make(f.fetch).chat(REQUEST);
    expect(result).toEqual({
      ok: true,
      reply: { content: 'Done.', toolCalls: [], finishReason: 'stop' },
    });
  });
});

describe('createDirectProvider: HTTP errors', () => {
  const table: ReadonlyArray<readonly [number, string, ProviderErrorCode]> = [
    [400, '', 'BAD_REQUEST'],
    [401, '', 'AUTH'],
    [402, '', 'QUOTA'],
    [403, '', 'AUTH'],
    [404, '', 'MODEL_NOT_FOUND'],
    [422, '', 'BAD_REQUEST'],
    [429, 'slow down', 'RATE_LIMITED'],
    [429, 'You exceeded your current quota', 'QUOTA'],
    [429, 'Insufficient funds', 'QUOTA'],
    [500, '', 'SERVER'],
    [502, '', 'SERVER'],
    [503, '', 'SERVER'],
    [418, '', 'BAD_REQUEST'],
  ];

  it.each(table)('status %i with body %j gives %s', async (status, body, code) => {
    const f = fakeFetch(() => new Response(body, { status }));
    const result = await make(f.fetch).chat(REQUEST);
    expect(result).toEqual({ ok: false, error: errorFromHttp(status, body) });
    expect(errorCode(result)).toBe(code);
  });

  it('gives BAD_REPLY for a empty body and for a 3xx status', async () => {
    const f = fakeFetch(() => new Response('', { status: 200 }));
    // An empty 200 body is not JSON. A 3xx that reached us (redirects normally throw) is not an error status.
    expect(errorCode(await make(f.fetch).chat(REQUEST))).toBe('BAD_REPLY');
    const g = fakeFetch(
      () => ({ ok: false, status: 302, text: () => Promise.resolve('') }) as Response,
    );
    expect(errorCode(await make(g.fetch).chat(REQUEST))).toBe('BAD_REPLY');
  });

  it('still maps the status when the error body cannot be read', async () => {
    const f = fakeFetch(
      () =>
        ({
          ok: false,
          status: 503,
          text: () => Promise.reject(new Error('stream broke')),
        }) as unknown as Response,
    );
    expect(errorCode(await make(f.fetch).chat(REQUEST))).toBe('SERVER');
  });

  it('only reads the first 2,000 characters of an error body', async () => {
    const padding = 'x'.repeat(2_000);
    const f = fakeFetch(() => new Response(`${padding}quota`, { status: 429 }));
    expect(errorCode(await make(f.fetch).chat(REQUEST))).toBe('RATE_LIMITED');
    const g = fakeFetch(() => new Response(`${padding.slice(0, 1_990)}quota`, { status: 429 }));
    expect(errorCode(await make(g.fetch).chat(REQUEST))).toBe('QUOTA');
  });

  it('never returns the body of an error response', async () => {
    const secretBody = 'INTERNAL-TRACE-abc123 stack at provider.js:42';
    const f = fakeFetch(() => new Response(secretBody, { status: 500 }));
    const result = await make(f.fetch).chat(REQUEST);
    expect(JSON.stringify(result)).not.toContain('INTERNAL-TRACE');
    expect(JSON.stringify(result)).not.toContain('provider.js');
  });

  it('does not leak the key when an error response echoes it', async () => {
    for (const status of [401, 429, 500]) {
      const body = `{"error":{"message":"Incorrect API key provided: ${KEY}. quota"}}`;
      const f = fakeFetch(() => new Response(body, { status }));
      const result = await make(f.fetch).chat(REQUEST);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain('sk-test');
    }
  });
});

describe('createDirectProvider: thrown errors', () => {
  it('maps a TypeError to CORS_OR_OFFLINE', async () => {
    const fn = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    const result = await make(fn as unknown as typeof fetch).chat(REQUEST);
    expect(errorCode(result)).toBe('CORS_OR_OFFLINE');
  });

  it('maps another throw to NETWORK', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('socket hang up')));
    const result = await make(fn as unknown as typeof fetch).chat(REQUEST);
    expect(errorCode(result)).toBe('NETWORK');
  });

  it('maps a non-Error throw to NETWORK', async () => {
    const fn = vi.fn(() => Promise.reject('boom'));
    const result = await make(fn as unknown as typeof fetch).chat(REQUEST);
    expect(errorCode(result)).toBe('NETWORK');
  });

  it('maps a synchronous throw from fetch to a result, not an exception', async () => {
    const fn = vi.fn(() => {
      throw new Error('sync failure');
    });
    const result = await make(fn as unknown as typeof fetch).chat(REQUEST);
    expect(errorCode(result)).toBe('NETWORK');
  });

  it('does not leak the key when the thrown value carries it', async () => {
    const fn = vi.fn(() => Promise.reject(new Error(`bad header Bearer ${KEY}`)));
    const result = await make(fn as unknown as typeof fetch).chat(REQUEST);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain('Bearer');
  });
});

describe('createDirectProvider: bad replies', () => {
  it('gives BAD_REPLY for a body that is not JSON', async () => {
    const f = fakeFetch(() => new Response('<html>oops</html>', { status: 200 }));
    expect(errorCode(await make(f.fetch).chat(REQUEST))).toBe('BAD_REPLY');
  });

  it('gives BAD_REPLY for JSON that does not match the schema', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ message: 'hi' }] }, [], null, 'text']) {
      const f = fakeFetch(() => jsonResponse(body));
      expect(errorCode(await make(f.fetch).chat(REQUEST))).toBe('BAD_REPLY');
    }
  });

  it('gives NETWORK when a good reply cannot be read', async () => {
    const f = fakeFetch(
      () =>
        ({
          ok: true,
          status: 200,
          text: () => Promise.reject(new Error('reset')),
        }) as unknown as Response,
    );
    expect(errorCode(await make(f.fetch).chat(REQUEST))).toBe('NETWORK');
  });
});

describe('createDirectProvider: timeout and abort', () => {
  /** A fetch that never answers and rejects like the browser when its signal aborts. */
  function hangingFetch() {
    let signalSeen: AbortSignal | undefined;
    const fn = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      signalSeen = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    return { fetch: fn as unknown as typeof fetch, fn, signal: () => signalSeen };
  }

  it('times out after 60 seconds by default, aborts the fetch and leaves no timer', async () => {
    vi.useFakeTimers();
    const h = hangingFetch();
    const pending = make(h.fetch).chat(REQUEST);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(errorCode(result)).toBe('TIMEOUT');
    expect(h.signal()?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors timeoutMs', async () => {
    vi.useFakeTimers();
    const h = hangingFetch();
    const pending = make(h.fetch, { timeoutMs: 1_000 }).chat(REQUEST);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(errorCode(await pending)).toBe('TIMEOUT');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses injected setTimeout and clearTimeout', async () => {
    const started: number[] = [];
    const cleared: unknown[] = [];
    const f = fakeFetch(() => jsonResponse(GOOD_BODY));
    const provider = make(f.fetch, {
      setTimeout: (_handler, ms) => {
        started.push(ms);
        return 'handle-1';
      },
      clearTimeout: (handle) => {
        cleared.push(handle);
      },
    });
    await provider.chat(REQUEST);
    expect(started).toEqual([60_000]);
    expect(cleared).toEqual(['handle-1']);
  });

  it('gives ABORTED when the caller aborts, and leaves no timer', async () => {
    vi.useFakeTimers();
    const h = hangingFetch();
    const controller = new AbortController();
    const pending = make(h.fetch).chat(REQUEST, controller.signal);
    controller.abort();
    expect(errorCode(await pending)).toBe('ABORTED');
    expect(h.signal()?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives ABORTED without a fetch when the signal is already aborted', async () => {
    vi.useFakeTimers();
    const h = hangingFetch();
    const controller = new AbortController();
    controller.abort();
    const result = await make(h.fetch).chat(REQUEST, controller.signal);
    expect(errorCode(result)).toBe('ABORTED');
    expect(h.fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives ABORTED for a late reply that arrives after the caller aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    // This fetch ignores its signal and answers after the abort.
    const fn = vi.fn(async () => {
      controller.abort();
      return jsonResponse(GOOD_BODY);
    });
    const result = await make(fn as unknown as typeof fetch).chat(REQUEST, controller.signal);
    expect(errorCode(result)).toBe('ABORTED');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives TIMEOUT for a late reply that arrives after the timeout', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70_000));
      return jsonResponse(GOOD_BODY);
    });
    const pending = make(fn as unknown as typeof fetch).chat(REQUEST);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(errorCode(await pending)).toBe('TIMEOUT');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the abort listener and the timer after a normal reply', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const f = fakeFetch(() => jsonResponse(GOOD_BODY));
    const result = await make(f.fetch).chat(REQUEST, controller.signal);
    expect(result.ok).toBe(true);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    // Aborting afterwards does nothing.
    controller.abort();
  });

  it('leaves no timer after an error', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    await make(fn as unknown as typeof fetch).chat(REQUEST);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer after HTTP errors, bad JSON and a missing key', async () => {
    vi.useFakeTimers();
    await make(fakeFetch(() => new Response('x', { status: 500 })).fetch).chat(REQUEST);
    await make(fakeFetch(() => new Response('not json', { status: 200 })).fetch).chat(REQUEST);
    await make(fakeFetch(() => jsonResponse(GOOD_BODY)).fetch, { getKey: () => undefined }).chat(
      REQUEST,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createDirectProvider: the key never leaves the header', () => {
  it('appears in no returned value for any outcome', async () => {
    const outcomes: Array<() => Promise<ProviderResult>> = [
      () => make(fakeFetch(() => jsonResponse(GOOD_BODY)).fetch).chat(REQUEST),
      ...[400, 401, 402, 404, 429, 500].map(
        (status) => () =>
          make(fakeFetch(() => new Response(`echo ${KEY}`, { status })).fetch).chat(REQUEST),
      ),
      () => make(fakeFetch(() => new Response(`echo ${KEY}`, { status: 200 })).fetch).chat(REQUEST),
      () =>
        make((() => Promise.reject(new TypeError(KEY))) as unknown as typeof fetch).chat(REQUEST),
      () => make((() => Promise.reject(new Error(KEY))) as unknown as typeof fetch).chat(REQUEST),
    ];
    for (const run of outcomes) {
      expect(JSON.stringify(await run())).not.toContain(KEY);
    }
  });

  it('only returns codes from the closed set', async () => {
    const f = fakeFetch(() => new Response('', { status: 500 }));
    const result = await make(f.fetch).chat(REQUEST);
    expect(PROVIDER_ERROR_CODES).toContain(errorCode(result));
  });
});
