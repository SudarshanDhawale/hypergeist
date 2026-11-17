import { z } from 'zod';

/*
 * The wire format of the AI proxy (`POST /api/ai/chat`): the request the browser sends,
 * the reply the Worker returns, and the loose parse of a provider reply.
 *
 * Structure and size bounds only. Clamping of `max_tokens` and `temperature`, the model
 * allowlist and the quotas are decided by the Worker, not here. String bounds count UTF-16
 * code units (`z.string().max()`), which is cheap and never more permissive than the byte
 * limit of the whole body.
 */

/** Limits shared by the Worker and the tests. */
export const AI_WIRE_LIMITS = {
  /** Largest request body in bytes (128 KB). */
  maxBodyBytes: 131_072,
  maxMessages: 60,
  /** Longest message content, in characters. */
  maxContentChars: 40_000,
  /** Most tool calls in one assistant message or one reply. */
  maxToolCalls: 100,
  maxTools: 12,
  maxDescriptionChars: 2_000,
  /** Longest tool or function name, in characters. */
  maxNameChars: 64,
  /** Longest tool call id or `tool_call_id`, in characters. */
  maxIdChars: 200,
} as const;

const Content = z.string().max(AI_WIRE_LIMITS.maxContentChars);
const CallId = z.string().min(1).max(AI_WIRE_LIMITS.maxIdChars);
const FunctionName = z.string().min(1).max(AI_WIRE_LIMITS.maxNameChars);

const ToolCallSchema = z.strictObject({
  id: CallId,
  type: z.literal('function'),
  function: z.strictObject({
    name: FunctionName,
    // A JSON text produced by the model. Only its length is bounded here.
    arguments: Content,
  }),
});

const SystemMessageSchema = z.strictObject({ role: z.literal('system'), content: Content });
const UserMessageSchema = z.strictObject({ role: z.literal('user'), content: Content });

const AssistantMessageSchema = z.strictObject({
  role: z.literal('assistant'),
  content: Content.nullable(),
  tool_calls: z.array(ToolCallSchema).max(AI_WIRE_LIMITS.maxToolCalls).optional(),
});

const ToolMessageSchema = z.strictObject({
  role: z.literal('tool'),
  tool_call_id: CallId,
  content: Content,
});

const MessageSchema = z.discriminatedUnion('role', [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);

const ToolSchema = z.strictObject({
  type: z.literal('function'),
  function: z.strictObject({
    name: FunctionName,
    description: z.string().max(AI_WIRE_LIMITS.maxDescriptionChars).optional(),
    // A JSON Schema object. Its size is bounded by the body limit.
    parameters: z.record(z.string(), z.unknown()),
  }),
});

/** The request body of `POST /api/ai/chat`. Unknown top-level keys are rejected. */
export const ChatRequestSchema = z.strictObject({
  model: z.string().min(1).max(100),
  messages: z.array(MessageSchema).min(1).max(AI_WIRE_LIMITS.maxMessages),
  tools: z.array(ToolSchema).max(AI_WIRE_LIMITS.maxTools).optional(),
  tool_choice: z.enum(['auto', 'none']).optional(),
  stream: z.literal(false).optional(),
  // The Worker clamps both values to its own limits before forwarding.
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(100_000).optional(),
});

/** The one reply shape that leaves the Worker. No upstream field beyond these reaches the browser. */
export const PublicReplySchema = z.strictObject({
  choices: z
    .array(
      z.strictObject({
        message: z.strictObject({
          role: z.literal('assistant'),
          content: z.string().nullable(),
          tool_calls: z.array(ToolCallSchema).max(AI_WIRE_LIMITS.maxToolCalls).optional(),
        }),
        finish_reason: z.string(),
      }),
    )
    .length(1),
});

// A provider reply is external data we do not control, and OpenAI-compatible vendors add their
// own fields (system_fingerprint, reasoning text, vendor ids). That is why this schema is the one
// `z.looseObject` of the wire format: unknown keys are allowed and ignored. Only the fields the
// Worker reads are checked, and they are checked strictly. Nothing here is copied to the browser
// except through `PublicReplySchema`.
const UpstreamToolCallSchema = z.looseObject({
  // A missing, null or empty id is replaced by the Worker.
  id: z.string().nullish(),
  function: z.looseObject({
    name: z.string(),
    arguments: z.string(),
  }),
});

const UpstreamChoiceSchema = z.looseObject({
  message: z.looseObject({
    content: z.string().nullish(),
    tool_calls: z.array(UpstreamToolCallSchema).max(AI_WIRE_LIMITS.maxToolCalls).nullish(),
  }),
  finish_reason: z.string().nullish(),
});

/** The loose parse of a provider reply. Only `choices[0]` is read; other choices are ignored. */
export const UpstreamReplySchema = z.looseObject({
  choices: z.tuple([UpstreamChoiceSchema], z.unknown()),
  usage: z.looseObject({ total_tokens: z.number().nonnegative().optional() }).nullish(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type PublicReply = z.infer<typeof PublicReplySchema>;
export type UpstreamReply = z.infer<typeof UpstreamReplySchema>;
