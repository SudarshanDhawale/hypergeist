/**
 * Text completion through a provider chain, for the runtime ai-field. It follows the same rule
 * as `runTurnWithFallback`: the next provider is tried only after an error code in
 * `FALLBACK_CODES`, and never once the caller's signal is aborted. `AUTH`, `ABORTED`,
 * `MODEL_NOT_FOUND`, `BAD_REQUEST` and `DEMO_ONLY` end the run with that error.
 *
 * Pure apart from the provider calls. It never rejects and does not change its inputs.
 */
import { completeText } from './complete-text.ts';
import type { CompleteTextArgs, CompleteTextResult } from './complete-text.ts';
import { providerError } from './errors.ts';
import { FALLBACK_CODES } from './fallback.ts';
import type { FallbackInfo } from './fallback.ts';
import type { Provider } from './types.ts';

/** The arguments of `completeText` except the provider, which comes from the chain. */
export type CompleteTextFallbackArgs = Omit<CompleteTextArgs, 'provider'>;

/** The result of the last provider that ran, and `fallback` when a later provider was tried. */
export type CompleteTextFallbackResult = {
  readonly result: CompleteTextResult;
  readonly fallback?: FallbackInfo;
};

/**
 * Runs `completeText` with the first provider of `chain`. If it fails with a code that allows a
 * fallback, another provider follows and the signal is not aborted, the next provider gets the
 * original `args`. This repeats until a result does not qualify or the chain ends. `fallback`
 * describes the last step: `from` is the provider that failed just before the last one that ran,
 * and `error` is its error. When the last provider also fails, its failure is returned with
 * `fallback` still set.
 *
 * An empty chain gives a `BAD_REQUEST` failure and sends no request.
 */
export async function completeTextWithFallback(
  chain: readonly Provider[],
  args: CompleteTextFallbackArgs,
): Promise<CompleteTextFallbackResult> {
  const first = chain[0];
  if (first === undefined) {
    return { result: { ok: false, error: providerError('BAD_REQUEST') } };
  }

  let result = await completeText({ ...args, provider: first });
  let fallback: FallbackInfo | undefined;
  let failedProvider: Provider = first;
  for (let index = 1; index < chain.length; index += 1) {
    const next = chain[index];
    if (next === undefined) break;
    if (result.ok || !FALLBACK_CODES.has(result.error.code)) break;
    if (args.signal?.aborted === true) break;
    fallback = { from: failedProvider.kind, to: next.kind, error: result.error };
    result = await completeText({ ...args, provider: next });
    failedProvider = next;
  }
  return fallback === undefined ? { result } : { result, fallback };
}
