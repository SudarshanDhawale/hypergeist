import { PublicReplySchema, type PublicReply } from '@hypergeist/shared/ai-wire';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProviderConfig } from '../lib/config';
import { PROVIDER_TABLE } from './providers';
import { callUpstream, tokensFrom, type UpstreamOutcome } from './upstream';

const SARVAM_KEY = 'test-secret-sarvam-0000';
const OPENAI_KEY = 'test-secret-openai-0000';

const SARVAM: AiProviderConfig = {
  name: 'sarvam',
  key: SARVAM_KEY,
  model: 'sarvam-model',
  toJSON: () => ({ name: 'sarvam', model: 'sarvam-model' }),
};
const OPENAI: AiProviderConfig = {
  name: 'openai',
  key: OPENAI_KEY,
  model: 'openai-model',
  toJSON: () => ({ name: 'openai', model: 'openai-model' }),
};

const BODY = { model: 'sarvam-model', messages: [{ role: 'user', content: 'hello' }] };
const BODY_CHARS = JSON.stringify(BODY).length;

type Call = { readonly url: string; readonly init: RequestInit };
type Handler = (call: Call) => Promise<Response> | Response;

function makeFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake: typeof fetch = async (input, init) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fake, calls };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textReply(content: string | null, extra: Record<string, unknown> = {}): unknown {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...extra,
  };
}

function toolCall(id: string | null | undefined, name = 'create_card', args = '{"a":1}'): unknown {
  return {
    ...(id === undefined ? {} : { id }),
    type: 'function',
    function: { name, arguments: args },
  };
}

async function run(
  handler: Handler,
  options: { provider?: AiProviderConfig; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ outcome: UpstreamOutcome; calls: Call[] }> {
  const { fetch: fake, calls } = makeFetch(handler);
  const outcome = await callUpstream({
    provider: options.provider ?? SARVAM,
    body: BODY,
    fetch: fake,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { outcome, calls };
}

function expectOk(outcome: UpstreamOutcome): Extract<UpstreamOutcome, { ok: true }> {
  if (!outcome.ok) {
    throw new Error(`expected ok, got ${outcome.kind}`);
  }
  return outcome;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('callUpstream request', () => {
  it('posts JSON to the fixed provider URL with the auth headers and redirect: error', async () => {
    const { outcome, calls } = await run(() => jsonResponse(textReply('hi')));
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(PROVIDER_TABLE.sarvam.url);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.body).toBe(JSON.stringify(BODY));
    expect(call?.init).not.toHaveProperty('credentials');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${SARVAM_KEY}`);
    expect(headers['api-subscription-key']).toBe(SARVAM_KEY);
    expect(headers['content-type']).toBe('application/json');
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the OpenAI URL and no extra header for openai', async () => {
    const { calls } = await run(() => jsonResponse(textReply('hi')), { provider: OPENAI });
    expect(calls[0]?.url).toBe(PROVIDER_TABLE.openai.url);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${OPENAI_KEY}`);
    expect(headers).not.toHaveProperty('api-subscription-key');
  });
});

describe('callUpstream success', () => {
  it('returns text content', async () => {
    const { outcome } = await run(() => jsonResponse(textReply('hello there')));
    const ok = expectOk(outcome);
    expect(ok.kind).toBe('ok');
    expect(ok.reply).toEqual({
      choices: [{ message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
    });
  });

  it('returns tool calls with null content', async () => {
    const reply = {
      choices: [
        {
          message: { role: 'assistant', content: null, tool_calls: [toolCall('c1')] },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const ok = expectOk((await run(() => jsonResponse(reply))).outcome);
    expect(ok.reply.choices[0]?.message).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'create_card', arguments: '{"a":1}' } },
      ],
    });
    expect(ok.reply.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('returns content and tool calls together', async () => {
    const reply = {
      choices: [
        {
          message: { content: 'done', tool_calls: [toolCall('c1'), toolCall('c2', 'x', '{}')] },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const message = expectOk((await run(() => jsonResponse(reply))).outcome).reply.choices[0]
      ?.message;
    // `role` is absent upstream and is set by the Worker.
    expect(message?.role).toBe('assistant');
    expect(message?.content).toBe('done');
    expect(message?.tool_calls?.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('treats a null or empty tool_calls array as no tool calls', async () => {
    for (const toolCalls of [null, []]) {
      const reply = {
        choices: [{ message: { content: 'x', tool_calls: toolCalls }, finish_reason: 'stop' }],
      };
      const message = expectOk((await run(() => jsonResponse(reply))).outcome).reply.choices[0]
        ?.message;
      expect(message).toEqual({ role: 'assistant', content: 'x' });
    }
  });

  it('uses only the first choice', async () => {
    const reply = {
      choices: [
        { message: { content: 'first' }, finish_reason: 'stop' },
        { message: { content: 'second' }, finish_reason: 'stop' },
      ],
    };
    const ok = expectOk((await run(() => jsonResponse(reply))).outcome);
    expect(ok.reply.choices).toHaveLength(1);
    expect(ok.reply.choices[0]?.message.content).toBe('first');
  });

  it('defaults a missing finish_reason to stop and cuts a long one to 32 characters', async () => {
    const missing = { choices: [{ message: { content: 'a' } }] };
    const nulled = { choices: [{ message: { content: 'a' }, finish_reason: null }] };
    const long = { choices: [{ message: { content: 'a' }, finish_reason: 'x'.repeat(100) }] };
    for (const reply of [missing, nulled]) {
      expect(
        expectOk((await run(() => jsonResponse(reply))).outcome).reply.choices[0]?.finish_reason,
      ).toBe('stop');
    }
    expect(
      expectOk((await run(() => jsonResponse(long))).outcome).reply.choices[0]?.finish_reason,
    ).toBe('x'.repeat(32));
  });

  it('turns missing, null and empty tool call ids into call-<index>', async () => {
    const reply = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [toolCall(undefined), toolCall('keep'), toolCall(null), toolCall('')],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const ids = expectOk(
      (await run(() => jsonResponse(reply))).outcome,
    ).reply.choices[0]?.message.tool_calls?.map((c) => c.id);
    expect(ids).toEqual(['call-0', 'keep', 'call-2', 'call-3']);
  });

  it('keeps only the allowed keys of the public reply', async () => {
    const reply = {
      id: 'chatcmpl-secret-id',
      object: 'chat.completion',
      system_fingerprint: 'fp_secret',
      usage: { total_tokens: 12, prompt_tokens: 7 },
      choices: [
        {
          index: 0,
          logprobs: { secret: true },
          message: {
            role: 'assistant',
            content: 'ok',
            reasoning_content: 'hidden thoughts',
            refusal: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                index: 0,
                vendor_extra: 'x',
                function: { name: 'f', arguments: '{}', extra_inside: 'y' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const ok = expectOk((await run(() => jsonResponse(reply))).outcome);
    expect(PublicReplySchema.safeParse(ok.reply).success).toBe(true);
    expect(ok.reply).toEqual({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'ok',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const text = JSON.stringify(ok);
    for (const secret of ['chatcmpl-secret-id', 'fp_secret', 'hidden thoughts', 'vendor_extra']) {
      expect(text).not.toContain(secret);
    }
  });

  it('returns an empty reply that ended with length as empty-length', async () => {
    const reply = { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
    const ok = expectOk((await run(() => jsonResponse(reply))).outcome);
    expect(ok.kind).toBe('empty-length');
    expect(ok.reply.choices[0]?.message.content).toBe('');
    expect(ok.reply.choices[0]?.finish_reason).toBe('length');

    const nulled = { choices: [{ message: { content: null }, finish_reason: 'length' }] };
    expect(expectOk((await run(() => jsonResponse(nulled))).outcome).kind).toBe('empty-length');
  });

  it('does not flag length with content, length with tool calls, or an empty stop', async () => {
    const withContent = { choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] };
    const withCalls = {
      choices: [
        { message: { content: null, tool_calls: [toolCall('c')] }, finish_reason: 'length' },
      ],
    };
    const emptyStop = { choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
    for (const reply of [withContent, withCalls, emptyStop]) {
      expect(expectOk((await run(() => jsonResponse(reply))).outcome).kind).toBe('ok');
    }
  });

  it('rejects more than 100 tool calls as bad-reply', async () => {
    const make = (count: number): unknown => ({
      choices: [
        {
          message: {
            content: null,
            tool_calls: Array.from({ length: count }, (_, i) => toolCall(`c${i}`)),
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(expectOk((await run(() => jsonResponse(make(100)))).outcome).kind).toBe('ok');
    expect((await run(() => jsonResponse(make(101)))).outcome).toEqual({
      ok: false,
      retryable: true,
      kind: 'bad-reply',
    });
  });

  it('rejects a reply the public schema refuses (id or name too long, empty name)', async () => {
    for (const call of [
      toolCall('i'.repeat(201)),
      toolCall('c', 'n'.repeat(65)),
      toolCall('c', ''),
    ]) {
      const reply = {
        choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
      };
      expect((await run(() => jsonResponse(reply))).outcome).toEqual({
        ok: false,
        retryable: true,
        kind: 'bad-reply',
      });
    }
  });
});

describe('tokens', () => {
  const reply: PublicReply = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'abcd',
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'ab', arguments: 'cde' } }],
        },
        finish_reason: 'stop',
      },
    ],
  };

  it('uses usage.total_tokens when it is a non-negative integer', async () => {
    const ok = expectOk(
      (await run(() => jsonResponse(textReply('hi', { usage: { total_tokens: 321 } })))).outcome,
    );
    expect(ok.tokens).toBe(321);
    expect(tokensFrom(reply, { total_tokens: 0 }, 300)).toBe(0);
  });

  it('estimates from the request and reply sizes when usage is absent', async () => {
    const ok = expectOk((await run(() => jsonResponse(textReply('abcdefg')))).outcome);
    expect(ok.tokens).toBe(Math.ceil(BODY_CHARS / 3) + Math.ceil(7 / 3));
    // content 4 + name 2 + arguments 3 = 9 characters.
    expect(tokensFrom(reply, undefined, 10)).toBe(Math.ceil(10 / 3) + 3);
  });

  it('falls back to the estimate for a negative or string total, and for a null usage', async () => {
    for (const usage of [{ total_tokens: -5 }, { total_tokens: '99' }, null, 'many', []]) {
      const outcome = (await run(() => jsonResponse(textReply('abc', { usage })))).outcome;
      // A strange usage never makes a good reply fail.
      expect(expectOk(outcome).tokens).toBe(Math.ceil(BODY_CHARS / 3) + 1);
    }
  });

  it('rounds a fractional total down', () => {
    expect(tokensFrom(reply, { total_tokens: 12.9 }, 30)).toBe(12);
    expect(tokensFrom(reply, { total_tokens: 0.4 }, 30)).toBe(0);
  });

  it('always returns a non-negative integer, whatever usage holds', () => {
    const values: unknown[] = [
      1.5,
      0.1,
      -1,
      -0.5,
      '7',
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1e300,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 2,
      {},
      [],
      true,
    ];
    for (const total of values) {
      for (const usage of [{ total_tokens: total }, total]) {
        for (const requestChars of [0, 1, 10, 1001, 12.5]) {
          const tokens = tokensFrom(reply, usage, requestChars);
          expect(Number.isInteger(tokens)).toBe(true);
          expect(tokens).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('is an integer for odd usage values that come through callUpstream', async () => {
    for (const total of [1.5, 0.2, 99.99, 1e300, 7]) {
      const outcome = (
        await run(() => jsonResponse(textReply('x', { usage: { total_tokens: total } })))
      ).outcome;
      expect(Number.isInteger(expectOk(outcome).tokens)).toBe(true);
    }
  });
});

describe('failure classification', () => {
  const cases: readonly [number, UpstreamOutcome][] = [
    [429, { ok: false, retryable: true, kind: 'rate-limited' }],
    [500, { ok: false, retryable: true, kind: 'http-5xx' }],
    [502, { ok: false, retryable: true, kind: 'http-5xx' }],
    [503, { ok: false, retryable: true, kind: 'http-5xx' }],
    [599, { ok: false, retryable: true, kind: 'http-5xx' }],
    [400, { ok: false, retryable: false, kind: 'http-4xx' }],
    [401, { ok: false, retryable: false, kind: 'http-4xx' }],
    [403, { ok: false, retryable: false, kind: 'http-4xx' }],
    [404, { ok: false, retryable: false, kind: 'http-4xx' }],
    [408, { ok: false, retryable: false, kind: 'http-4xx' }],
    [422, { ok: false, retryable: false, kind: 'http-4xx' }],
  ];

  it.each(cases)('status %i', async (status, expected) => {
    const { outcome } = await run(() => jsonResponse({ error: { message: 'x' } }, status));
    expect(outcome).toEqual(expected);
  });

  it('treats a status outside 200 to 299 and 400 to 599 as a retryable bad-reply', async () => {
    const { outcome } = await run(() => new Response(null, { status: 304 }));
    expect(outcome).toEqual({ ok: false, retryable: true, kind: 'bad-reply' });
  });

  it('classifies a thrown error as a retryable network failure', async () => {
    const { outcome } = await run(() => {
      throw new TypeError('connect ECONNRESET with test-secret-sarvam-0000');
    });
    expect(outcome).toEqual({ ok: false, retryable: true, kind: 'network' });
    expect(JSON.stringify(outcome)).not.toContain(SARVAM_KEY);
  });

  it('classifies a refused redirect (fetch throws) as a retryable network failure', async () => {
    const { outcome } = await run(() => Promise.reject(new TypeError('redirect mode is error')));
    expect(outcome).toEqual({ ok: false, retryable: true, kind: 'network' });
  });

  it('classifies a body that fails while it is read as a retryable network failure', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('stream broke'));
      },
    });
    const { outcome } = await run(() => new Response(stream, { status: 200 }));
    expect(outcome).toEqual({ ok: false, retryable: true, kind: 'network' });
  });

  it('classifies a non-JSON 2xx body as a retryable bad-reply', async () => {
    const { outcome } = await run(() => new Response('<html>oops</html>', { status: 200 }));
    expect(outcome).toEqual({ ok: false, retryable: true, kind: 'bad-reply' });
  });

  it('classifies schema mismatches on a 2xx as a retryable bad-reply', async () => {
    const bodies: unknown[] = [
      null,
      [],
      'text',
      42,
      {},
      { choices: [] },
      { choices: 'x' },
      { choices: [{}] },
      { choices: [{ message: {} }, 'extra'] }, // valid first choice: ok, covered below
      { choices: [{ message: { content: 5 } }] },
      { choices: [{ message: { content: 'a', tool_calls: [{ function: { name: 'f' } }] } }] },
      { choices: [{ message: { content: 'a' }, finish_reason: 7 }] },
    ];
    const results = await Promise.all(bodies.map((b) => run(() => jsonResponse(b))));
    const kinds = results.map((r) => (r.outcome.ok ? 'ok' : r.outcome.kind));
    expect(kinds).toEqual([
      'bad-reply',
      'bad-reply',
      'bad-reply',
      'bad-reply',
      'bad-reply',
      'bad-reply',
      'bad-reply',
      'bad-reply',
      'ok', // `message: {}` is a reply with no content: empty content null, finish_reason stop
      'bad-reply',
      'bad-reply',
      'bad-reply',
    ]);
    for (const { outcome } of results) {
      if (!outcome.ok) expect(outcome.retryable).toBe(true);
    }
  });

  it('never reads the body of an error response, and cancels it', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('leaky error text test-secret-sarvam-0000'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream, { status: 500 });
    const text = vi.spyOn(response, 'text');
    const json = vi.spyOn(response, 'json');
    const { outcome } = await run(() => response);
    expect(outcome).toEqual({ ok: false, retryable: true, kind: 'http-5xx' });
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
  });

  it('survives a body that cannot be cancelled', async () => {
    const response = new Response('x', { status: 401 });
    Object.defineProperty(response, 'body', {
      get() {
        return {
          cancel() {
            throw new Error('locked');
          },
        };
      },
    });
    const { outcome } = await run(() => response);
    expect(outcome).toEqual({ ok: false, retryable: false, kind: 'http-4xx' });
  });

  it('has only ok, retryable and kind on a failure: no text field', async () => {
    const { outcome } = await run(() => jsonResponse({ error: 'secret text' }, 500));
    expect(Object.keys(outcome).sort()).toEqual(['kind', 'ok', 'retryable']);
    expect(JSON.stringify(outcome)).not.toContain('secret text');
  });
});

describe('the key', () => {
  it('is sent in the headers and appears in no returned value', async () => {
    const outcomes: UpstreamOutcome[] = [];
    const handlers: Handler[] = [
      () => jsonResponse(textReply('fine', { usage: { total_tokens: 3 } })),
      () => jsonResponse({ error: `bad key ${SARVAM_KEY}` }, 401),
      () => jsonResponse({ error: `limited ${SARVAM_KEY}` }, 429),
      () => new Response(`not json ${SARVAM_KEY}`, { status: 200 }),
      () => Promise.reject(new Error(`boom ${SARVAM_KEY}`)),
    ];
    for (const handler of handlers) {
      const { outcome, calls } = await run(handler);
      outcomes.push(outcome);
      expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toContain(
        SARVAM_KEY,
      );
    }
    expect(JSON.stringify(outcomes)).not.toContain(SARVAM_KEY);
    expect(JSON.stringify(outcomes)).not.toContain('test-secret');
  });

  it('is not echoed into the reply when the model repeats nothing of it', async () => {
    const { outcome } = await run(() => jsonResponse(textReply('hello')));
    expect(JSON.stringify(outcome)).not.toContain(SARVAM_KEY);
  });
});

describe('timeout and abort', () => {
  /** A fetch that never answers on its own and fails when its signal aborts. */
  function hangingFetch(): { fetch: typeof fetch; signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    const fake: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          return;
        }
        signals.push(signal);
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    return { fetch: fake, signals };
  }

  it('times out after the default 25 seconds, aborts the fetch signal and clears the timer', async () => {
    vi.useFakeTimers();
    const { fetch: fake, signals } = hangingFetch();
    const pending = callUpstream({ provider: SARVAM, body: BODY, fetch: fake });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(await pending).toEqual({ ok: false, retryable: true, kind: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours a custom timeoutMs', async () => {
    vi.useFakeTimers();
    const { fetch: fake } = hangingFetch();
    const pending = callUpstream({ provider: SARVAM, body: BODY, fetch: fake, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ ok: false, retryable: true, kind: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns timeout for a late reply that ignores the abort', async () => {
    vi.useFakeTimers();
    let release: (response: Response) => void = () => undefined;
    const fake: typeof fetch = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    const pending = callUpstream({ provider: SARVAM, body: BODY, fetch: fake, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    release(jsonResponse(textReply('too late')));
    expect(await pending).toEqual({ ok: false, retryable: true, kind: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses injected timer functions and clears the same handle', async () => {
    const handle = { id: 'timer' };
    const started: number[] = [];
    const cleared: unknown[] = [];
    const { fetch: fake } = makeFetch(() => jsonResponse(textReply('ok')));
    const outcome = await callUpstream({
      provider: SARVAM,
      body: BODY,
      fetch: fake,
      timeoutMs: 1234,
      setTimeout: (_handler, ms) => {
        started.push(ms);
        return handle;
      },
      clearTimeout: (h) => {
        cleared.push(h);
      },
    });
    expect(outcome.ok).toBe(true);
    expect(started).toEqual([1234]);
    expect(cleared).toEqual([handle]);
  });

  it('clears the timer after success, an HTTP error and a thrown error', async () => {
    vi.useFakeTimers();
    const handlers: Handler[] = [
      () => jsonResponse(textReply('ok')),
      () => jsonResponse({}, 500),
      () => Promise.reject(new Error('x')),
      () => new Response('nope', { status: 200 }),
    ];
    for (const handler of handlers) {
      await run(handler);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('returns aborted without calling fetch when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { outcome, calls } = await run(() => jsonResponse(textReply('x')), {
      signal: controller.signal,
    });
    expect(outcome).toEqual({ ok: false, retryable: false, kind: 'aborted' });
    expect(calls).toHaveLength(0);
  });

  it('returns aborted, not retryable, when the caller aborts mid-flight', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { fetch: fake, signals } = hangingFetch();
    const pending = callUpstream({
      provider: SARVAM,
      body: BODY,
      fetch: fake,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    expect(signals[0]?.aborted).toBe(true);
    expect(await pending).toEqual({ ok: false, retryable: false, kind: 'aborted' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns aborted for a late reply after the caller aborted', async () => {
    const controller = new AbortController();
    let release: (response: Response) => void = () => undefined;
    const fake: typeof fetch = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    const pending = callUpstream({
      provider: SARVAM,
      body: BODY,
      fetch: fake,
      signal: controller.signal,
    });
    controller.abort();
    release(jsonResponse(textReply('late')));
    expect(await pending).toEqual({ ok: false, retryable: false, kind: 'aborted' });
  });

  it('prefers aborted over timeout when both happened', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { fetch: fake } = hangingFetch();
    const pending = callUpstream({
      provider: SARVAM,
      body: BODY,
      fetch: fake,
      signal: controller.signal,
      timeoutMs: 10,
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toEqual({ ok: false, retryable: false, kind: 'aborted' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes its listener from the caller signal when done', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await run(() => jsonResponse(textReply('ok')), { signal: controller.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
