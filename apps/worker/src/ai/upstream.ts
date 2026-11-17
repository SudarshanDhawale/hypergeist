import {
  AI_WIRE_LIMITS,
  PublicReplySchema,
  UpstreamReplySchema,
  type PublicReply,
  type UpstreamReply,
} from '@hypergeist/shared/ai-wire';
import type { AiProviderConfig } from '../lib/config';
import { authHeaders, PROVIDER_TABLE } from './providers';

/**
 * One call to one provider, and the cut of its reply down to the public shape.
 *
 * Nothing here reads the clock or the environment: `fetch`, the timer
 * functions and the abort signal are passed in. A failed call returns a
 * closed `kind` and nothing else. No status text, header, response body or
 * exception message is copied into any returned value, so none of it can
 * reach a client or a log line.
 */

/** The default timeout of one upstream call. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 25_000;

/** Longest `finish_reason` that is passed on, in characters. */
const MAX_FINISH_REASON_CHARS = 32;

export type UpstreamFailureKind =
  'http-4xx' | 'rate-limited' | 'http-5xx' | 'timeout' | 'network' | 'bad-reply' | 'aborted';

export type UpstreamOutcome =
  | {
      readonly ok: true;
      readonly reply: PublicReply;
      /** Always a non-negative integer. */
      readonly tokens: number;
      /** `empty-length`: no text, no tool call and `finish_reason: 'length'`. */
      readonly kind: 'ok' | 'empty-length';
    }
  | { readonly ok: false; readonly retryable: boolean; readonly kind: UpstreamFailureKind };

export type CallUpstreamArgs = {
  readonly provider: AiProviderConfig;
  /** The adapted request body from `adaptRequest`. */
  readonly body: Record<string, unknown>;
  readonly fetch: typeof fetch;
  /** The whole-request signal. Its abort ends the call with `aborted`. */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
};

function failure(kind: UpstreamFailureKind): UpstreamOutcome {
  // A caller that stopped the call must not try again. A client error will not
  // get better with another provider. Every other failure may.
  const retryable = kind !== 'aborted' && kind !== 'http-4xx';
  return { ok: false, retryable, kind };
}

function classifyStatus(status: number): UpstreamFailureKind {
  if (status === 429) return 'rate-limited';
  if (status >= 500 && status <= 599) return 'http-5xx';
  if (status >= 400 && status <= 499) return 'http-4xx';
  // 1xx and 3xx cannot be handled (redirects are refused), so the reply is unusable.
  return 'bad-reply';
}

/**
 * Cuts a parsed provider reply to the public shape by picking named fields.
 * Returns `undefined` when the result does not satisfy `PublicReplySchema`.
 */
export function toPublicReply(parsed: UpstreamReply): PublicReply | undefined {
  const choice = parsed.choices[0];
  const upstreamCalls = choice.message.tool_calls ?? [];
  if (upstreamCalls.length > AI_WIRE_LIMITS.maxToolCalls) {
    return undefined;
  }
  const toolCalls = upstreamCalls.map((call, index) => ({
    id: call.id !== undefined && call.id !== null && call.id !== '' ? call.id : `call-${index}`,
    type: 'function' as const,
    function: { name: call.function.name, arguments: call.function.arguments },
  }));
  const finishReason = (choice.finish_reason ?? 'stop').slice(0, MAX_FINISH_REASON_CHARS);
  const candidate = {
    choices: [
      {
        message: {
          role: 'assistant' as const,
          content: choice.message.content ?? null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
  };
  const checked = PublicReplySchema.safeParse(candidate);
  return checked.success ? checked.data : undefined;
}

function replyChars(reply: PublicReply): number {
  const message = reply.choices[0]?.message;
  let chars = message?.content?.length ?? 0;
  for (const call of message?.tool_calls ?? []) {
    chars += call.function.name.length + call.function.arguments.length;
  }
  return chars;
}

/**
 * The tokens to count for one reply. The provider's `usage.total_tokens` when
 * it is a usable number (a fraction is rounded down), otherwise an estimate of
 * three characters per token over the request and the reply. Always a
 * non-negative integer: the quota store ignores anything else.
 */
export function tokensFrom(reply: PublicReply, usage: unknown, requestChars: number): number {
  if (typeof usage === 'object' && usage !== null) {
    const total: unknown = (usage as Record<string, unknown>)['total_tokens'];
    if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
      const whole = Math.floor(total);
      if (Number.isSafeInteger(whole)) {
        return whole;
      }
    }
  }
  const request = Number.isFinite(requestChars) ? Math.max(0, requestChars) : 0;
  return Math.ceil(request / 3) + Math.ceil(replyChars(reply) / 3);
}

/**
 * `usage` is advice for the quota and never a reason to refuse a good reply,
 * so it is taken out before the strict parse and read on its own.
 */
function splitUsage(json: unknown): { rest: unknown; usage: unknown } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { rest: json, usage: undefined };
  }
  const record = json as Record<string, unknown>;
  const { usage, ...rest } = record;
  return { rest, usage };
}

/** Frees the connection of a response whose body is not wanted. Never throws. */
function discardBody(response: Response): void {
  try {
    const pending = response.body?.cancel();
    pending?.catch(() => undefined);
  } catch {
    // Nothing to free, or already locked. Either way the body is not read.
  }
}

export async function callUpstream(args: CallUpstreamArgs): Promise<UpstreamOutcome> {
  const { provider, signal } = args;
  if (signal?.aborted === true) {
    return failure('aborted');
  }
  const timeoutMs = args.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  // Timer functions are looked up at call time so fake timers installed later work.
  const startTimer =
    args.setTimeout ?? ((handler: () => void, ms: number) => globalThis.setTimeout(handler, ms));
  const stopTimer =
    args.clearTimeout ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  const controller = new AbortController();
  const flags = { aborted: false, timedOut: false };
  const onCallerAbort = (): void => {
    flags.aborted = true;
    controller.abort();
  };
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = startTimer(() => {
    if (flags.aborted) return;
    flags.timedOut = true;
    controller.abort();
  }, timeoutMs);

  // The caller's stop wins over the timeout.
  const stopped = (): UpstreamOutcome | undefined => {
    if (flags.aborted) return failure('aborted');
    if (flags.timedOut) return failure('timeout');
    return undefined;
  };

  try {
    const payload = JSON.stringify(args.body);
    const requestChars = payload.length;
    const response = await args.fetch(PROVIDER_TABLE[provider.name].url, {
      method: 'POST',
      headers: authHeaders(provider.name, provider.key),
      body: payload,
      signal: controller.signal,
      redirect: 'error',
    });

    const late = stopped();
    if (late !== undefined) {
      discardBody(response);
      return late;
    }
    if (response.status < 200 || response.status > 299) {
      // The body of a failed call is never read.
      discardBody(response);
      return failure(classifyStatus(response.status));
    }

    const text = await response.text();
    const lateText = stopped();
    if (lateText !== undefined) return lateText;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return failure('bad-reply');
    }
    const { rest, usage } = splitUsage(json);
    const parsed = UpstreamReplySchema.safeParse(rest);
    if (!parsed.success) {
      return failure('bad-reply');
    }
    const reply = toPublicReply(parsed.data);
    if (reply === undefined) {
      return failure('bad-reply');
    }
    const choice = reply.choices[0];
    const empty =
      choice !== undefined &&
      (choice.message.content === null || choice.message.content === '') &&
      (choice.message.tool_calls === undefined || choice.message.tool_calls.length === 0) &&
      choice.finish_reason === 'length';
    return {
      ok: true,
      reply,
      tokens: tokensFrom(reply, usage, requestChars),
      kind: empty ? 'empty-length' : 'ok',
    };
  } catch {
    // The thrown value is dropped on purpose: it may carry request or key text.
    return stopped() ?? failure('network');
  } finally {
    stopTimer(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}
