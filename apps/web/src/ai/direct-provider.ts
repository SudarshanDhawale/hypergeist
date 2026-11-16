/**
 * The Direct_Provider: calls an OpenAI-compatible `/chat/completions` endpoint straight
 * from the browser with the reviewer's own key. It never throws for expected failures
 * and never returns a response body, a thrown value or the key.
 */
import { errorFromHttp, errorFromThrown, providerError } from './errors.ts';
import type { ChatRequest, Provider, ProviderResult } from './types.ts';
import { parseWireReply, toWireBody } from './wire.ts';

/** The request timeout in milliseconds (Requirement 1.4). */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** The most characters of an error response body that are read. It is only searched. */
export const ERROR_BODY_READ_LIMIT = 2_000;

export type DirectProviderOptions = {
  /** Already validated by the settings module. A trailing slash is removed defensively. */
  readonly baseUrl: string;
  readonly model: string;
  /** Read at fetch time, used for one header and never stored. */
  readonly getKey: () => string | undefined;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly maxTokens?: number;
};

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charAt(end - 1) === '/') end -= 1;
  return url.slice(0, end);
}

function failure(code: Parameters<typeof providerError>[0]): ProviderResult {
  return { ok: false, error: providerError(code) };
}

export function createDirectProvider(options: DirectProviderOptions): Provider {
  const url = `${stripTrailingSlashes(options.baseUrl)}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    kind: 'direct',
    async chat(request: ChatRequest, signal?: AbortSignal): Promise<ProviderResult> {
      const key = options.getKey();
      if (key === undefined || key.trim() === '') return failure('AUTH');
      if (signal?.aborted === true) return failure('ABORTED');

      // Timer functions are looked up at call time so fake timers installed later work.
      const startTimer =
        options.setTimeout ??
        ((handler: () => void, ms: number) => globalThis.setTimeout(handler, ms));
      const stopTimer =
        options.clearTimeout ??
        ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

      const controller = new AbortController();
      const flags = { timedOut: false, aborted: false };
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

      // The caller's stop wins over the timeout, as in `errorFromThrown`.
      const stopped = (): ProviderResult | undefined => {
        if (flags.aborted) return failure('ABORTED');
        if (flags.timedOut) return failure('TIMEOUT');
        return undefined;
      };

      try {
        const body = JSON.stringify(
          toWireBody(
            options.model,
            request,
            options.maxTokens === undefined ? undefined : { maxTokens: options.maxTokens },
          ),
        );
        const response = await options.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body,
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
        });
        let text = '';
        try {
          text = await response.text();
        } catch (thrown) {
          // An unreadable error body still has a status to map; an unreadable good reply does not.
          if (response.ok || flags.aborted || flags.timedOut) throw thrown;
        }
        const late = stopped();
        if (late !== undefined) return late;

        if (!response.ok) {
          // The body is only searched for quota words and is never returned.
          return {
            ok: false,
            error: errorFromHttp(response.status, text.slice(0, ERROR_BODY_READ_LIMIT)),
          };
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return failure('BAD_REPLY');
        }
        return parseWireReply(json);
      } catch (thrown) {
        return { ok: false, error: errorFromThrown(thrown, flags) };
      } finally {
        stopTimer(timer);
        signal?.removeEventListener('abort', onCallerAbort);
      }
    },
  };
}
