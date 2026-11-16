/**
 * Capability detection for a Direct_Provider: is it reachable, does it accept the key, does
 * it list the configured model, can the model call tools, and does it offer transcription.
 * `detectCapabilities` never rejects. The key is read with `getKey()` for one header and is
 * never stored, returned or put into a message.
 */
import { z } from 'zod';
import { createDirectProvider } from './direct-provider.ts';
import { errorFromThrown, providerError } from './errors.ts';
import type { ChatRequest, OpenAiTool, ProviderError } from './types.ts';

/** The timeout of the `GET /models` call in milliseconds. */
export const MODELS_TIMEOUT_MS = 15_000;

/** The timeout of the tool probe in milliseconds. */
export const PROBE_TIMEOUT_MS = 30_000;

/** The most model ids kept in a report. */
export const MAX_MODELS = 50;

/** The most characters kept of one model id. */
export const MODEL_ID_MAX = 100;

/** The most characters of the `/models` reply that are parsed. */
export const MODELS_BODY_MAX = 1_000_000;

export const UNREACHABLE_MESSAGE =
  'The browser could not reach this provider. It may not allow requests from web pages. Try demo mode.';
export const AUTH_MESSAGE = 'The provider did not accept the key.';
export const NO_TOOLS_MESSAGE =
  'This model may not support tool calls. The app will ask it for JSON instead.';
export const MODEL_NOT_LISTED_MESSAGE = "The model name was not found in the provider's list.";
export const NO_MODEL_LIST_MESSAGE = 'The provider did not return a list of models.';
export const NO_KEY_MESSAGE = 'No key is set, so tool calling was not tested.';

export type CapabilityReport = {
  /** `false` when the browser could not get any answer from the provider. */
  readonly reachable: boolean;
  /** `false` when the provider said 401 or 403, `true` when a call with the key succeeded. */
  readonly authOk: boolean | 'unknown';
  /** Whether the configured model is among the listed ids. */
  readonly modelListed: boolean | 'unknown';
  readonly toolCalling: 'yes' | 'no' | 'unknown';
  /** Never `no`: that needs a failed attempt, and none is made. */
  readonly transcription: 'yes' | 'unknown';
  /** At most 50 ids, each cut to 100 characters. */
  readonly models: readonly string[];
  /** Plain sentences for the UI. They never mention the key. */
  readonly messages: readonly string[];
};

export type DetectCapabilitiesOptions = {
  /** Already validated by the settings module. */
  readonly baseUrl: string;
  readonly model: string;
  /** Read at fetch time, used for one header and never stored. */
  readonly getKey: () => string | undefined;
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
};

/**
 * Provider replies are not ours to restrict, so unknown keys are allowed. Only `data[].id`
 * is read.
 */
const ModelListSchema = z.looseObject({
  data: z.array(z.looseObject({ id: z.string() })),
});

const NOOP_TOOL: OpenAiTool = {
  type: 'function',
  function: {
    name: 'noop',
    description: 'Does nothing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

const PROBE_REQUEST: ChatRequest = {
  messages: [{ role: 'user', content: 'Call the noop tool.' }],
  tools: [NOOP_TOOL],
  meta: {
    userMessage: 'Call the noop tool.',
    round: 0,
    currentCardId: null,
    selectedObjectId: null,
  },
};

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charAt(end - 1) === '/') end -= 1;
  return url.slice(0, end);
}

/** Cuts to `max` code points so a surrogate pair is never split. */
function cut(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

type ModelsOutcome =
  | { readonly kind: 'stopped'; readonly error: ProviderError }
  | { readonly kind: 'auth-rejected' }
  | { readonly kind: 'no-list' }
  | { readonly kind: 'list'; readonly ids: readonly string[] };

async function fetchModels(
  options: DetectCapabilitiesOptions,
  key: string | undefined,
): Promise<ModelsOutcome> {
  const startTimer =
    options.setTimeout ?? ((handler: () => void, ms: number) => globalThis.setTimeout(handler, ms));
  const stopTimer =
    options.clearTimeout ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  const controller = new AbortController();
  const flags = { timedOut: false, aborted: false };
  const onCallerAbort = (): void => {
    flags.aborted = true;
    controller.abort();
  };
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = startTimer(() => {
    if (flags.aborted) return;
    flags.timedOut = true;
    controller.abort();
  }, MODELS_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (key !== undefined) headers.authorization = `Bearer ${key}`;
    const response = await options.fetch(`${stripTrailingSlashes(options.baseUrl)}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    });
    let text = '';
    try {
      text = await response.text();
    } catch (thrown) {
      if (response.ok || flags.aborted || flags.timedOut) throw thrown;
    }
    if (flags.aborted) return { kind: 'stopped', error: providerError('ABORTED') };
    if (flags.timedOut) return { kind: 'stopped', error: providerError('TIMEOUT') };

    if (response.status === 401 || response.status === 403) return { kind: 'auth-rejected' };
    if (!response.ok || text.length > MODELS_BODY_MAX) return { kind: 'no-list' };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: 'no-list' };
    }
    const parsed = ModelListSchema.safeParse(json);
    if (!parsed.success) return { kind: 'no-list' };
    return { kind: 'list', ids: parsed.data.data.map((entry) => entry.id) };
  } catch (thrown) {
    const error = errorFromThrown(thrown, flags);
    return { kind: 'stopped', error };
  } finally {
    stopTimer(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

type Probe = { readonly toolCalling: 'yes' | 'no' | 'unknown'; readonly error?: ProviderError };

async function probeTools(options: DetectCapabilitiesOptions): Promise<Probe> {
  const provider = createDirectProvider({
    baseUrl: options.baseUrl,
    model: options.model,
    getKey: options.getKey,
    fetch: options.fetch,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxTokens: 16,
    ...(options.setTimeout === undefined ? {} : { setTimeout: options.setTimeout }),
    ...(options.clearTimeout === undefined ? {} : { clearTimeout: options.clearTimeout }),
  });
  const result = await provider.chat(PROBE_REQUEST, options.signal);
  if (result.ok) {
    return { toolCalling: result.reply.toolCalls.length > 0 ? 'yes' : 'unknown' };
  }
  if (result.error.code === 'BAD_REQUEST') return { toolCalling: 'no' };
  return { toolCalling: 'unknown', error: result.error };
}

function unique(messages: readonly string[]): string[] {
  return messages.filter((message, index) => messages.indexOf(message) === index);
}

async function detect(options: DetectCapabilitiesOptions): Promise<CapabilityReport> {
  const key = options.getKey();
  const hasKey = key !== undefined && key.trim() !== '';
  const messages: string[] = [];
  let reachable = true;
  let authOk: boolean | 'unknown' = 'unknown';
  let modelListed: boolean | 'unknown' = 'unknown';
  let transcription: 'yes' | 'unknown' = 'unknown';
  let models: readonly string[] = [];
  let runProbe = true;

  const outcome = await fetchModels(options, hasKey ? key : undefined);
  switch (outcome.kind) {
    case 'stopped':
      reachable = false;
      runProbe = false;
      messages.push(
        outcome.error.code === 'CORS_OR_OFFLINE' ? UNREACHABLE_MESSAGE : outcome.error.message,
      );
      break;
    case 'auth-rejected':
      authOk = false;
      runProbe = false;
      messages.push(AUTH_MESSAGE);
      break;
    case 'no-list':
      messages.push(NO_MODEL_LIST_MESSAGE);
      break;
    case 'list': {
      if (hasKey) authOk = true;
      if (outcome.ids.length > 0) {
        modelListed = outcome.ids.some(
          (id) => id === options.model || id === `models/${options.model}`,
        );
        if (outcome.ids.some((id) => /whisper|transcribe/i.test(id))) transcription = 'yes';
      } else {
        messages.push(NO_MODEL_LIST_MESSAGE);
      }
      models = outcome.ids.slice(0, MAX_MODELS).map((id) => cut(id, MODEL_ID_MAX));
      break;
    }
  }

  let toolCalling: 'yes' | 'no' | 'unknown' = 'unknown';
  if (runProbe && !hasKey) {
    messages.push(NO_KEY_MESSAGE);
  } else if (runProbe) {
    const probe = await probeTools(options);
    toolCalling = probe.toolCalling;
    if (probe.error !== undefined) {
      if (probe.error.code === 'AUTH') {
        authOk = false;
        messages.push(AUTH_MESSAGE);
      } else {
        messages.push(probe.error.message);
      }
    }
  }

  if (modelListed === false) messages.push(MODEL_NOT_LISTED_MESSAGE);
  if (toolCalling !== 'yes') messages.push(NO_TOOLS_MESSAGE);

  return {
    reachable,
    authOk,
    modelListed,
    toolCalling,
    transcription,
    models,
    messages: unique(messages),
  };
}

/**
 * Checks a provider. Never rejects: any unexpected failure becomes a report with
 * `reachable: false` and a fixed message.
 */
export async function detectCapabilities(
  options: DetectCapabilitiesOptions,
): Promise<CapabilityReport> {
  try {
    return await detect(options);
  } catch {
    return {
      reachable: false,
      authOk: 'unknown',
      modelListed: 'unknown',
      toolCalling: 'unknown',
      transcription: 'unknown',
      models: [],
      messages: [providerError('NETWORK').message, NO_TOOLS_MESSAGE],
    };
  }
}

export type CapabilityCache = {
  get(settingsKey: string): CapabilityReport | undefined;
  set(settingsKey: string, report: CapabilityReport): void;
  clear(): void;
  /**
   * The cache key for the current settings. It holds only whether a key is present, never
   * the key. When the key's value changes while the base URL and model stay the same, the
   * caller calls `clear()`.
   */
  keyFor(baseUrl: string, model: string, hasKey: boolean): string;
};

/** An in-memory cache of the last reports, one per settings combination. */
export function createCapabilityCache(): CapabilityCache {
  const reports = new Map<string, CapabilityReport>();
  return {
    get(settingsKey) {
      return reports.get(settingsKey);
    },
    set(settingsKey, report) {
      reports.set(settingsKey, report);
    },
    clear() {
      reports.clear();
    },
    keyFor(baseUrl, model, hasKey) {
      return `${stripTrailingSlashes(baseUrl)}|${model}|${hasKey ? 'keyPresent' : 'noKey'}`;
    },
  };
}
