/**
 * Core types of the AI orchestrator: the chat messages, the provider contract and the
 * closed set of provider error codes. Plain data only, no behavior.
 */

/**
 * One tool call as the model wrote it. `arguments` is raw text from the model and is
 * untrusted until it has been parsed and validated.
 */
export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

export type ChatMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls?: readonly ToolCall[];
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

/** A tool definition in the OpenAI `tools` array shape. */
export type OpenAiTool = {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** A JSON Schema object describing the parameters. */
    readonly parameters: Readonly<Record<string, unknown>>;
  };
};

/**
 * What a Turn sends to a provider. `meta` is never sent on the wire: the recorded
 * provider reads it to pick a scripted reply.
 */
export type ChatRequest = {
  readonly messages: readonly ChatMessage[];
  /** Omitted in JSON mode and for text completion. */
  readonly tools?: readonly OpenAiTool[];
  readonly meta: {
    readonly userMessage: string;
    readonly round: number;
    readonly currentCardId: string | null;
    readonly selectedObjectId: string | null;
  };
};

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

export type ChatReply = {
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: FinishReason;
  /** Set only by the recorded provider when the prompt matched no scenario. */
  readonly noMatch?: true;
};

/** The closed set of failure codes a provider can return. */
export type ProviderErrorCode =
  | 'NETWORK'
  | 'CORS_OR_OFFLINE'
  | 'AUTH'
  | 'RATE_LIMITED'
  | 'QUOTA'
  | 'MODEL_NOT_FOUND'
  | 'BAD_REQUEST'
  | 'SERVER'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'BAD_REPLY'
  | 'DEMO_ONLY';

/**
 * A provider failure. Built only by `providerError` in `errors.ts` from a code, so the
 * text is fixed and can never carry a key, a request or response body, or an exception text.
 */
export type ProviderError = {
  readonly code: ProviderErrorCode;
  /** One plain-language sentence saying what went wrong. */
  readonly message: string;
  /** One plain-language sentence saying what the user can do. */
  readonly hint: string;
};

export type ProviderResult =
  | { readonly ok: true; readonly reply: ChatReply }
  | { readonly ok: false; readonly error: ProviderError };

export type ProviderKind = 'direct' | 'proxy' | 'recorded';

/** A provider never throws for network errors, HTTP errors, bad replies or timeouts. */
export type Provider = {
  readonly kind: ProviderKind;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ProviderResult>;
};
