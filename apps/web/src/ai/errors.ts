import type { ProviderError, ProviderErrorCode } from './types.ts';

/** The closed list of provider error codes. `DEMO_ONLY` is used only by the recorded provider. */
export const PROVIDER_ERROR_CODES = [
  'NETWORK',
  'CORS_OR_OFFLINE',
  'AUTH',
  'RATE_LIMITED',
  'QUOTA',
  'MODEL_NOT_FOUND',
  'BAD_REQUEST',
  'SERVER',
  'TIMEOUT',
  'ABORTED',
  'BAD_REPLY',
  'DEMO_ONLY',
] as const satisfies readonly ProviderErrorCode[];

/**
 * Fixed plain-language text per code. There are no placeholders on purpose: no response
 * body, key, URL or exception text can reach a message. The `Record` type makes the
 * compiler fail if a code has no entry.
 */
const TEXT: Readonly<
  Record<ProviderErrorCode, { readonly message: string; readonly hint: string }>
> = {
  NETWORK: {
    message: 'The request failed because of a network problem.',
    hint: 'Check your internet connection and try again.',
  },
  CORS_OR_OFFLINE: {
    message: 'The browser could not reach the provider.',
    hint: 'You may be offline, or the provider may not allow requests from web pages. Try demo mode.',
  },
  AUTH: {
    message: 'The provider did not accept the key.',
    hint: 'Check the key in Settings and enter it again, or switch to demo mode.',
  },
  RATE_LIMITED: {
    message: 'The provider is busy and asked the app to slow down.',
    hint: 'Wait a minute and try again.',
  },
  QUOTA: {
    message: 'The usage limit for this model has been reached.',
    hint: 'Try again later. With your own key, check the plan or credit of your account.',
  },
  MODEL_NOT_FOUND: {
    message: 'The provider does not know this model.',
    hint: 'Check the model name in Settings.',
  },
  BAD_REQUEST: {
    message: 'The provider rejected the request.',
    hint: 'The model may not support this kind of request. Try another model or demo mode.',
  },
  SERVER: {
    message: 'The provider had a problem on its side.',
    hint: 'Try again in a moment.',
  },
  TIMEOUT: {
    message: 'The model took too long to answer.',
    hint: 'Try again, or ask for something smaller.',
  },
  ABORTED: {
    message: 'The request was stopped.',
    hint: 'Send the request again when you are ready.',
  },
  BAD_REPLY: {
    message: 'The provider sent a reply the app could not read.',
    hint: 'Try again. If it keeps happening, try another model.',
  },
  DEMO_ONLY: {
    message: 'The demo cannot do this one.',
    hint: 'The demo only knows its example prompts. Add your own key in Settings to try anything else.',
  },
};

/** Type guard for the closed set of codes. */
export function isProviderErrorCode(value: unknown): value is ProviderErrorCode {
  return typeof value === 'string' && (PROVIDER_ERROR_CODES as readonly string[]).includes(value);
}

/** Builds the error for a code. Returns a new object on every call. */
export function providerError(code: ProviderErrorCode): ProviderError {
  const text = TEXT[code];
  return { code, message: text.message, hint: text.hint };
}

/** Words in a 429 body that mean "out of quota" rather than "too fast". */
const QUOTA_WORDS = ['quota', 'billing', 'insufficient'] as const;

/**
 * Maps an HTTP failure status to an error. `bodyText` is only searched for quota words
 * (on 429) and is never returned or copied. A status outside 400 to 599 is a reply the
 * app did not expect, so it is `BAD_REPLY`.
 */
export function errorFromHttp(status: number, bodyText: string = ''): ProviderError {
  return providerError(codeFromHttp(status, bodyText));
}

function codeFromHttp(status: number, bodyText: string): ProviderErrorCode {
  switch (status) {
    case 401:
    case 403:
      return 'AUTH';
    case 402:
      return 'QUOTA';
    case 404:
      return 'MODEL_NOT_FOUND';
    case 400:
    case 422:
      return 'BAD_REQUEST';
    case 429: {
      const lower = bodyText.toLowerCase();
      return QUOTA_WORDS.some((word) => lower.includes(word)) ? 'QUOTA' : 'RATE_LIMITED';
    }
    default:
      if (status >= 500 && status <= 599) return 'SERVER';
      if (status >= 400 && status <= 499) return 'BAD_REQUEST';
      return 'BAD_REPLY';
  }
}

/**
 * Maps a value thrown by `fetch` (or by reading the reply) to an error. The thrown value
 * is only inspected for its type and is never copied. `aborted` (the caller stopped the
 * request) wins over `timedOut`; a `TypeError` is what browsers throw when they cannot
 * reach a host (CORS, offline, DNS) and does not say which; anything else is `NETWORK`.
 */
export function errorFromThrown(
  value: unknown,
  flags: { readonly timedOut?: boolean; readonly aborted?: boolean } = {},
): ProviderError {
  if (flags.aborted === true) return providerError('ABORTED');
  if (flags.timedOut === true) return providerError('TIMEOUT');
  if (value instanceof TypeError) return providerError('CORS_OR_OFFLINE');
  return providerError('NETWORK');
}

/**
 * Maps a failure answer of the Worker AI proxy to an error. The proxy's own code wins
 * (`RATE_LIMITED`, `DAILY_CAP` to `QUOTA`, `MODEL_NOT_ALLOWED` to `BAD_REQUEST`). Without
 * a known code the HTTP status decides, except that 401, 403 and 404 are `SERVER`: the
 * proxy takes no key from the browser, and a missing route means the Worker side is not
 * there, so "key rejected" or "unknown model" would mislead.
 */
export function errorFromProxy(code: unknown, status: number): ProviderError {
  switch (code) {
    case 'RATE_LIMITED':
      return providerError('RATE_LIMITED');
    case 'DAILY_CAP':
      return providerError('QUOTA');
    case 'MODEL_NOT_ALLOWED':
      return providerError('BAD_REQUEST');
    default:
      if (status === 401 || status === 403 || status === 404) return providerError('SERVER');
      return errorFromHttp(status);
  }
}
