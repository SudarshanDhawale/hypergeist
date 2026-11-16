/**
 * The recorded provider: answers from bundled scenarios, with no network and no model. It is the
 * last step of demo mode, and what tests use to drive a whole Turn. A prompt is recognized by
 * exact match after normalization (no fuzzy matching). `meta.round` picks which recorded reply
 * of the matched scenario to send.
 *
 * Pure: no clock, randomness, network or console output. It never throws and never changes its input.
 */
import { providerError } from './errors.ts';
import { normalizePrompt } from './scenario-set.ts';
import type { Scenario } from './scenario-set.ts';
import type { ChatReply, ChatRequest, Provider, ProviderResult, ToolCall } from './types.ts';

/** The most example prompts listed in the no-match text. */
export const MAX_LISTED_EXAMPLES = 6;

const CURRENT_CARD_PLACEHOLDER = '{{currentCardId}}';
const SELECTED_OBJECT_PLACEHOLDER = '{{selectedObjectId}}';

/** Builds the no-match text from the examples the demo can do. */
function noMatchText(examples: readonly string[]): string {
  if (examples.length === 0) {
    return 'In demo mode I have no examples to run. Add your own key in Settings to try anything else.';
  }
  const list = examples.map((example) => `"${example}"`).join(', ');
  return `In demo mode I can only do these examples: ${list}. Add your own key in Settings to try anything else.`;
}

/**
 * Replaces the two placeholders inside every string value (not keys) of a JSON value, at any
 * depth. Returns a new value; the scenario is never modified. `split`/`join` is used so that
 * `$` in an id cannot act as a replacement pattern.
 */
function substitute(value: unknown, cardId: string, objectId: string): unknown {
  if (typeof value === 'string') {
    return value
      .split(CURRENT_CARD_PLACEHOLDER)
      .join(cardId)
      .split(SELECTED_OBJECT_PLACEHOLDER)
      .join(objectId);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => substitute(item, cardId, objectId));
  }
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = substitute(item, cardId, objectId);
    return copy;
  }
  return value;
}

/** The reply for a round past the end of the recorded replies. */
function emptyReply(): ChatReply {
  return { content: null, toolCalls: [], finishReason: 'stop' };
}

function replyFor(scenario: Scenario, request: ChatRequest): ChatReply {
  const { round, currentCardId, selectedObjectId } = request.meta;
  const recorded = Number.isInteger(round) && round >= 0 ? scenario.replies[round] : undefined;
  if (recorded === undefined) return emptyReply();

  const cardId = currentCardId ?? '';
  const objectId = selectedObjectId ?? '';
  const toolCalls: ToolCall[] = (recorded.toolCalls ?? []).map((call, index) => ({
    id: `rec-${round}-${index}`,
    name: call.name,
    arguments: JSON.stringify(substitute(call.arguments, cardId, objectId)),
  }));
  return {
    content: recorded.content ?? null,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
  };
}

/**
 * Creates the recorded provider over a list of scenarios (usually `loadScenarios().scenarios`).
 *
 * - A prompt that matches a scenario gets reply number `meta.round`; past the end it gets an
 *   empty "stop" reply.
 * - A prompt with no match gets an ok reply with `noMatch: true` and a text that lists the first
 *   prompt of each `new-stack` and `edit` scenario (in the order given, at most
 *   `MAX_LISTED_EXAMPLES`). A request with no `tools` (text completion) gets `DEMO_ONLY` instead,
 *   so no apology text can land in a field.
 * - An already aborted signal gets `ABORTED`.
 */
export function createRecordedProvider(scenarios: readonly Scenario[]): Provider {
  const byPrompt = new Map<string, Scenario>();
  for (const scenario of scenarios) {
    for (const prompt of scenario.prompts) {
      const key = normalizePrompt(prompt);
      if (!byPrompt.has(key)) byPrompt.set(key, scenario);
    }
  }
  const examples = scenarios
    .filter((scenario) => scenario.mode === 'new-stack' || scenario.mode === 'edit')
    .flatMap((scenario) => {
      const first = scenario.prompts[0];
      return first === undefined ? [] : [first];
    })
    .slice(0, MAX_LISTED_EXAMPLES);
  const noMatch = noMatchText(examples);

  return {
    kind: 'recorded',
    async chat(request: ChatRequest, signal?: AbortSignal): Promise<ProviderResult> {
      if (signal?.aborted === true) return { ok: false, error: providerError('ABORTED') };

      const scenario = byPrompt.get(normalizePrompt(request.meta.userMessage));
      if (scenario !== undefined) return { ok: true, reply: replyFor(scenario, request) };

      if (request.tools === undefined) return { ok: false, error: providerError('DEMO_ONLY') };
      return {
        ok: true,
        reply: { content: noMatch, toolCalls: [], finishReason: 'stop', noMatch: true },
      };
    },
  };
}
