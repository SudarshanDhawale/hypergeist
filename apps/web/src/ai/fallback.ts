/**
 * Provider choice and fallback (Requirements 11.6, 11.7, 12.4).
 *
 * `chooseProviderChain` turns the settings into an ordered list of providers: demo mode is
 * `[proxy, recorded]`, own-key mode is `[direct]` and never anything else, so a reviewer's key
 * is never confused with the demo. `runTurnWithFallback` runs a whole Turn with the first
 * provider and, for a short list of transient failures that left the stack untouched, runs the
 * whole Turn again from the original input with the next provider. `demoNote` turns the result
 * into one plain sentence for the UI.
 *
 * No clock, randomness, network or console here. The key is only ever passed on as the
 * `getKey` function; this module reads it once to check that one is set and does not keep it.
 */
import { providerError } from './errors.ts';
import { createDirectProvider } from './direct-provider.ts';
import { createProxyProvider } from './proxy-provider.ts';
import { createRecordedProvider } from './recorded-provider.ts';
import type { Scenario } from './scenario-set.ts';
import { validateBaseUrl } from './settings.ts';
import type { AiSettings } from './settings.ts';
import { runTurn } from './turn.ts';
import type { TurnInput, TurnResult } from './turn.ts';
import type { Provider, ProviderError, ProviderErrorCode, ProviderKind } from './types.ts';

/** Which provider failed, which one answered instead, and why. */
export type FallbackInfo = {
  readonly from: ProviderKind;
  readonly to: ProviderKind;
  readonly error: ProviderError;
};

/** A `TurnResult`, plus `fallback` when the answer came from a later provider of the chain. */
export type FallbackTurnResult = TurnResult & { readonly fallback?: FallbackInfo };

/**
 * The codes after which the next provider is tried (Requirement 11.7). `AUTH`, `ABORTED`,
 * `MODEL_NOT_FOUND`, `BAD_REQUEST` and `DEMO_ONLY` are not here on purpose: they are either the
 * user's doing or would not change with another provider.
 */
export const FALLBACK_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'RATE_LIMITED',
  'QUOTA',
  'NETWORK',
  'SERVER',
  'TIMEOUT',
  'BAD_REPLY',
  'CORS_OR_OFFLINE',
]);

/**
 * The error that allows a fallback, or `undefined`. A Turn qualifies only when it ended on a
 * provider error before any step was accepted, so retrying cannot repeat or lose work.
 */
function fallbackError(
  result: TurnResult,
  input: Pick<TurnInput, 'signal'>,
): ProviderError | undefined {
  if (result.status !== 'failed' || result.stopReason !== 'provider-error') return undefined;
  if (result.steps.some((step) => step.ok)) return undefined;
  if (input.signal?.aborted === true) return undefined;
  const error = result.error;
  if (error === undefined || !FALLBACK_CODES.has(error.code)) return undefined;
  return error;
}

/**
 * Runs a Turn through `chain` in order. The first provider runs the Turn. If it fails in a way
 * that allows a fallback (see `fallbackError`) and another provider follows, the whole Turn runs
 * again with that provider from the ORIGINAL `input` (same stack, context, history, limits and
 * signal), and the result carries `fallback`. This repeats until a provider's result does not
 * qualify or the chain ends. Nothing of an earlier provider's result is kept except in
 * `fallback`, which describes the last step: `from` is the provider that failed just before the
 * answering one, and `error` is its error. When the last provider also fails, its failed result
 * is returned with `fallback` still set, so the caller can tell that a fallback was tried.
 *
 * An empty chain is a programmer or settings error and gives a `failed` result (`stopReason:
 * 'provider-error'`, `BAD_REQUEST`) with `after` equal to `input.stack` and `before` as `runTurn`
 * would set it (null for a new stack). `providerKind` is `'direct'`, the only mode that can have
 * no usable provider; no request was sent. Never rejects, never mutates `input`.
 */
export async function runTurnWithFallback(
  chain: readonly Provider[],
  input: Omit<TurnInput, 'provider'>,
): Promise<FallbackTurnResult> {
  const first = chain[0];
  if (first === undefined) {
    return {
      status: 'failed',
      before: input.newStack ? null : input.stack,
      after: input.stack,
      steps: [],
      say: [],
      stopReason: 'provider-error',
      error: providerError('BAD_REQUEST'),
      providerKind: 'direct',
      usedJsonMode: input.jsonMode,
      rounds: 0,
    };
  }

  let result: FallbackTurnResult = await runTurn({ ...input, provider: first });
  let failedProvider: Provider = first;
  for (let index = 1; index < chain.length; index += 1) {
    const next = chain[index];
    if (next === undefined) break;
    const error = fallbackError(result, input);
    if (error === undefined) break;
    const info: FallbackInfo = { from: failedProvider.kind, to: next.kind, error };
    result = { ...(await runTurn({ ...input, provider: next })), fallback: info };
    failedProvider = next;
  }
  return result;
}

/** What `chooseProviderChain` needs from the app. */
export type ChooseChainArgs = {
  readonly settings: AiSettings;
  /** Returns the own key, or `undefined`. Passed on to the direct provider, never stored. */
  readonly getKey: () => string | undefined;
  readonly fetch: typeof fetch;
  readonly scenarios: readonly Scenario[];
  /** Default `/api/ai/chat`. */
  readonly proxyEndpoint?: string;
};

export type ChooseChainResult =
  | { readonly ok: true; readonly chain: readonly Provider[]; readonly label: 'demo' | 'own' }
  | { readonly ok: false; readonly message: string };

/**
 * `demo` gives `[proxy, recorded]`. `own` needs a valid base URL, a model name and a key, and
 * gives `[direct]` only, so there is never a silent fallback to the demo (Requirement 11.7).
 * Incomplete own settings give a plain message that never repeats what was typed.
 */
export function chooseProviderChain(args: ChooseChainArgs): ChooseChainResult {
  const { settings } = args;
  if (settings.provider === 'demo') {
    const proxy = createProxyProvider(
      args.proxyEndpoint === undefined
        ? { fetch: args.fetch }
        : { fetch: args.fetch, endpoint: args.proxyEndpoint },
    );
    return { ok: true, chain: [proxy, createRecordedProvider(args.scenarios)], label: 'demo' };
  }

  const missing: string[] = [];
  let baseUrl = '';
  if (settings.baseUrl.trim() === '') {
    missing.push('a base URL');
  } else {
    const checked = validateBaseUrl(settings.baseUrl);
    if (!checked.ok) return { ok: false, message: checked.message };
    baseUrl = checked.url;
  }
  const model = settings.model.trim();
  if (model === '') missing.push('a model name');
  const key = args.getKey();
  if (key === undefined || key.trim() === '') missing.push('a key');
  if (missing.length > 0) {
    return { ok: false, message: `Enter ${joinWithAnd(missing)} to use your own model.` };
  }

  const direct = createDirectProvider({
    baseUrl,
    model,
    getKey: args.getKey,
    fetch: args.fetch,
  });
  return { ok: true, chain: [direct], label: 'own' };
}

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
}

const NOTE_BUSY = 'The shared demo model is busy, so this answer is a recorded example.';
const NOTE_UNREACHABLE =
  'The demo model could not be reached, so this answer is a recorded example.';

/**
 * One plain sentence for the UI when the demo fell back from the shared model to a recorded
 * answer, otherwise `null` (no fallback, or a fallback between other providers). Built from the
 * error code only, so nothing from a response can enter it.
 */
export function demoNote(result: { readonly fallback?: FallbackInfo }): string | null {
  const fallback = result.fallback;
  if (fallback === undefined) return null;
  if (fallback.from !== 'proxy' || fallback.to !== 'recorded') return null;
  switch (fallback.error.code) {
    case 'RATE_LIMITED':
    case 'QUOTA':
      return NOTE_BUSY;
    default:
      return NOTE_UNREACHABLE;
  }
}
