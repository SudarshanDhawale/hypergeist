/**
 * Worker environment: the bindings and the configuration values that
 * Cloudflare hands to the Worker (`vars` from `wrangler.jsonc` and the
 * dashboard, secrets from `wrangler secret put`).
 *
 * Every var and secret is an optional string here because that is what the
 * platform delivers and because any of them can be missing or wrong. The
 * values are never trusted as typed: `parseConfig` in `lib/config.ts` reads
 * them from an `unknown` record and validates each one.
 */

/** The model providers the Worker knows. The table with URLs lives elsewhere. */
export const PROVIDER_NAMES = ['sarvam', 'openai'] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Names of the secret and the model var that belong to one provider. */
export type ProviderBinding = {
  /** Secret holding the provider's API key (`wrangler secret put`). */
  readonly keyVar: 'SARVAM_API_KEY' | 'OPENAI_API_KEY';
  /** Var holding the model id to use with that provider. */
  readonly modelVar: 'AI_SARVAM_MODEL' | 'AI_OPENAI_MODEL';
};

export const PROVIDER_BINDINGS = {
  sarvam: { keyVar: 'SARVAM_API_KEY', modelVar: 'AI_SARVAM_MODEL' },
  openai: { keyVar: 'OPENAI_API_KEY', modelVar: 'AI_OPENAI_MODEL' },
} as const satisfies Readonly<Record<ProviderName, ProviderBinding>>;

/**
 * A type alias (not an interface) on purpose: an alias is assignable to
 * `Readonly<Record<string, unknown>>`, so `parseConfig(env)` accepts it.
 */
export type Env = {
  // Bindings
  ASSETS: Fetcher;
  QUOTA: DurableObjectNamespace;
  AI_BURST: RateLimit;

  // Vars
  AI_ENABLED?: string;
  AI_ALLOWED_ORIGINS?: string;
  AI_ALLOWED_MODELS?: string;
  AI_PROVIDERS?: string;
  AI_SARVAM_MODEL?: string;
  AI_OPENAI_MODEL?: string;
  AI_VISITOR_DAILY_CAP?: string;
  AI_DAILY_CAP?: string;
  AI_DAILY_TOKEN_CAP?: string;
  AI_LIFETIME_CAP?: string;
  AI_LIFETIME_TOKEN_CAP?: string;
  AI_MAX_OUTPUT_TOKENS?: string;
  AI_REASONING_EFFORT?: string;

  // Secrets
  SARVAM_API_KEY?: string;
  OPENAI_API_KEY?: string;
  QUOTA_SALT?: string;
};
