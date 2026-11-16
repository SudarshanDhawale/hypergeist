/**
 * The bundled demo scenarios: the data the recorded provider plays back. Every `.json` file
 * placed directly in `ai/scenarios/` becomes a scenario, so adding a file adds a scenario with
 * no code change. Files are external data: each one is parsed with `ScenarioSchema`, and a bad
 * file is reported in `problems` and skipped, never thrown.
 *
 * Pure apart from the build-time file glob: no clock, randomness, network or console output.
 */
import { z } from 'zod';

/** Same pattern as the Entity ID of the stack format (conventions: entity ids). */
const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const SCENARIO_LIMITS = Object.freeze({
  prompts: { min: 1, max: 10 },
  promptLength: { min: 1, max: 200 },
  replies: { min: 1, max: 12 },
  toolCallsPerReply: { max: 40 },
  title: { min: 1, max: 100 },
  content: { max: 4000 },
  toolName: { min: 1, max: 64 },
});

/**
 * Normalizes a prompt for exact matching: trim, lower-case, collapse runs of white space to one
 * space, and strip trailing `.`, `!` and `?`. Pure and idempotent.
 */
export function normalizePrompt(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
}

const ScenarioToolCallSchema = z.strictObject({
  name: z.string().min(SCENARIO_LIMITS.toolName.min).max(SCENARIO_LIMITS.toolName.max),
  /** Plain JSON. Strings may hold `{{currentCardId}}` and `{{selectedObjectId}}`. */
  arguments: z.record(z.string(), z.json()),
});

const ScenarioReplySchema = z.strictObject({
  content: z.string().max(SCENARIO_LIMITS.content.max).optional(),
  toolCalls: z.array(ScenarioToolCallSchema).max(SCENARIO_LIMITS.toolCallsPerReply.max).optional(),
});

export const ScenarioSchema = z.strictObject({
  id: z.string().regex(SCENARIO_ID_PATTERN),
  title: z.string().min(SCENARIO_LIMITS.title.min).max(SCENARIO_LIMITS.title.max),
  prompts: z
    .array(
      z
        .string()
        .min(SCENARIO_LIMITS.promptLength.min)
        .max(SCENARIO_LIMITS.promptLength.max)
        .refine((prompt) => normalizePrompt(prompt) !== '', {
          message: 'A prompt must hold more than white space and end punctuation.',
        }),
    )
    .min(SCENARIO_LIMITS.prompts.min)
    .max(SCENARIO_LIMITS.prompts.max),
  mode: z.enum(['new-stack', 'edit', 'text']),
  replies: z
    .array(ScenarioReplySchema)
    .min(SCENARIO_LIMITS.replies.min)
    .max(SCENARIO_LIMITS.replies.max),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioReply = Scenario['replies'][number];

/** A scenario file that could not be used, with a plain reason. */
export type ScenarioProblem = {
  /** The file key as given, for example `./scenarios/add-a-button.json`. */
  readonly file: string;
  readonly message: string;
};

export type ScenarioSet = {
  /** Valid, unique scenarios, in file name order. */
  readonly scenarios: readonly Scenario[];
  /** Files that were skipped, in file name order. */
  readonly problems: readonly ScenarioProblem[];
};

const bundledFiles: Record<string, string> = import.meta.glob<string>('./scenarios/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Compares by UTF-16 code units, so the order does not depend on the locale. */
function byFileName(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** One line per schema issue: the JSON Pointer path and the Zod message (never the input). */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.map((part) => `/${String(part)}`).join('');
      return `${path === '' ? '(file)' : path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Parses the bundled scenarios. Never throws. A file is skipped, and listed in `problems`, when
 * it is not valid JSON, does not match `ScenarioSchema`, repeats the id of an earlier scenario,
 * or shares a normalized prompt with an earlier scenario. `files` maps a file name to its text;
 * tests use it to inject content. The input is not modified.
 */
export function loadScenarios(files: Readonly<Record<string, string>> = bundledFiles): ScenarioSet {
  const scenarios: Scenario[] = [];
  const problems: ScenarioProblem[] = [];
  const seenIds = new Set<string>();
  const promptOwners = new Map<string, string>();

  for (const file of Object.keys(files).sort(byFileName)) {
    let json: unknown;
    try {
      json = JSON.parse(files[file] ?? '');
    } catch {
      problems.push({ file, message: 'The file is not valid JSON.' });
      continue;
    }

    const parsed = ScenarioSchema.safeParse(json);
    if (!parsed.success) {
      problems.push({
        file,
        message: `The file is not a valid scenario. ${describeIssues(parsed.error)}`,
      });
      continue;
    }
    const scenario = parsed.data;

    if (seenIds.has(scenario.id)) {
      problems.push({
        file,
        message: `The scenario id "${scenario.id}" is already used by an earlier file.`,
      });
      continue;
    }

    const shared = scenario.prompts.map(normalizePrompt).find((prompt) => promptOwners.has(prompt));
    if (shared !== undefined) {
      problems.push({
        file,
        message: `The prompt "${shared}" is already used by scenario "${promptOwners.get(shared) ?? ''}".`,
      });
      continue;
    }

    seenIds.add(scenario.id);
    for (const prompt of scenario.prompts) promptOwners.set(normalizePrompt(prompt), scenario.id);
    scenarios.push(scenario);
  }

  return { scenarios, problems };
}
