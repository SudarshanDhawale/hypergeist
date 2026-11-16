/**
 * The Turn loop: one user request and everything it causes. It builds the context, asks the
 * provider, applies every tool call with `applyOperation`, sends errors back for repair, and
 * returns a `TurnResult` whose stack is always valid.
 *
 * Two modes share one loop. NATIVE mode sends the tool list and reads tool calls. JSON mode
 * (Requirement 8) sends no tool list and reads one JSON object per reply. Both end up in
 * `applyCalls`, so limits, repair and the stack stay the same. Per-round logic lives in small
 * pure functions over plain data: they return a `RoundOutcome` (the messages to append and the
 * counts) and the loop only asks the provider and hands the reply to the right helper.
 *
 * Pure apart from the provider call: no clock of its own (time comes from `input.clock`), no
 * randomness, no `console`. Expected failures are values; `runTurn` never rejects.
 */
import { applyOperation } from '@hypergeist/shared/engine';
import type { OperationSummary } from '@hypergeist/shared/engine';
import { createValidationError, validateStack } from '@hypergeist/shared/format';
import type { Stack, ValidationError } from '@hypergeist/shared/format';
import { buildContext } from './context.ts';
import { describeCall, describeResult } from './describe.ts';
import { providerError } from './errors.ts';
import { buildSystemPrompt } from './prompts.ts';
import { parseJsonReply } from './json-mode.ts';
import type { JsonReply } from './json-mode.ts';
import { buildRepairMessage } from './repair.ts';
import {
  CREATE_STACK_TOOL_NAME,
  SAY_TOOL_NAME,
  buildToolRegistry,
  parseToolCall,
  toOpenAiTools,
} from './tools.ts';
import type { ParsedToolCall } from './tools.ts';
import type {
  ChatMessage,
  ChatReply,
  ChatRequest,
  Provider,
  ProviderError,
  ToolCall,
} from './types.ts';

/* ------------------------------------------------------------------------------------------ */
/* Public types                                                                                */
/* ------------------------------------------------------------------------------------------ */

/** The limits of one Turn. Every field has a default; `TurnInput.limits` may override some. */
export type TurnLimits = {
  /** Model requests per Turn (Requirement 6.4). Default 8. */
  maxRequests: number;
  /** Tool calls handled per Turn, accepted or rejected. Default 40. */
  maxCalls: number;
  /** Total time per Turn, in milliseconds, measured with `input.clock`. Default 90,000. */
  maxMs: number;
  /** Rejected calls per Turn (Requirement 7.2). Default 6. */
  maxRejected: number;
  /** Repair rounds in a row (Requirement 7.2). Default 2. */
  maxRepairRounds: number;
};

export const DEFAULT_TURN_LIMITS: Readonly<TurnLimits> = Object.freeze({
  maxRequests: 8,
  maxCalls: 40,
  maxMs: 90_000,
  maxRejected: 6,
  maxRepairRounds: 2,
});

export type TurnInput = {
  readonly provider: Provider;
  readonly stack: Stack;
  readonly currentCardId: string;
  readonly selectedObjectId: string | null;
  readonly userMessage: string;
  readonly history: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[];
  /** True when the Turn builds a new stack: `create_stack` is offered and `before` is null. */
  readonly newStack: boolean;
  /**
   * Start in JSON mode: no tools are sent and the model answers with one JSON object. A Turn
   * that starts in native mode switches to JSON mode once, when the provider rejects a request
   * with tools as `BAD_REQUEST`.
   */
  readonly jsonMode: boolean;
  readonly signal?: AbortSignal;
  /** Milliseconds from any fixed origin. The Turn never reads a clock of its own. */
  readonly clock: () => number;
  readonly limits?: Partial<TurnLimits>;
};

/** One tool call of a Turn and what became of it. */
export type StepRecord = {
  readonly tool: string;
  readonly ok: boolean;
  /** One plain English line, from `describeCall` or `describeResult`. */
  readonly description: string;
  readonly errors?: readonly ValidationError[];
  created?: string[];
  updated?: string[];
  removed?: string[];
};

export type TurnStopReason =
  | 'finished'
  | 'repair-exhausted'
  | 'limit-requests'
  | 'limit-calls'
  | 'limit-time'
  | 'provider-error'
  | 'aborted'
  | 'empty-message';

export type TurnResult = {
  readonly status: 'done' | 'partial' | 'failed' | 'aborted';
  /** The stack before the Turn, for undo. Null when the Turn started a new stack. */
  readonly before: Stack | null;
  /** The stack after the Turn. Valid in every status. */
  readonly after: Stack;
  readonly steps: readonly StepRecord[];
  /** What the model said, in order (`say` calls and the final text reply). */
  readonly say: readonly string[];
  readonly stopReason: TurnStopReason;
  /** Set when a provider error ended the Turn. */
  readonly error?: ProviderError;
  readonly providerKind: Provider['kind'];
  /** True when the Turn ran in JSON mode (started there, or switched after `BAD_REQUEST`). */
  readonly usedJsonMode: boolean;
  /** The number of requests sent to the provider. */
  readonly rounds: number;
};

/* ------------------------------------------------------------------------------------------ */
/* Constants                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** The most history entries sent with a request (Requirement 6.1). */
const MAX_HISTORY_MESSAGES = 6;

/** The longest user message, in code points. */
const MAX_USER_MESSAGE = 2000;

/** The longest tool name kept in a `StepRecord`, in code points (a model may send anything). */
const MAX_STEP_TOOL_NAME = 64;

/** The most ids listed per group in an `ok:` tool message. */
const MAX_IDS_IN_RESULT = 8;

const NOT_APPLIED_CALL_LIMIT = 'Not applied: the limit of calls for one request was reached';
const NOT_APPLIED_REJECT_LIMIT = 'Not applied: too many calls were rejected in this request';
const SAY_RESULT = 'ok: shown to the user';
const STACK_NAMED_RESULT = 'ok: the stack was named';

/** The tool name used in the step of a JSON reply that could not be read at all. */
const JSON_REPLY_STEP_NAME = 'reply';
const JSON_REPLY_UNREADABLE = 'Could not read the reply';

/** The longest tool name echoed in a JSON `Results:` line, in characters. */
const MAX_RESULT_TOOL_NAME = 64;

const JSON_RESULTS_FOOTER = 'Send the next JSON object, or {"calls":[]} when you are done.';

/* ------------------------------------------------------------------------------------------ */
/* Pure helpers: limits, messages                                                              */
/* ------------------------------------------------------------------------------------------ */

function resolveLimits(overrides: Partial<TurnLimits> | undefined): TurnLimits {
  const limits: TurnLimits = { ...DEFAULT_TURN_LIMITS };
  if (overrides === undefined) return limits;
  for (const key of Object.keys(limits) as (keyof TurnLimits)[]) {
    const value = overrides[key];
    if (typeof value === 'number' && !Number.isNaN(value)) limits[key] = value;
  }
  return limits;
}

function codePointLength(text: string): number {
  // UTF-16 length is never smaller than the code point count, so the cheap test goes first.
  return text.length <= MAX_USER_MESSAGE ? text.length : [...text].length;
}

function cutCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
}

/** The first user message: the context, a blank line, `Request:` and the message. */
function firstUserMessage(contextText: string, userMessage: string): string {
  return `${contextText}\n\nRequest:\n${userMessage}`;
}

/** `[system, ...history (last 6), user]`. History texts are plain text, never tool calls. */
function initialMessages(
  systemPrompt: string,
  history: TurnInput['history'],
  firstUser: string,
): ChatMessage[] {
  const recent = history.slice(-MAX_HISTORY_MESSAGES);
  return [
    { role: 'system', content: systemPrompt },
    ...recent.map((entry): ChatMessage => ({ role: entry.role, content: entry.text })),
    { role: 'user', content: firstUser },
  ];
}

function idGroup(label: string, ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  const shown = ids.slice(0, MAX_IDS_IN_RESULT).join(', ');
  const rest = ids.length - MAX_IDS_IN_RESULT;
  return `${label} ${shown}${rest > 0 ? `, and ${rest} more` : ''}`;
}

/** The tool message for an accepted Operation: `ok: created a, b; updated c`. */
function summaryText(summary: OperationSummary): string {
  const parts = [
    idGroup('created', summary.created),
    idGroup('updated', summary.updated),
    idGroup('removed', summary.removed),
    summary.removedActions > 0 ? `removed ${summary.removedActions} actions` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'ok: nothing changed' : `ok: ${parts.join('; ')}`;
}

function toolMessage(toolCallId: string, content: string): ChatMessage {
  return { role: 'tool', toolCallId, content };
}

/* ------------------------------------------------------------------------------------------ */
/* Pure helpers: one call                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * What became of one tool call. `held` is the stack after the call (unchanged unless the call
 * changed it). `resultText` is what goes back to the model for this call.
 */
type CallOutcome =
  | {
      readonly kind: 'changed';
      readonly held: Stack;
      readonly step: StepRecord;
      readonly resultText: string;
    }
  | {
      readonly kind: 'said';
      readonly held: Stack;
      readonly text: string;
      readonly resultText: string;
    }
  | {
      readonly kind: 'rejected';
      readonly held: Stack;
      readonly step: StepRecord;
      readonly resultText: string;
    };

function stepToolName(name: string): string {
  return cutCodePoints(name, MAX_STEP_TOOL_NAME);
}

function rejectedOutcome(
  held: Stack,
  toolName: string,
  errors: readonly ValidationError[],
): CallOutcome {
  const tool = stepToolName(toolName);
  return {
    kind: 'rejected',
    held,
    step: { tool, ok: false, description: describeResult({ tool, ok: false, errors }), errors },
    resultText: buildRepairMessage(toolName, errors),
  };
}

/** `create_stack` was called in a Turn that did not offer it. */
function createStackNotOfferedErrors(): readonly ValidationError[] {
  return [
    createValidationError({
      code: 'INVALID_VALUE',
      path: '/tool',
      message: 'The tool create_stack is not available in this request.',
      expected: 'one of the tools you were given',
      actual: CREATE_STACK_TOOL_NAME,
      hint: 'Only use create_stack when you are asked to build a new stack. Edit the stack with the other tools.',
    }),
  ];
}

/**
 * Applies one parsed call to the held stack. Shared by every mode: native tool calls and (task
 * 4.3) the `calls` of a JSON reply both end up here once they are parsed. Never throws: the
 * engine and the validator return values. The held stack changes only on an accepted call.
 */
function applyParsedCall(
  held: Stack,
  toolName: string,
  parsed: ParsedToolCall,
  newStack: boolean,
): CallOutcome {
  if (!parsed.ok) return rejectedOutcome(held, toolName, parsed.errors);

  if (parsed.name === SAY_TOOL_NAME) {
    return { kind: 'said', held, text: parsed.params.text, resultText: SAY_RESULT };
  }

  if (parsed.name === CREATE_STACK_TOOL_NAME) {
    if (!newStack) return rejectedOutcome(held, toolName, createStackNotOfferedErrors());
    const candidate: Stack = { ...held, name: parsed.params.name };
    const checked = validateStack(candidate);
    if (!checked.valid) {
      const errors = checked.errors.map((error) => ({ ...error, path: `/arguments${error.path}` }));
      return rejectedOutcome(held, toolName, errors);
    }
    const tool = stepToolName(toolName);
    return {
      kind: 'changed',
      held: candidate,
      step: { tool, ok: true, description: describeCall(tool, parsed.params) },
      resultText: STACK_NAMED_RESULT,
    };
  }

  const result = applyOperation(held, parsed.name, parsed.params);
  if (!result.ok) return rejectedOutcome(held, toolName, result.errors);
  const tool = stepToolName(toolName);
  return {
    kind: 'changed',
    held: result.stack,
    step: {
      tool,
      ok: true,
      description: describeCall(tool, parsed.params),
      created: [...result.summary.created],
      updated: [...result.summary.updated],
      removed: [...result.summary.removed],
    },
    resultText: summaryText(result.summary),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Pure helpers: one round                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** What one reply did. The same shape in both modes. */
type RoundOutcome = {
  readonly held: Stack;
  readonly steps: readonly StepRecord[];
  readonly said: readonly string[];
  /** Calls handled (applied or rejected), `say` included. Calls refused by a limit are not counted. */
  readonly callsHandled: number;
  /** Accepted calls that changed the stack (`say` does not count). */
  readonly changes: number;
  readonly rejected: number;
  /** Calls other than an accepted `say`: real work or a rejection. Zero means "the model only talked". */
  readonly workCalls: number;
  /** A call was refused because the call limit was reached. */
  readonly callLimitHit: boolean;
  /** The messages to append to the conversation, in order. */
  readonly messages: readonly ChatMessage[];
};

type RoundBudget = {
  readonly callsUsed: number;
  readonly rejectedTotal: number;
};

/** One call to apply, in either mode: the tool name and its arguments as JSON text. */
type CallItem = { readonly name: string; readonly rawArguments: string };

/** The answer for one call: `ok`, `rejected` (repair text) or `skipped` (a limit was reached). */
type CallEntry = {
  readonly status: 'ok' | 'rejected' | 'skipped';
  readonly text: string;
};

type AppliedCalls = Omit<RoundOutcome, 'messages'> & { readonly entries: readonly CallEntry[] };

/**
 * Applies calls in order, each to the stack as it stands after the earlier accepted calls, and
 * returns one entry per call. A call that arrives when the call limit or the rejection limit is
 * already reached is not applied and not counted: it only gets a "Not applied" entry
 * (Requirement 6.9). Shared by native and JSON mode, which differ only in how the entries are
 * sent back to the model.
 */
function applyCalls(
  held: Stack,
  items: readonly CallItem[],
  newStack: boolean,
  budget: RoundBudget,
  limits: TurnLimits,
): AppliedCalls {
  let current = held;
  let callsUsed = budget.callsUsed;
  let rejectedTotal = budget.rejectedTotal;
  let changes = 0;
  let rejected = 0;
  let workCalls = 0;
  let callLimitHit = false;
  const steps: StepRecord[] = [];
  const said: string[] = [];
  const entries: CallEntry[] = [];

  for (const item of items) {
    if (callsUsed >= limits.maxCalls) {
      callLimitHit = true;
      entries.push({ status: 'skipped', text: NOT_APPLIED_CALL_LIMIT });
      continue;
    }
    if (rejectedTotal >= limits.maxRejected) {
      entries.push({ status: 'skipped', text: NOT_APPLIED_REJECT_LIMIT });
      continue;
    }
    callsUsed += 1;
    const outcome = applyParsedCall(
      current,
      item.name,
      parseToolCall(item.name, item.rawArguments),
      newStack,
    );
    current = outcome.held;
    if (outcome.kind === 'said') {
      said.push(outcome.text);
      entries.push({ status: 'ok', text: outcome.resultText });
      continue;
    }
    steps.push(outcome.step);
    workCalls += 1;
    if (outcome.kind === 'changed') {
      changes += 1;
      entries.push({ status: 'ok', text: outcome.resultText });
    } else {
      rejected += 1;
      rejectedTotal += 1;
      entries.push({ status: 'rejected', text: outcome.resultText });
    }
  }

  return {
    held: current,
    steps,
    said,
    callsHandled: callsUsed - budget.callsUsed,
    changes,
    rejected,
    workCalls,
    callLimitHit,
    entries,
  };
}

/** Native mode: every call is answered with its own `tool` message, matched by call id. */
function applyNativeRound(
  held: Stack,
  calls: readonly ToolCall[],
  newStack: boolean,
  budget: RoundBudget,
  limits: TurnLimits,
): RoundOutcome {
  const items = calls.map((call): CallItem => ({ name: call.name, rawArguments: call.arguments }));
  const { entries, ...round } = applyCalls(held, items, newStack, budget, limits);
  return {
    ...round,
    messages: calls.map((call, index) => toolMessage(call.id, entries[index]?.text ?? '')),
  };
}

/** A tool name from the model, reduced to a short safe token for the `Results:` message. */
function resultToolName(name: string): string {
  const token = name.slice(0, MAX_RESULT_TOOL_NAME).replace(/[^A-Za-z0-9_.-]/g, '_');
  return token === '' ? 'unknown' : token;
}

/** The one `user` message that returns the results of all calls of a JSON reply. */
function jsonResultsMessage(
  items: readonly CallItem[],
  entries: readonly CallEntry[],
): ChatMessage {
  const lines = items.map((item, index) => {
    const entry = entries[index];
    const answer =
      entry === undefined || entry.status === 'ok' || entry.status === 'skipped'
        ? (entry?.text ?? '')
        : `rejected: ${entry.text}`;
    return `${index + 1}. ${resultToolName(item.name)}: ${answer}`;
  });
  return { role: 'user', content: `Results:\n${lines.join('\n')}\n${JSON_RESULTS_FOOTER}` };
}

/**
 * JSON mode, a reply that was read: applies its `calls` like native calls, answers all of them
 * in one `user` message, and adds the `say` field to the text the model said. A reply with no
 * calls sends no message: the Turn is finished.
 */
function applyJsonRound(
  held: Stack,
  reply: JsonReply,
  newStack: boolean,
  budget: RoundBudget,
  limits: TurnLimits,
): RoundOutcome {
  // `params` is `unknown` (the schema checks only that the key exists). It came from `JSON.parse`,
  // so it can be serialized again, and `parseToolCall` checks it like a native argument: a
  // `null` or a list is rejected as "not an object".
  const items = reply.calls.map((call): CallItem => ({
    name: call.tool,
    rawArguments: JSON.stringify(call.params),
  }));
  const { entries, ...round } = applyCalls(held, items, newStack, budget, limits);
  const say = reply.say?.trim() ?? '';
  return {
    ...round,
    said: say === '' ? round.said : [...round.said, say],
    messages: items.length === 0 ? [] : [jsonResultsMessage(items, entries)],
  };
}

/**
 * JSON mode, a reply that could not be read (no JSON, or the wrong shape). It is one rejected
 * step: nothing changed, it counts as one rejection for the repair limits, it is not a tool
 * call (so it uses no part of the call limit), and the repair message goes back as a `user`
 * message.
 */
function rejectedJsonReply(held: Stack, errors: readonly ValidationError[]): RoundOutcome {
  const first = errors[0]?.message ?? '';
  const step: StepRecord = {
    tool: JSON_REPLY_STEP_NAME,
    ok: false,
    description: first === '' ? JSON_REPLY_UNREADABLE : `${JSON_REPLY_UNREADABLE}: ${first}`,
    errors,
  };
  return {
    held,
    steps: [step],
    said: [],
    callsHandled: 0,
    changes: 0,
    rejected: 1,
    workCalls: 1,
    callLimitHit: false,
    messages: [{ role: 'user', content: buildRepairMessage(JSON_REPLY_STEP_NAME, errors) }],
  };
}

/** The assistant message that goes back into the conversation for a reply. */
function assistantMessage(reply: ChatReply): ChatMessage {
  return reply.toolCalls.length === 0
    ? { role: 'assistant', content: reply.content }
    : { role: 'assistant', content: reply.content, toolCalls: reply.toolCalls };
}

/* ------------------------------------------------------------------------------------------ */
/* Turn state and the decision after a round                                                   */
/* ------------------------------------------------------------------------------------------ */

type TurnState = {
  held: Stack;
  messages: ChatMessage[];
  steps: StepRecord[];
  said: string[];
  /** Requests sent so far. */
  requests: number;
  callsUsed: number;
  /** Accepted calls that changed the stack. */
  changes: number;
  rejectedTotal: number;
  /** Rounds in a row that contained a rejected call (reset by a round of clean work). */
  rejectRounds: number;
  usedJsonMode: boolean;
};

type Stop = { readonly reason: TurnStopReason; readonly error?: ProviderError };

/** Folds a round into the state and returns the reason to stop, or null to ask again. */
function absorbRound(state: TurnState, round: RoundOutcome, limits: TurnLimits): Stop | null {
  state.held = round.held;
  state.steps.push(...round.steps);
  state.said.push(...round.said);
  state.messages.push(...round.messages);
  state.callsUsed += round.callsHandled;
  state.changes += round.changes;
  state.rejectedTotal += round.rejected;

  // A round with a rejection extends the run of repair rounds. A round of clean work ends it.
  // A round that only talks leaves it alone, so "the model gave up" still counts as unrepaired.
  if (round.rejected > 0) state.rejectRounds += 1;
  else if (round.workCalls > 0) state.rejectRounds = 0;

  if (round.callLimitHit) return { reason: 'limit-calls' };
  if (state.rejectedTotal >= limits.maxRejected) return { reason: 'repair-exhausted' };
  if (round.rejected > 0 && state.rejectRounds >= limits.maxRepairRounds + 1) {
    return { reason: 'repair-exhausted' };
  }
  if (round.workCalls === 0) return { reason: 'finished' };
  return null;
}

/**
 * Status rules of the design, step 4. `changes` counts accepted calls that changed the stack,
 * so a Turn that only talked (or only said things next to rejected calls) has none.
 */
function decideStatus(state: TurnState, stop: Stop): TurnResult['status'] {
  if (stop.reason === 'aborted') return 'aborted';
  if (state.changes === 0) {
    const stoppedEarly = stop.reason !== 'finished';
    return state.rejectedTotal > 0 || stoppedEarly ? 'failed' : 'done';
  }
  if (stop.reason !== 'finished') return 'partial';
  // Finished, but the last round that did work still had a rejection nobody repaired.
  return state.rejectRounds > 0 ? 'partial' : 'done';
}

function buildResult(input: TurnInput, state: TurnState, stop: Stop): TurnResult {
  const result: TurnResult = {
    status: decideStatus(state, stop),
    before: input.newStack ? null : input.stack,
    after: state.held,
    steps: state.steps,
    say: state.said,
    stopReason: stop.reason,
    providerKind: input.provider.kind,
    usedJsonMode: state.usedJsonMode,
    rounds: state.requests,
  };
  return stop.error === undefined ? result : { ...result, error: stop.error };
}

/* ------------------------------------------------------------------------------------------ */
/* The loop                                                                                    */
/* ------------------------------------------------------------------------------------------ */

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** The system prompt and the first messages, for a mode, from the stack as it stands now. */
function startConversation(
  input: TurnInput,
  held: Stack,
  registry: ReturnType<typeof buildToolRegistry>,
  userMessage: string,
  jsonMode: boolean,
): ChatMessage[] {
  const systemPrompt = buildSystemPrompt({
    mode: jsonMode ? 'json' : 'native',
    newStack: input.newStack,
    tools: registry,
  });
  const context = buildContext(held, input.currentCardId, input.selectedObjectId);
  return initialMessages(systemPrompt, input.history, firstUserMessage(context.text, userMessage));
}

/** Handles a native reply. Returns the reason to stop, or null to ask again. */
function handleNativeReply(
  input: TurnInput,
  state: TurnState,
  limits: TurnLimits,
  reply: ChatReply,
): Stop | null {
  state.messages.push(assistantMessage(reply));
  if (reply.toolCalls.length === 0 || reply.noMatch === true) {
    // No tool calls: the model is done. Its text is what it says to the user.
    const text = reply.content?.trim() ?? '';
    if (text !== '') state.said.push(text);
    return { reason: 'finished' };
  }
  const round = applyNativeRound(
    state.held,
    reply.toolCalls,
    input.newStack,
    { callsUsed: state.callsUsed, rejectedTotal: state.rejectedTotal },
    limits,
  );
  return absorbRound(state, round, limits);
}

/**
 * Handles a JSON-mode reply. Only `content` is read (a provider that returns tool calls anyway
 * is ignored). A reply that cannot be read is a rejected step for the repair loop; a `noMatch`
 * reply (the recorded provider found no scenario) is plain text and ends the Turn.
 */
function handleJsonReply(
  input: TurnInput,
  state: TurnState,
  limits: TurnLimits,
  reply: ChatReply,
): Stop | null {
  const content = reply.content ?? '';
  state.messages.push({ role: 'assistant', content });
  if (reply.noMatch === true) {
    const text = content.trim();
    if (text !== '') state.said.push(text);
    return { reason: 'finished' };
  }
  const parsed = parseJsonReply(content);
  const round = parsed.ok
    ? applyJsonRound(
        state.held,
        parsed.reply,
        input.newStack,
        { callsUsed: state.callsUsed, rejectedTotal: state.rejectedTotal },
        limits,
      )
    : rejectedJsonReply(state.held, parsed.errors);
  return absorbRound(state, round, limits);
}

async function runLoop(input: TurnInput, state: TurnState): Promise<Stop> {
  const limits = resolveLimits(input.limits);
  const userMessage = input.userMessage.trim();
  if (userMessage === '' || codePointLength(userMessage) > MAX_USER_MESSAGE) {
    return { reason: 'empty-message' };
  }

  const registry = buildToolRegistry({ newStack: input.newStack });
  const tools = toOpenAiTools(registry);
  let jsonMode = input.jsonMode;
  state.usedJsonMode = jsonMode;
  state.messages = startConversation(input, state.held, registry, userMessage, jsonMode);

  const startedAt = input.clock();
  for (;;) {
    if (isAborted(input.signal)) return { reason: 'aborted' };
    if (input.clock() - startedAt >= limits.maxMs) return { reason: 'limit-time' };
    if (state.requests >= limits.maxRequests) return { reason: 'limit-requests' };

    const request: ChatRequest = {
      messages: [...state.messages],
      // JSON mode sends no tool list: the tools are described in the system prompt instead.
      ...(jsonMode ? {} : { tools }),
      meta: {
        userMessage,
        round: state.requests,
        currentCardId: input.currentCardId,
        selectedObjectId: input.selectedObjectId,
      },
    };
    state.requests += 1;
    const result = await input.provider.chat(request, input.signal);

    // A reply that arrives after the user pressed stop is dropped, never applied.
    if (isAborted(input.signal)) return { reason: 'aborted' };
    if (!result.ok) {
      if (result.error.code === 'ABORTED') return { reason: 'aborted' };
      if (result.error.code === 'BAD_REQUEST' && request.tools !== undefined) {
        // The provider refused a request that carried tools. Switch to JSON mode once: rebuild
        // the system prompt and the first message (from the stack as it stands, in case a
        // native round was already accepted), and ask again without tools. The failed request
        // is not counted. The retry has no tools, so a second BAD_REQUEST falls through to the
        // provider error below: there is no second switch.
        state.requests -= 1;
        jsonMode = true;
        state.usedJsonMode = true;
        state.messages = startConversation(input, state.held, registry, userMessage, true);
        continue;
      }
      return { reason: 'provider-error', error: result.error };
    }

    const stop = jsonMode
      ? handleJsonReply(input, state, limits, result.reply)
      : handleNativeReply(input, state, limits, result.reply);
    if (stop !== null) return stop;
  }
}

/**
 * Runs one Turn. Never rejects and never throws: expected failures (provider errors, rejected
 * calls, limits, abort) are values in the result, and the stack in the result is valid for any
 * model output because it only ever holds results of accepted `applyOperation` calls.
 */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const state: TurnState = {
    held: input.stack,
    messages: [],
    steps: [],
    said: [],
    requests: 0,
    callsUsed: 0,
    changes: 0,
    rejectedTotal: 0,
    rejectRounds: 0,
    usedJsonMode: false,
  };
  let stop: Stop;
  try {
    stop = await runLoop(input, state);
  } catch {
    // The one try/catch of this module, a safety net for programmer errors (and for a provider
    // that breaks its "never throws" contract). `state.held` only ever holds accepted results,
    // so the work done so far is kept and the Turn ends with a generic error.
    stop = { reason: 'provider-error', error: providerError('SERVER') };
  }
  return buildResult(input, state, stop);
}
