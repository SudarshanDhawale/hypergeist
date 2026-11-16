/**
 * The OpenAI-compatible wire format: our `ChatRequest` to a request body, and a provider
 * reply (untrusted JSON) to a `ChatReply`. Pure functions; the direct provider and the
 * proxy provider both call exactly these two.
 */
import { z } from 'zod';
import { providerError } from './errors.ts';
import type {
  ChatMessage,
  ChatReply,
  ChatRequest,
  FinishReason,
  OpenAiTool,
  ProviderError,
  ToolCall,
} from './types.ts';

/** The most tool calls accepted from one reply. A reply with more is `BAD_REPLY`. */
export const MAX_TOOL_CALLS_PER_REPLY = 100;

/** Sampling temperature sent with every request. */
export const WIRE_TEMPERATURE = 0.2;

export type WireToolCall = {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
};

export type WireMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly tool_calls?: readonly WireToolCall[];
    }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

/** The JSON body of a chat completion request. `ChatRequest.meta` is never part of it. */
export type WireBody = {
  readonly model: string;
  readonly messages: readonly WireMessage[];
  readonly tools?: readonly OpenAiTool[];
  readonly tool_choice?: 'auto';
  readonly stream: false;
  readonly temperature: number;
  readonly max_tokens?: number;
};

export type WireOptions = { readonly maxTokens?: number };

export type ParseWireReplyResult =
  | { readonly ok: true; readonly reply: ChatReply }
  | { readonly ok: false; readonly error: ProviderError };

function toWireToolCall(call: ToolCall): WireToolCall {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  };
}

function toWireMessage(message: ChatMessage): WireMessage {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    case 'assistant': {
      const calls = message.toolCalls ?? [];
      if (calls.length === 0) {
        // An assistant message with neither text nor tool calls is rejected by providers,
        // so a null content without tool calls goes out as an empty string.
        return { role: 'assistant', content: message.content ?? '' };
      }
      return { role: 'assistant', content: message.content, tool_calls: calls.map(toWireToolCall) };
    }
  }
}

/**
 * Builds the request body. `stream` is always `false` and `temperature` is 0.2.
 * `tools` and `tool_choice: 'auto'` are added only when the request has at least one
 * tool (providers reject an empty `tools` array). `max_tokens` is added only when
 * `options.maxTokens` is a positive safe integer. The result is plain JSON-able data
 * and the input is not changed.
 */
export function toWireBody(model: string, request: ChatRequest, options?: WireOptions): WireBody {
  const tools = request.tools ?? [];
  const maxTokens = options?.maxTokens;
  return {
    model,
    messages: request.messages.map(toWireMessage),
    ...(tools.length > 0 ? { tools: [...tools], tool_choice: 'auto' as const } : {}),
    stream: false,
    temperature: WIRE_TEMPERATURE,
    ...(maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0
      ? { max_tokens: maxTokens }
      : {}),
  };
}

/*
 * Provider replies are external data we do not control, and different OpenAI-compatible
 * vendors add their own fields (usage, system_fingerprint, reasoning text, and so on).
 * That is why these schemas use `z.looseObject`: unknown keys are allowed and ignored here.
 * This is the one place the strict-object rule does not apply. Only the fields we read are
 * checked, and they are checked strictly.
 */
const WireToolCallSchema = z.looseObject({
  // A missing, null or empty id is replaced by `call-<index>` after parsing.
  id: z.string().nullish(),
  function: z.looseObject({
    name: z.string(),
    // Never coerced: an object here is a malformed reply, not something to repair.
    arguments: z.string(),
  }),
});

const WireChoiceSchema = z.looseObject({
  message: z.looseObject({
    content: z.string().nullish(),
    tool_calls: z.array(WireToolCallSchema).max(MAX_TOOL_CALLS_PER_REPLY).nullish(),
  }),
  finish_reason: z.string().nullish(),
});

// Only `choices[0]` is read, so only it is checked. Other choices are ignored as they are.
const WireReplySchema = z.looseObject({ choices: z.array(z.unknown()).min(1) });

function toFinishReason(value: string | null | undefined): FinishReason {
  switch (value) {
    case 'stop':
    case 'length':
    case 'tool_calls':
      return value;
    default:
      return 'other';
  }
}

/**
 * Reads the first choice of a chat completion reply. Anything that does not match the
 * expected shape is `BAD_REPLY` for the whole reply, with the fixed text of `errors.ts`
 * (nothing from the reply is copied into the error). Content may be missing, null or a
 * string. Each tool call needs a string `function.name` and a string `function.arguments`;
 * a missing id becomes `call-<index>`. More than 100 tool calls is `BAD_REPLY`.
 */
export function parseWireReply(json: unknown): ParseWireReplyResult {
  const parsed = WireReplySchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: providerError('BAD_REPLY') };
  const first = WireChoiceSchema.safeParse(parsed.data.choices[0]);
  if (!first.success) return { ok: false, error: providerError('BAD_REPLY') };
  const choice = first.data;
  const toolCalls: readonly ToolCall[] = (choice.message.tool_calls ?? []).map((call, index) => ({
    id: call.id !== undefined && call.id !== null && call.id !== '' ? call.id : `call-${index}`,
    name: call.function.name,
    arguments: call.function.arguments,
  }));
  return {
    ok: true,
    reply: {
      content: choice.message.content ?? null,
      toolCalls,
      finishReason: toFinishReason(choice.finish_reason),
    },
  };
}
