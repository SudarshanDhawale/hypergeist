/**
 * The tool registry: what the model may call, in three forms from one definition (the
 * OpenAI `tools` array, a plain-text list for JSON mode, and the parser for what comes back).
 *
 * The seven stack Operations come from `OPERATIONS` and `operationJsonSchema`, never from a
 * second hand-written copy. Two more tools are local: `say` (talk to the user) and
 * `create_stack` (name a new stack). Pure: no clock, randomness, network or DOM.
 */
import { OPERATION_NAMES, OPERATIONS, operationJsonSchema } from '@hypergeist/shared/engine';
import type { OperationName } from '@hypergeist/shared/engine';
import {
  LIMITS,
  StackSchema,
  checkAgainstSchema,
  createValidationError,
} from '@hypergeist/shared/format';
import type { ValidationError } from '@hypergeist/shared/format';
import { z } from 'zod';
import type { OpenAiTool } from './types.ts';

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

/** One tool as the model sees it. `parameters` is a JSON Schema object (draft 2020-12). */
export type ToolEntry = {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
};

export type ToolProfile = 'compact' | 'full';

export type BuildToolRegistryOptions = {
  readonly newStack: boolean;
  /** Defaults to `compact`. */
  readonly profile?: ToolProfile;
};

/** The names of the two tools that are not Operations. */
export const SAY_TOOL_NAME = 'say';
export const CREATE_STACK_TOOL_NAME = 'create_stack';

export type ToolName = OperationName | typeof SAY_TOOL_NAME | typeof CREATE_STACK_TOOL_NAME;

/** Largest size, in code points, of the text of one `say` call. */
const SAY_TEXT_MAX = 2000;

/**
 * The most characters the JSON text of the compact OpenAI `tools` array may have. A budget,
 * not a target: free-tier token limits are tight. Do not raise it; tighten `compactSchema`.
 * Measured on 2026-11-15 with `create_stack` included (the largest registry): 11,514
 * characters compact (11,200 without `create_stack`), against 26,717 full (the seven
 * Operation schemas alone are 23,668). `tools.test.ts` checks the budget.
 */
export const COMPACT_TOOLS_BUDGET = 12_000;

/* ------------------------------------------------------------------------------------------ */
/* JSON helpers                                                                                */
/* ------------------------------------------------------------------------------------------ */

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copies a JSON-like value into plain `JsonValue` data (a deep copy, so the result never
 * shares structure with the input). Anything that is not JSON (undefined, functions,
 * symbols) is dropped from objects and becomes `null` in arrays, as `JSON.stringify` does.
 */
function toJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item): JsonValue => toJson(item));
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      out[key] = toJson(item);
    }
    return out;
  }
  return null;
}

function toJsonObject(value: unknown): JsonObject {
  const json = toJson(value);
  return isJsonObject(json) ? json : {};
}

/* ------------------------------------------------------------------------------------------ */
/* compactSchema                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** Keywords removed by `compactSchema`: metadata and limits. The engine enforces every limit. */
const DROPPED_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  'title',
  'default',
  'pattern',
  'maxLength',
  'minLength',
  'maxItems',
  'minItems',
  'maximum',
  'minimum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'format',
  'uniqueItems',
]);

/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set([
  'anyOf',
  'oneOf',
  'allOf',
  'prefixItems',
]);
/** Keywords whose value is a map from a name to a schema. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set(['properties', '$defs']);

const DESCRIPTION_MAX = 100;

/**
 * The first sentence of `text` (a colon also ends it, because a long sentence often goes on
 * as a list), cut to at most `max` code points (a cut ends with an ellipsis).
 */
function firstSentence(text: string, max: number): string {
  const trimmed = text.trim();
  const match = /^[\s\S]*?[.!?:](?=\s|$)/.exec(trimmed);
  const found = match === null ? trimmed : match[0];
  const sentence = found.endsWith(':') ? `${found.slice(0, -1)}.` : found;
  const points = [...sentence];
  if (points.length <= max) return sentence;
  return `${points
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

/** Types whose property name and type already say enough; their description is dropped. */
const SELF_EXPLAINING_TYPES: ReadonlySet<unknown> = new Set(['integer', 'number', 'boolean']);

function compactNode(node: JsonValue, depth: number): JsonValue {
  if (!isJsonObject(node)) return node;
  const out: Record<string, JsonValue> = {};
  const next = depth + 1;
  const selfExplaining = SELF_EXPLAINING_TYPES.has(node['type']);
  const fixedValue = 'const' in node || 'enum' in node;
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    // `const` and `enum` already fix the type, so a `type` next to them is a repeat.
    if (key === 'type' && fixedValue && typeof value === 'string') continue;
    if (key === 'description') {
      if (typeof value === 'string' && !selfExplaining) {
        out[key] = firstSentence(value, DESCRIPTION_MAX);
      }
      continue;
    }
    // Below the root, `additionalProperties: false` is only a repeat of the engine's check.
    if (key === 'additionalProperties' && value === false && depth > 0) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
      // The keys here are property names, not keywords, so only the values are schemas.
      const mapped: Record<string, JsonValue> = {};
      for (const [name, sub] of Object.entries(value)) mapped[name] = compactNode(sub, next);
      out[key] = mapped;
    } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      out[key] = value.map((sub): JsonValue => compactNode(sub, next));
    } else if (key === 'items' || key === 'additionalProperties') {
      // A schema, a boolean, or (for `items`) a list of schemas.
      out[key] = Array.isArray(value)
        ? value.map((sub): JsonValue => compactNode(sub, next))
        : compactNode(value, next);
    } else {
      // `type`, `enum`, `const`, `required`, `$ref` and anything else: copied as data.
      out[key] = toJson(value);
    }
  }
  return out;
}

/**
 * Pure. Returns a copy of a JSON Schema with limit keywords removed (the engine enforces every
 * limit) and every `description` cut to its first sentence of at most 100 characters.
 * Structure is kept: `properties` (every name), `required`, `items`, `anyOf`, `oneOf`,
 * `allOf`, `$ref`, `$defs`, `enum`, `const`, `type` and the root `additionalProperties`.
 * To fit the size budget three things are also left out, none of which removes a property:
 * the `type` next to a `const` or `enum` (it repeats it), the description of an integer,
 * number or boolean property (its name and type say enough), and `additionalProperties:
 * false` below the root.
 */
export function compactSchema(schema: JsonObject): JsonObject {
  const compacted = compactNode(schema, 0);
  return isJsonObject(compacted) ? compacted : {};
}

/* ------------------------------------------------------------------------------------------ */
/* The two local tools                                                                         */
/* ------------------------------------------------------------------------------------------ */

/*
 * Each tool has one definition: a strict Zod schema. Its JSON Schema comes from
 * `z.toJSONSchema` and its checker is `checkAgainstSchema` on the same schema, so the model
 * is told exactly what the parser enforces. `create_stack` reuses the format's own stack
 * name schema.
 */

const SAY_DESCRIPTION =
  'Say something to the user in plain words, without changing the stack. Use it to explain what you did or to ask a question.';

const CREATE_STACK_DESCRIPTION =
  'Give the new stack a name. Call it once, first, when you start from an empty stack.';

/**
 * The message for the user: 1 to 2000 characters. The maximum counts code points, as the
 * format does for its own text (`z.string().max()` counts UTF-16 units, so 2000 emoji would
 * be refused). The `maxLength` metadata keeps the bound in the JSON Schema, because a custom
 * check is invisible to `z.toJSONSchema`. Same pattern as `text()` in the format's schemas.
 */
const SayTextSchema = z
  .string()
  .min(1)
  .check((ctx) => {
    // UTF-16 length is never smaller than the code point count, so the cheap test goes first.
    if (ctx.value.length > SAY_TEXT_MAX && [...ctx.value].length > SAY_TEXT_MAX) {
      ctx.issues.push({
        code: 'too_big',
        origin: 'string',
        maximum: SAY_TEXT_MAX,
        inclusive: true,
        input: ctx.value,
      });
    }
  })
  .meta({
    maxLength: SAY_TEXT_MAX,
    description: `The message for the user. A string of 1 to ${SAY_TEXT_MAX} characters. Required.`,
  });

export const SayParamsSchema = z.strictObject({ text: SayTextSchema });

export const CreateStackParamsSchema = z.strictObject({
  name: StackSchema.shape.name.meta({
    description: `The name of the stack. A string of ${LIMITS.stackName.min} to ${LIMITS.stackName.max} characters. Required.`,
  }),
});

const SAY_PARAMETERS: JsonObject = toJsonObject(z.toJSONSchema(SayParamsSchema));
const CREATE_STACK_PARAMETERS: JsonObject = toJsonObject(z.toJSONSchema(CreateStackParamsSchema));

/* ------------------------------------------------------------------------------------------ */
/* The registry                                                                                */
/* ------------------------------------------------------------------------------------------ */

function entryFor(
  name: string,
  description: string,
  parameters: JsonObject,
  profile: ToolProfile,
): ToolEntry {
  if (profile === 'full') return { name, description, parameters };
  // The tool description already says what the tool does, so the top-level `description`
  // inside the parameters (a repeat of it) is dropped from the compact profile.
  const { description: _repeated, ...rest } = compactSchema(parameters);
  void _repeated;
  return { name, description, parameters: rest };
}

/**
 * Pure and deterministic: building twice gives deeply equal values. The seven Operations
 * (name and description from `OPERATIONS`, parameters from `operationJsonSchema`), then
 * `say`, then `create_stack` only when `newStack` is true. The compact profile (the default)
 * keeps the structure and drops limit keywords and long descriptions.
 */
export function buildToolRegistry(options: BuildToolRegistryOptions): readonly ToolEntry[] {
  const profile = options.profile ?? 'compact';
  const entries: ToolEntry[] = OPERATIONS.map((operation) =>
    entryFor(
      operation.name,
      operation.description,
      toJsonObject(operationJsonSchema(operation.name)),
      profile,
    ),
  );
  entries.push(entryFor(SAY_TOOL_NAME, SAY_DESCRIPTION, SAY_PARAMETERS, profile));
  if (options.newStack) {
    entries.push(
      entryFor(CREATE_STACK_TOOL_NAME, CREATE_STACK_DESCRIPTION, CREATE_STACK_PARAMETERS, profile),
    );
  }
  return entries;
}

/** The OpenAI `tools` array. */
export function toOpenAiTools(registry: readonly ToolEntry[]): readonly OpenAiTool[] {
  return registry.map((entry): OpenAiTool => ({
    type: 'function',
    function: { name: entry.name, description: entry.description, parameters: entry.parameters },
  }));
}

/* ------------------------------------------------------------------------------------------ */
/* Plain-text form for JSON mode                                                               */
/* ------------------------------------------------------------------------------------------ */

function typeLabel(schema: JsonValue | undefined): string {
  if (!isJsonObject(schema)) return 'value';
  const { enum: enumValues, type, items, oneOf, anyOf } = schema;
  if (Array.isArray(enumValues))
    return `one of ${enumValues.map((v) => JSON.stringify(v)).join(', ')}`;
  if (type === 'array') return `array of ${typeLabel(Array.isArray(items) ? undefined : items)}`;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.map((t) => String(t)).join(' or ');
  const variants = Array.isArray(oneOf) ? oneOf : Array.isArray(anyOf) ? anyOf : undefined;
  if (variants !== undefined) return `one of ${variants.length} shapes`;
  return 'value';
}

/**
 * A plain list for JSON mode: for each tool its name, a one-line description, and its
 * parameter names with their types (`*` marks a required one). Deterministic.
 */
export function toPromptText(registry: readonly ToolEntry[]): string {
  const lines = registry.map((entry) => {
    const properties = entry.parameters['properties'];
    const required = entry.parameters['required'];
    const requiredNames = new Set(Array.isArray(required) ? required.map((r) => String(r)) : []);
    const parts = isJsonObject(properties)
      ? Object.entries(properties).map(
          ([name, schema]) => `${name}${requiredNames.has(name) ? '*' : ''} (${typeLabel(schema)})`,
        )
      : [];
    const parameters = parts.length === 0 ? 'none' : parts.join(', ');
    return `- ${entry.name}: ${firstSentence(entry.description, 200)} Parameters: ${parameters}.`;
  });
  return lines.join('\n');
}

/* ------------------------------------------------------------------------------------------ */
/* parseToolCall                                                                               */
/* ------------------------------------------------------------------------------------------ */

type ParsedFailure = { readonly ok: false; readonly errors: readonly ValidationError[] };

export type ParsedToolCall =
  | { readonly ok: true; readonly name: OperationName; readonly params: JsonObject }
  | {
      readonly ok: true;
      readonly name: typeof SAY_TOOL_NAME;
      readonly params: { readonly text: string };
    }
  | {
      readonly ok: true;
      readonly name: typeof CREATE_STACK_TOOL_NAME;
      readonly params: { readonly name: string };
    }
  | ParsedFailure;

const OPERATION_NAME_LIST: readonly string[] = OPERATION_NAMES;

function isOperationName(name: string): name is OperationName {
  // An array lookup, not an object lookup, so `constructor` and `__proto__` are unknown.
  return OPERATION_NAME_LIST.includes(name);
}

function failed(error: ValidationError): ParsedToolCall {
  return { ok: false, errors: [error] };
}

/**
 * Checks `params` against a tool's Zod schema with `checkAgainstSchema`, so the errors keep
 * the `Validation_Error` shape of `validateStack`. Their paths move under `/arguments`. The
 * format's mapper puts a missing property at its parent; here it is reported at the property
 * itself (`/arguments/<name>`), so the model sees which parameter to add.
 */
function checkParams<S extends z.ZodType>(
  schema: S,
  params: JsonObject,
  required: readonly string[],
): { readonly ok: true; readonly value: z.infer<S> } | ParsedFailure {
  const checked = checkAgainstSchema(schema, params);
  if (checked.ok) return { ok: true, value: checked.value };
  const errors = checked.errors
    .filter((error) => !(error.code === 'MISSING_PROPERTY' && error.path === ''))
    .map((error) => ({ ...error, path: `/arguments${error.path}` }));
  for (const key of required) {
    if (Object.hasOwn(params, key)) continue;
    errors.push(
      createValidationError({
        code: 'MISSING_PROPERTY',
        path: `/arguments/${key}`,
        message: `The required parameter "${key}" is missing.`,
        expected: `a parameter "${key}"`,
        hint: `Add the parameter "${key}".`,
      }),
    );
  }
  return { ok: false, errors };
}

function checkSayParams(params: JsonObject): ParsedToolCall {
  const checked = checkParams(SayParamsSchema, params, ['text']);
  if (!checked.ok) return checked;
  return { ok: true, name: SAY_TOOL_NAME, params: { text: checked.value.text } };
}

function checkCreateStackParams(params: JsonObject): ParsedToolCall {
  const checked = checkParams(CreateStackParamsSchema, params, ['name']);
  if (!checked.ok) return checked;
  return { ok: true, name: CREATE_STACK_TOOL_NAME, params: { name: checked.value.name } };
}

/**
 * Parses one tool call as the model wrote it. Total: never throws. Unknown tool names,
 * arguments that are not JSON text, arguments that are not a JSON object, and bad `say` or
 * `create_stack` parameters come back as `Validation_Error` values at `/tool` or
 * `/arguments`. Operation parameters are only checked to be an object here: `applyOperation`
 * checks the rest. It does not know whether `create_stack` was offered; the Turn decides.
 */
export function parseToolCall(name: string, rawArguments: string): ParsedToolCall {
  const isOperation = isOperationName(name);
  if (!isOperation && name !== SAY_TOOL_NAME && name !== CREATE_STACK_TOOL_NAME) {
    return failed(
      createValidationError({
        code: 'INVALID_VALUE',
        path: '/tool',
        message: 'The tool name is not one of the tools.',
        expected: `one of ${[...OPERATION_NAMES, SAY_TOOL_NAME, CREATE_STACK_TOOL_NAME].join(', ')}`,
        actual: name,
        hint: 'Call only the tools you were given.',
      }),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return failed(
      createValidationError({
        code: 'INVALID_JSON',
        path: '/arguments',
        message: 'The arguments are not valid JSON text.',
        expected: 'a JSON object as text',
        actual: rawArguments,
        hint: 'Send the arguments as one JSON object, for example {"name": "Notes"}.',
      }),
    );
  }
  if (!isJsonObject(parsed)) {
    return failed(
      createValidationError({
        code: 'WRONG_TYPE',
        path: '/arguments',
        message: 'The arguments must be a JSON object.',
        expected: 'a JSON object',
        actual: parsed,
        hint: 'Send the arguments as one JSON object with the parameter names as keys.',
      }),
    );
  }
  const params = toJsonObject(parsed);
  if (isOperation) return { ok: true, name, params };
  return name === SAY_TOOL_NAME ? checkSayParams(params) : checkCreateStackParams(params);
}
