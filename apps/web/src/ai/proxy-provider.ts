/**
 * The proxy provider: the demo path. It posts the same OpenAI-compatible body as the
 * direct provider to the app's own origin (`/api/ai/chat`), where the Worker adds the
 * hosted key. The browser never holds that key, so no `authorization` header is sent.
 *
 * It never throws for network errors, HTTP errors, bad replies or timeouts. The body text
 * of an error response is read only to find the proxy's error code and is never returned.
 */
import { errorFromProxy, errorFromThrown, providerError } from './errors.ts';
import type { ChatRequest, Provider, ProviderError, ProviderResult } from './types.ts';
import { parseWireReply, toWireBody } from './wire.ts';

export const DEFAULT_PROXY_ENDPOINT = '/api/ai/chat';
export const DEFAULT_PROXY_TIMEOUT_MS = 60_000;
/** The model name sent to the proxy. The Worker picks the real model from its allowlist. */
export const DEFAULT_PROXY_MODEL = 'auto';

export type ProxyProviderOptions = {
  readonly fetch: typeof fetch;
  /** Default `/api/ai/chat`. */
  readonly endpoint?: string;
  /** Default 60 000 ms. */
  readonly timeoutMs?: number;
  /** Timer functions, for tests. Default to the global ones, looked up at call time. */
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Default `auto`. Sent as the `model` field. */
  readonly model?: string;
};

/**
 * Settles with `promise`, or rejects as soon as `signal` aborts, even if `promise` never
 * settles (a fetch or a body read that ignores the signal). The listener is always removed.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(reason instanceof Error ? reason : new Error('failed'));
      },
    );
  });
}

/**
 * The proxy's failure code from a response body text, or `undefined`.
 * `kind: 'not-json'` is a body that is empty, HTML or otherwise not JSON.
 */
function readProxyErrorCode(
  text: string,
): { readonly kind: 'not-json' } | { readonly kind: 'json'; readonly code: unknown } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'not-json' };
  }
  if (typeof json !== 'object' || json === null) return { kind: 'not-json' };
  const error = (json as { readonly error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return { kind: 'json', code: undefined };
  const code = (error as { readonly code?: unknown }).code;
  return { kind: 'json', code: typeof code === 'string' ? code : undefined };
}

function failure(error: ProviderError): ProviderResult {
  return { ok: false, error };
}

export function createProxyProvider(options: ProxyProviderOptions): Provider {
  const endpoint = options.endpoint ?? DEFAULT_PROXY_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;
  const model = options.model ?? DEFAULT_PROXY_MODEL;
  const doFetch = options.fetch;

  async function chat(request: ChatRequest, signal?: AbortSignal): Promise<ProviderResult> {
    if (signal?.aborted === true) return failure(providerError('ABORTED'));

    const setTimer = options.setTimeout ?? ((handler, ms) => globalThis.setTimeout(handler, ms));
    const clearTimer =
      options.clearTimeout ??
      ((handle) => {
        globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
      });

    const controller = new AbortController();
    let timedOut = false;
    let aborted = false;
    const onCallerAbort = (): void => {
      aborted = true;
      controller.abort();
    };
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimer(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const thrown = (value: unknown): ProviderResult =>
      failure(errorFromThrown(value, { timedOut, aborted }));
    // A fetch or body read that ignores the signal can still finish after an abort.
    const stopped = (): ProviderResult | undefined =>
      aborted || timedOut ? failure(errorFromThrown(undefined, { timedOut, aborted })) : undefined;

    try {
      const body = JSON.stringify(toWireBody(model, request));
      let response: Response;
      try {
        response = await raceAbort(
          doFetch(endpoint, {
            method: 'POST',
            // Only content-type. No authorization header: the Worker holds the key.
            headers: { 'content-type': 'application/json' },
            body,
            credentials: 'omit',
            redirect: 'error',
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (error) {
        return thrown(error);
      }
      const stoppedAfterFetch = stopped();
      if (stoppedAfterFetch !== undefined) return stoppedAfterFetch;

      let text: string;
      try {
        text = await raceAbort(response.text(), controller.signal);
      } catch (error) {
        return thrown(error);
      }
      const stoppedAfterBody = stopped();
      if (stoppedAfterBody !== undefined) return stoppedAfterBody;

      if (response.status < 200 || response.status > 299) {
        const read = readProxyErrorCode(text);
        // A body that is not JSON (HTML error page, empty body) means the request did not
        // reach the Worker route, whatever the status.
        if (read.kind === 'not-json') return failure(providerError('SERVER'));
        return failure(errorFromProxy(read.code, response.status));
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return failure(providerError('BAD_REPLY'));
      }
      return parseWireReply(json);
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  return { kind: 'proxy', chat };
}
