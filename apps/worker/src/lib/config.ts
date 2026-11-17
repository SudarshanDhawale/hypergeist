import { z } from 'zod';
import { PROVIDER_BINDINGS, PROVIDER_NAMES, type ProviderName } from '../env';

/**
 * Parses the Worker configuration (vars and secrets) into one typed object.
 *
 * Any problem gives `{ ok: false }` with no detail at all: no Zod issue, no
 * name of the failing field, no value. The chat handler maps both `ok: false`
 * and `enabled: false` to `AI_DISABLED`, and nothing about a secret can leak
 * through the failure path.
 */

/** Defaults. `wrangler.jsonc` mirrors these (a later test pins that). */
export const DEFAULTS = {
  visitorDailyCap: 60,
  dailyCap: 400,
  dailyTokenCap: 1_000_000,
  lifetimeCap: 6_000,
  lifetimeTokenCap: 6_000_000,
  maxOutputTokens: 2_048,
  providers: 'sarvam',
  enabled: true,
} as const;

/** Inclusive bounds for the numeric settings. */
export const BOUNDS = {
  capMin: 1,
  capMax: 10_000_000,
  maxOutputTokensMin: 1,
  maxOutputTokensMax: 4_096,
} as const;

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** A provider the Worker will call, with its key. The key is a secret. */
export type AiProviderConfig = {
  readonly name: ProviderName;
  readonly key: string;
  readonly model: string;
  /** Safe for logging: leaves out the key. */
  toJSON(): { readonly name: ProviderName; readonly model: string };
};

export type AiConfig = {
  readonly enabled: boolean;
  /** Exact allowed origins, no trailing slash, no duplicates. */
  readonly origins: readonly string[];
  /** Extra model names a client may ask for besides `auto`. May be empty. */
  readonly allowedModels: readonly string[];
  /** Ordered, unique, 1 to 2 entries; each has its key and model. */
  readonly providers: readonly AiProviderConfig[];
  readonly visitorDailyCap: number;
  readonly dailyCap: number;
  readonly dailyTokenCap: number;
  readonly lifetimeCap: number;
  readonly lifetimeTokenCap: number;
  readonly maxOutputTokens: number;
  readonly reasoningEffort: ReasoningEffort | null;
  /** Secret. */
  readonly salt: string;
  /** Safe for logging: leaves out every key and the salt. */
  toJSON(): RedactedAiConfig;
};

export type RedactedAiConfig = Omit<AiConfig, 'providers' | 'salt' | 'toJSON'> & {
  readonly providers: readonly { readonly name: ProviderName; readonly model: string }[];
};

export type ParseConfigResult = { ok: true; config: AiConfig } | { ok: false };

// ---- field schemas -------------------------------------------------------

/** Digits only (so no sign, no fraction, no exponent, no hex), at most 8. */
const intInRange = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^[0-9]{1,8}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const capSchema = (fallback: number) =>
  intInRange(BOUNDS.capMin, BOUNDS.capMax).optional().default(fallback);

function splitList(value: string): string[] {
  return value.split(',').map((part) => part.trim());
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/**
 * `https://host[:port]`, or `http://localhost[:port]` / `http://127.0.0.1[:port]`.
 * No path, no query, no fragment, no userinfo, no trailing slash. The entry
 * must equal its own canonical origin, so it is lowercase and carries no
 * default port: that is the form a browser puts in the `Origin` header.
 */
function isValidOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

const originSchema = z.string().refine(isValidOrigin);

/** Printable ASCII without spaces or commas, 1 to 100 characters. */
const modelNameSchema = z.string().regex(/^[\x21-\x2b\x2d-\x7e]{1,100}$/);

/** An API key goes into a header, so printable ASCII without spaces only. */
const keySchema = z
  .string()
  .trim()
  .regex(/^[\x21-\x7e]{1,512}$/);

const saltSchema = z.string().trim().min(1).max(512);

const RawEnvSchema = z.object({
  AI_ENABLED: z.unknown().optional(),
  AI_ALLOWED_ORIGINS: z.string().transform(splitList).pipe(z.array(originSchema).min(1).max(20)),
  AI_ALLOWED_MODELS: z
    .string()
    .optional()
    .default('')
    .transform((value) => (value.trim() === '' ? [] : splitList(value)))
    .pipe(z.array(modelNameSchema).max(50)),
  AI_PROVIDERS: z
    .string()
    .optional()
    .default(DEFAULTS.providers)
    .transform(splitList)
    .pipe(
      z
        .array(z.enum(PROVIDER_NAMES))
        .min(1)
        .max(PROVIDER_NAMES.length)
        .refine((names) => new Set(names).size === names.length),
    ),
  AI_VISITOR_DAILY_CAP: capSchema(DEFAULTS.visitorDailyCap),
  AI_DAILY_CAP: capSchema(DEFAULTS.dailyCap),
  AI_DAILY_TOKEN_CAP: capSchema(DEFAULTS.dailyTokenCap),
  AI_LIFETIME_CAP: capSchema(DEFAULTS.lifetimeCap),
  AI_LIFETIME_TOKEN_CAP: capSchema(DEFAULTS.lifetimeTokenCap),
  AI_MAX_OUTPUT_TOKENS: intInRange(BOUNDS.maxOutputTokensMin, BOUNDS.maxOutputTokensMax)
    .optional()
    .default(DEFAULTS.maxOutputTokens),
  AI_REASONING_EFFORT: z
    .string()
    .optional()
    .default('')
    .transform((value) => value.trim())
    .pipe(z.union([z.literal(''), z.enum(REASONING_EFFORTS)]))
    .transform((value) => (value === '' ? null : value)),
  QUOTA_SALT: saltSchema,
  // Only the listed providers' key and model are validated (below).
  SARVAM_API_KEY: z.unknown().optional(),
  OPENAI_API_KEY: z.unknown().optional(),
  AI_SARVAM_MODEL: z.unknown().optional(),
  AI_OPENAI_MODEL: z.unknown().optional(),
});

type RawEnv = z.output<typeof RawEnvSchema>;

/**
 * The kill switch. `false` (the string, in any case and with spaces, or the
 * JSON boolean that `wrangler.jsonc` can deliver) disables; any other value or
 * a missing value means enabled.
 */
function readEnabled(value: unknown): boolean {
  if (value === false) {
    return false;
  }
  return !(typeof value === 'string' && value.trim().toLowerCase() === 'false');
}

function freezeProvider(name: ProviderName, key: string, model: string): AiProviderConfig {
  return Object.freeze({
    name,
    key,
    model,
    toJSON: () => ({ name, model }),
  });
}

function freezeConfig(config: Omit<AiConfig, 'toJSON'>): AiConfig {
  const redacted: RedactedAiConfig = Object.freeze({
    enabled: config.enabled,
    origins: config.origins,
    allowedModels: config.allowedModels,
    providers: Object.freeze(
      config.providers.map((p) => Object.freeze({ name: p.name, model: p.model })),
    ),
    visitorDailyCap: config.visitorDailyCap,
    dailyCap: config.dailyCap,
    dailyTokenCap: config.dailyTokenCap,
    lifetimeCap: config.lifetimeCap,
    lifetimeTokenCap: config.lifetimeTokenCap,
    maxOutputTokens: config.maxOutputTokens,
    reasoningEffort: config.reasoningEffort,
  });
  return Object.freeze({ ...config, toJSON: () => redacted });
}

const ConfigSchema = RawEnvSchema.transform((raw: RawEnv, ctx): AiConfig => {
  const providers: AiProviderConfig[] = [];
  for (const name of raw.AI_PROVIDERS) {
    const binding = PROVIDER_BINDINGS[name];
    const key = keySchema.safeParse(raw[binding.keyVar]);
    const model = modelNameSchema.safeParse(
      typeof raw[binding.modelVar] === 'string'
        ? (raw[binding.modelVar] as string).trim()
        : undefined,
    );
    if (!key.success || !model.success) {
      // No message and no field name: the caller never sees why.
      ctx.issues.push({ code: 'custom', message: 'invalid', input: null });
      return z.NEVER;
    }
    providers.push(freezeProvider(name, key.data, model.data));
  }

  return freezeConfig({
    enabled: readEnabled(raw.AI_ENABLED),
    origins: Object.freeze(unique(raw.AI_ALLOWED_ORIGINS)),
    allowedModels: Object.freeze(unique(raw.AI_ALLOWED_MODELS)),
    providers: Object.freeze(providers),
    visitorDailyCap: raw.AI_VISITOR_DAILY_CAP,
    dailyCap: raw.AI_DAILY_CAP,
    dailyTokenCap: raw.AI_DAILY_TOKEN_CAP,
    lifetimeCap: raw.AI_LIFETIME_CAP,
    lifetimeTokenCap: raw.AI_LIFETIME_TOKEN_CAP,
    maxOutputTokens: raw.AI_MAX_OUTPUT_TOKENS,
    reasoningEffort: raw.AI_REASONING_EFFORT,
    salt: raw.QUOTA_SALT,
  });
});

/**
 * Reads the configuration from the Worker environment. Never throws on bad
 * input and never returns a reason for a failure.
 */
export function parseConfig(env: Readonly<Record<string, unknown>>): ParseConfigResult {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    return { ok: false };
  }
  return { ok: true, config: parsed.data };
}
