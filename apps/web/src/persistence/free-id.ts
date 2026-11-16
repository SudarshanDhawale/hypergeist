import { ENTITY_ID_PATTERN } from '@hypergeist/shared/format';

/** Maximum length of an Entity ID, as allowed by `ENTITY_ID_PATTERN` (1 + 63 characters). */
const MAX_ID_LENGTH = 64;

/** Used when `baseId` is not a valid Entity ID, so the result still matches the pattern. */
const FALLBACK_BASE = 'stack';

function copySuffix(attempt: number): string {
  return attempt === 1 ? '-copy' : `-copy-${attempt}`;
}

/**
 * Suggests an unused Entity ID for a copy of `baseId`.
 *
 * Tries `<base>-copy`, then `<base>-copy-2`, `<base>-copy-3`, and so on. The base is cut
 * from the end so the whole id fits in 64 characters. A prefix of a valid id keeps a valid
 * first character and character set, so every candidate matches `ENTITY_ID_PATTERN`.
 * `baseId` is expected to be a valid Entity ID; if it is not, `stack` is used instead.
 * Pure: the same input always gives the same output.
 *
 * Cost is one copy of `taken` into a set plus one lookup per attempt, so thousands of
 * taken ids are cheap. Each attempt has a distinct suffix, so the loop ends after at most
 * `taken.size + 1` attempts.
 */
export function suggestFreeId(
  baseId: string,
  taken: ReadonlySet<string> | readonly string[],
): string {
  const takenSet = new Set<string>(taken);
  const base = ENTITY_ID_PATTERN.test(baseId) ? baseId : FALLBACK_BASE;

  for (let attempt = 1; ; attempt += 1) {
    const suffix = copySuffix(attempt);
    const candidate = base.slice(0, MAX_ID_LENGTH - suffix.length) + suffix;
    if (!takenSet.has(candidate)) {
      return candidate;
    }
  }
}
