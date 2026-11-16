/**
 * A scripted `Provider` for tests of the orchestrator. It plays back prepared results,
 * records a deep copy of every request and honors an abort signal. Used only by tests:
 * no network, no clock, no randomness.
 */
import { providerError } from '../errors.ts';
import type {
  ChatReply,
  ChatRequest,
  FinishReason,
  Provider,
  ProviderErrorCode,
  ProviderKind,
  ProviderResult,
  ToolCall,
} from '../types.ts';

/** A script is a list of results used in order, or a function that picks one per request. */
export type ScriptFunction = (
  request: ChatRequest,
  round: number,
) => ProviderResult | Promise<ProviderResult>;

export type Script = readonly ProviderResult[] | ScriptFunction;

export type ScriptedProviderOptions = {
  /** Defaults to `'recorded'`. */
  readonly kind?: ProviderKind;
};

export type ScriptedProvider = Provider & {
  /** A deep copy of every request the script has seen, in order. */
  readonly requests: readonly ChatRequest[];
  /** The number of requests the script has seen. */
  readonly calls: number;
};

let nextToolCallId = 1;

/** Restarts the automatic tool call ids at `call-1`. Call it in `beforeEach`. */
export function resetToolCallIds(): void {
  nextToolCallId = 1;
}

/**
 * A tool call with its parameters serialized to JSON text. Without `id`, the id is
 * `call-<n>` from a module-level counter (see `resetToolCallIds`).
 */
export function toolCall(name: string, params: unknown, id?: string): ToolCall {
  return { id: id ?? takeToolCallId(), name, arguments: JSON.stringify(params) };
}

/** A tool call whose arguments are the given text as is, for malformed arguments. */
export function rawToolCall(name: string, argumentsText: string, id?: string): ToolCall {
  return { id: id ?? takeToolCallId(), name, arguments: argumentsText };
}

function takeToolCallId(): string {
  const id = `call-${nextToolCallId}`;
  nextToolCallId += 1;
  return id;
}

/**
 * A successful provider result. `finishReason` defaults to `'tool_calls'` when there are
 * calls and to `'stop'` otherwise; `content` defaults to `null`.
 */
export function reply(
  parts: {
    readonly content?: string | null;
    readonly calls?: readonly ToolCall[];
    readonly finishReason?: FinishReason;
  } = {},
): ProviderResult {
  const toolCalls = parts.calls ?? [];
  const chatReply: ChatReply = {
    content: parts.content ?? null,
    toolCalls,
    finishReason: parts.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
  };
  return { ok: true, reply: chatReply };
}

/** A failed provider result with the fixed text of the code. */
export function providerFailure(code: ProviderErrorCode): ProviderResult {
  return { ok: false, error: providerError(code) };
}

/**
 * Builds the scripted provider. A request whose signal is already aborted gets `ABORTED`
 * and is neither recorded nor counted. Otherwise the request is recorded, and the script
 * is asked for the result of round `calls - 1` (0 for the first request). An array script
 * past its end answers a plain reply with no tool calls and finish reason `'stop'`. If
 * the signal fires while a function script is still pending, the result is `ABORTED`.
 */
export function createScriptedProvider(
  script: Script,
  options: ScriptedProviderOptions = {},
): ScriptedProvider {
  const requests: ChatRequest[] = [];

  async function chat(request: ChatRequest, signal?: AbortSignal): Promise<ProviderResult> {
    if (signal?.aborted === true) return providerFailure('ABORTED');

    const round = requests.length;
    requests.push(structuredClone(request));

    if (typeof script !== 'function') {
      return script[round] ?? reply();
    }
    return awaitUnlessAborted(script(request, round), signal);
  }

  return {
    kind: options.kind ?? 'recorded',
    chat,
    get requests() {
      return requests;
    },
    get calls() {
      return requests.length;
    },
  };
}

/** Resolves with the pending result, or with `ABORTED` as soon as the signal fires. */
async function awaitUnlessAborted(
  pending: ProviderResult | Promise<ProviderResult>,
  signal: AbortSignal | undefined,
): Promise<ProviderResult> {
  if (signal === undefined) return pending;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<ProviderResult>((resolve) => {
    onAbort = () => {
      resolve(providerFailure('ABORTED'));
    };
    // The script may have aborted the signal while it ran synchronously.
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve(pending), aborted]);
    // A result that settles in the same turn as an abort still counts as aborted.
    return signal.aborted ? providerFailure('ABORTED') : result;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
