import type { ChatRequest } from '@hypergeist/shared/ai-wire';
import type { ProviderName } from '../env';
import type { AiConfig, AiProviderConfig } from '../lib/config';

/**
 * The provider table and the adaptation of a validated chat request to one
 * provider. Pure: no network, no clock, no environment.
 *
 * The upstream body is built by picking named fields. The request is never
 * spread, so a field that slipped past the shared schema cannot reach a
 * provider.
 */

export type { ProviderName } from '../env';

export type ProviderSpec = {
  /** Fixed endpoint. Never built from input. */
  readonly url: string;
  /** Name of the output limit in the request body. */
  readonly tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** Whether a custom `temperature` may be sent. */
  readonly allowTemperature: boolean;
  /** Extra header that carries the key besides `Authorization: Bearer`. */
  readonly extraAuthHeader?: string;
};

export const PROVIDER_TABLE: Readonly<Record<ProviderName, ProviderSpec>> = {
  sarvam: {
    url: 'https://api.sarvam.ai/v2/chat/completions',
    tokenParam: 'max_tokens',
    allowTemperature: true,
    extraAuthHeader: 'api-subscription-key',
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    tokenParam: 'max_completion_tokens',
    allowTemperature: false,
  },
};

export type AdaptOptions = {
  /**
   * True for the first provider of the list. Only the first provider receives
   * the model name the client asked for (when it is on the allowlist); a
   * fallback provider always uses its own configured model, because a model
   * name of one vendor means nothing to another.
   */
  readonly isFirst?: boolean;
};

function chooseModel(
  provider: AiProviderConfig,
  request: ChatRequest,
  config: AiConfig,
  isFirst: boolean,
): string {
  if (isFirst && request.model !== 'auto' && config.allowedModels.includes(request.model)) {
    return request.model;
  }
  return provider.model;
}

/** The output limit: the client's value or the configured one, never above the configured one. */
function outputLimit(request: ChatRequest, config: AiConfig): number {
  const wanted = request.max_tokens ?? config.maxOutputTokens;
  return Math.max(1, Math.floor(Math.min(wanted, config.maxOutputTokens)));
}

/**
 * Builds the upstream body for one provider from an already validated
 * request. `messages`, `tools` and `tool_choice` are passed as validated and
 * are not copied or changed. No system message or other text is added.
 */
export function adaptRequest(
  provider: AiProviderConfig,
  request: ChatRequest,
  config: AiConfig,
  options: AdaptOptions = {},
): Record<string, unknown> {
  const spec = PROVIDER_TABLE[provider.name];
  const body: Record<string, unknown> = {
    model: chooseModel(provider, request, config, options.isFirst === true),
    messages: request.messages,
  };
  if (request.tools !== undefined) {
    body['tools'] = request.tools;
  }
  if (request.tool_choice !== undefined) {
    body['tool_choice'] = request.tool_choice;
  }
  body['stream'] = false;
  body[spec.tokenParam] = outputLimit(request, config);
  if (
    spec.allowTemperature &&
    typeof request.temperature === 'number' &&
    Number.isFinite(request.temperature)
  ) {
    body['temperature'] = Math.min(1, Math.max(0, request.temperature));
  }
  if (provider.name === 'openai' && config.reasoningEffort !== null) {
    body['reasoning_effort'] = config.reasoningEffort;
  }
  return body;
}

/** Request headers for one provider call. The key appears only here. */
export function authHeaders(providerName: ProviderName, key: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
  };
  const extra = PROVIDER_TABLE[providerName].extraAuthHeader;
  if (extra !== undefined) {
    headers[extra] = key;
  }
  return headers;
}
