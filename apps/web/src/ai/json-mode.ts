import { checkAgainstSchema, createValidationError } from '@hypergeist/shared/format';
import type { ValidationError } from '@hypergeist/shared/format';
import { z } from 'zod';

/**
 * JSON mode: the fallback for a model without tool calling. The model replies with one JSON
 * object `{ "calls": [ { "tool": ..., "params": ... } ], "say": ... }`. This module finds that
 * object in the reply text and checks its shape. Pure: no clock, randomness, network or DOM.
 */

/** The most calls one JSON reply may carry. */
export const MAX_JSON_CALLS = 40;

/**
 * The shape of a JSON-mode reply. `params` is the unvalidated object that goes to
 * `applyOperation` exactly like native tool-call arguments, so it stays `unknown` here.
 */
export const JsonReplySchema = z.strictObject({
  calls: z.array(z.strictObject({ tool: z.string(), params: z.unknown() })).max(MAX_JSON_CALLS),
  say: z.string().max(2000).optional(),
});

export type JsonReply = z.infer<typeof JsonReplySchema>;

export type ExtractJsonFailure = 'NO_JSON' | 'UNTERMINATED' | 'INVALID_JSON';

export type ExtractJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly reason: ExtractJsonFailure;
      readonly errors: readonly ValidationError[];
    };

export type ParseJsonReplyResult =
  | { readonly ok: true; readonly reply: JsonReply }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

const OPEN_BRACE = 0x7b; // {
const CLOSE_BRACE = 0x7d; // }
const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \

type ScanOutcome =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unterminated' }
  | { readonly kind: 'none' };

/**
 * Scans `text` once, left to right, for top-level `{...}` spans and returns the first one that
 * parses. A string- and escape-aware depth counter finds the end of each span, so a brace inside
 * a JSON string does not count. A span that is balanced but is not valid JSON (for example
 * `{an example}` in prose) is skipped and scanning continues after its closing brace. Spans do
 * not overlap, so the whole scan is linear in the length of the text. A `{` that is never closed
 * ends the scan: the text after it is not searched again, which would be quadratic.
 */
function scanForObject(text: string): ScanOutcome {
  const length = text.length;
  let sawInvalid = false;
  let position = text.indexOf('{');
  while (position !== -1) {
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let index = position; index < length; index += 1) {
      const code = text.charCodeAt(index);
      if (inString) {
        if (code === BACKSLASH) {
          index += 1; // skip the escaped character
        } else if (code === QUOTE) {
          inString = false;
        }
      } else if (code === QUOTE) {
        inString = true;
      } else if (code === OPEN_BRACE) {
        depth += 1;
      } else if (code === CLOSE_BRACE) {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) return sawInvalid ? { kind: 'invalid' } : { kind: 'unterminated' };
    try {
      const value: unknown = JSON.parse(text.slice(position, end + 1));
      return { kind: 'value', value };
    } catch {
      sawInvalid = true; // not JSON: look for the next span after this one
    }
    position = text.indexOf('{', end + 1);
  }
  return sawInvalid ? { kind: 'invalid' } : { kind: 'none' };
}

/**
 * The text inside the first Markdown code fence (three backticks, an optional language word on
 * the opening line, then the body up to the closing fence), or `null` when there is none. An
 * unclosed fence, as in a reply cut off by the length limit, yields the rest of the text.
 */
function firstFenceBody(text: string): string | null {
  const open = text.indexOf('```');
  if (open === -1) return null;
  const lineEnd = text.indexOf('\n', open + 3);
  const bodyStart = lineEnd === -1 ? open + 3 : lineEnd + 1;
  const close = text.indexOf('```', bodyStart);
  return close === -1 ? text.slice(bodyStart) : text.slice(bodyStart, close);
}

const FAILURE_TEXT: Record<
  ExtractJsonFailure,
  { readonly message: string; readonly hint: string }
> = {
  NO_JSON: {
    message: 'The reply contains no JSON object.',
    hint: 'Reply with only one JSON object of the form {"calls":[{"tool":"...","params":{}}],"say":"..."}.',
  },
  UNTERMINATED: {
    message: 'The JSON object in the reply is not closed.',
    hint: 'Reply with one complete JSON object. Keep it short so it is not cut off.',
  },
  INVALID_JSON: {
    message: 'The JSON object in the reply could not be read.',
    hint: 'Use double quotes for all names and strings, and no trailing commas or comments.',
  },
};

function extractFailure(reason: ExtractJsonFailure): ExtractJsonResult {
  const text = FAILURE_TEXT[reason];
  return {
    ok: false,
    reason,
    errors: [
      createValidationError({
        code: 'INVALID_JSON',
        path: '',
        message: text.message,
        expected: 'one JSON object',
        hint: text.hint,
      }),
    ],
  };
}

/**
 * Finds the first JSON object in a model reply and parses it. Tolerates a Markdown code fence
 * (with or without `json`) and any text before or after. The first object wins. The scan is a
 * linear pass with a depth counter, never a regular expression, so a long reply cannot make it
 * slow. Never throws. Limitation: a stray, unclosed `{` in prose before the real object hides
 * the object (it is reported as `UNTERMINATED`), because looking again from every `{` would be
 * quadratic.
 */
export function extractJson(text: string): ExtractJsonResult {
  const fenced = firstFenceBody(text);
  if (fenced !== null) {
    const inFence = scanForObject(fenced);
    if (inFence.kind === 'value') return { ok: true, value: inFence.value };
  }
  const outcome = scanForObject(text);
  switch (outcome.kind) {
    case 'value':
      return { ok: true, value: outcome.value };
    case 'invalid':
      return extractFailure('INVALID_JSON');
    case 'unterminated':
      return extractFailure('UNTERMINATED');
    case 'none':
      return extractFailure('NO_JSON');
  }
}

/**
 * `extractJson` followed by `JsonReplySchema`. Both failures come back as `ValidationError`
 * values ready for `buildRepairMessage`. Schema error paths are relative to the reply object
 * (for example `/calls/0/tool`).
 */
export function parseJsonReply(text: string): ParseJsonReplyResult {
  const extracted = extractJson(text);
  if (!extracted.ok) return { ok: false, errors: extracted.errors };
  const checked = checkAgainstSchema(JsonReplySchema, extracted.value);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  return { ok: true, reply: checked.value };
}
