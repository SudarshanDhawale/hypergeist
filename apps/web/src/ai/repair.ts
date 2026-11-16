import type { ValidationError } from '@hypergeist/shared/format';

/**
 * The repair message: what the model gets back as the tool result when a call was rejected.
 * It is built only from the error fields `code`, `path`, `message`, `expected` and `hint`, so no
 * key, base URL or outside data can enter. The offending value (`actual`) is left out on
 * purpose. Pure: no clock, randomness, network or DOM.
 */

/** The longest repair message, in characters. */
export const REPAIR_MESSAGE_MAX_CHARS = 1500;

/** The longest tool name echoed back, in characters. */
const TOOL_NAME_MAX_CHARS = 64;

/** The longest piece of one error field kept, in characters. */
const FIELD_MAX_CHARS = 200;

/** Room kept for the tail "and N more problems." (N has at most 7 digits in practice). */
const MORE_PROBLEMS_RESERVE = 40;

const FOOTER = 'Fix the call and try again, or skip this step.';

/** Collapses white space to single spaces and cuts to `max` characters with an ellipsis. */
function tidy(text: string, max: number): string {
  // Cut first so a huge input is never scanned in full; the white-space pattern is linear.
  const head = text.length > max * 2 ? text.slice(0, max * 2) : text;
  const flat = head.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // do not split a surrogate pair
  return `${cut}…`;
}

/** The tool name comes from the model, so it is reduced to a safe, short token. */
function safeToolName(toolName: string): string {
  const token = toolName.slice(0, TOOL_NAME_MAX_CHARS).replace(/[^A-Za-z0-9_.-]/g, '_');
  return token === '' ? 'unknown' : token;
}

function describeError(error: ValidationError, position: number): string {
  const path = error.path === '' ? 'the top level' : tidy(error.path, FIELD_MAX_CHARS);
  const details = [`at ${path}`];
  const expected = tidy(error.expected, FIELD_MAX_CHARS);
  if (expected !== '') details.push(`expected ${expected}`);
  const hint = tidy(error.hint, FIELD_MAX_CHARS);
  if (hint !== '') details.push(`hint: ${hint}`);
  const message = tidy(error.message, FIELD_MAX_CHARS);
  return `${position}. ${error.code}: ${message} (${details.join('; ')})`;
}

/**
 * Builds the repair message for a rejected call. Errors are listed in input order until the
 * 1,500-character budget is reached, then the rest is counted as "and N more problems".
 * The result is always at most `REPAIR_MESSAGE_MAX_CHARS` characters. Never throws.
 */
export function buildRepairMessage(toolName: string, errors: readonly ValidationError[]): string {
  const header = `The call to ${safeToolName(toolName)} was rejected and nothing changed.`;
  if (errors.length === 0) return `${header} ${FOOTER}`;

  const budget = REPAIR_MESSAGE_MAX_CHARS - header.length - FOOTER.length - 'Problems: '.length - 4;
  const lines: string[] = [];
  let used = 0;
  for (const [index, error] of errors.entries()) {
    const line = describeError(error, index + 1);
    const isLast = index === errors.length - 1;
    // Leave room for the "and N more problems" tail unless this is the last error.
    const reserve = isLast ? 0 : MORE_PROBLEMS_RESERVE;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost + reserve > budget) break;
    lines.push(line);
    used += cost;
  }
  const omitted = errors.length - lines.length;
  const tail = omitted > 0 ? ` and ${omitted} more ${omitted === 1 ? 'problem' : 'problems'}.` : '';
  return `${header} Problems: ${lines.join(' ')}${tail} ${FOOTER}`;
}
