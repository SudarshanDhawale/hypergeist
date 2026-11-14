import * as fc from 'fast-check';

export const SEED_VARIABLE = 'HYPERGEIST_TEST_SEED';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const DEFAULT_NUM_RUNS = 100;
const INTEGER_PATTERN = /^-?\d+$/;

export type ParseSeedResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: string };

/** Accepts a decimal integer string in [-2147483648, 2147483647]. */
export function parseSeed(raw: string): ParseSeedResult {
  if (!INTEGER_PATTERN.test(raw)) {
    return {
      ok: false,
      error: `"${raw}" is not a decimal integer`,
    };
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < INT32_MIN || parsed > INT32_MAX) {
    return {
      ok: false,
      error: `"${raw}" is outside the signed 32-bit range [${INT32_MIN}, ${INT32_MAX}]`,
    };
  }
  // Adding 0 turns -0 (from "-0") into 0.
  return { ok: true, value: parsed + 0 };
}

/**
 * Pure resolution. `env` and `generate` are injected so the function is testable.
 * - variable unset or empty string -> generate()
 * - variable valid                 -> parsed value
 * - variable invalid               -> throws Error naming SEED_VARIABLE and the raw value
 */
export function resolveSeed(
  env: Readonly<Record<string, string | undefined>>,
  generate: () => number,
): number {
  const raw = env[SEED_VARIABLE];
  if (raw === undefined || raw === '') {
    return generate();
  }
  const result = parseSeed(raw);
  if (!result.ok) {
    throw new Error(`Invalid ${SEED_VARIABLE} value "${raw}": ${result.error}`);
  }
  return result.value;
}

/** Random int32 from crypto.getRandomValues. */
export function generateSeed(): number {
  const buffer = new Int32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  // The buffer has exactly one element, so index 0 is always defined.
  return buffer[0] ?? 0;
}

let memoizedSeed: number | undefined;

/** Resolved once per module instance (one per Vitest worker file), then memoized. */
export function getTestSeed(): number {
  if (memoizedSeed === undefined) {
    memoizedSeed = resolveSeed(process.env, generateSeed);
  }
  return memoizedSeed;
}

export function replayCommand(seed: number): string {
  return `${SEED_VARIABLE}=${seed} pnpm --filter @hypergeist/shared test`;
}

/** fast-check parameters with seed and numRuns (default 100) always set. */
export function propertyParams<T>(overrides?: Partial<fc.Parameters<T>>): fc.Parameters<T> {
  // The seed comes last so overrides cannot replace it.
  return { numRuns: DEFAULT_NUM_RUNS, ...overrides, seed: getTestSeed() };
}

/**
 * Wraps fc.assert. On failure: console.error prints the seed and replayCommand(seed),
 * then rethrows the original error.
 */
export function assertProperty<T>(
  property: fc.IProperty<T>,
  overrides?: Partial<fc.Parameters<T>>,
): void {
  const params = propertyParams<T>(overrides);
  try {
    fc.assert(property, params);
  } catch (error: unknown) {
    const seed = getTestSeed();
    console.error(`Property failed with ${SEED_VARIABLE}=${seed}`);
    console.error(`Replay with: ${replayCommand(seed)}`);
    throw error;
  }
}
