import { createValidationError, parseStack } from '@hypergeist/shared/format';
import type { ValidationError } from '@hypergeist/shared/format';
import type { SeedStack } from './types.ts';

/** A bundled stack file that could not be used, with the reasons. */
export type SeedProblem = {
  /** The file key as given, for example `../stacks/thin-slice-todo.json`. */
  readonly file: string;
  readonly errors: readonly ValidationError[];
};

export type SeedSet = {
  /** Valid, unique stacks, in file name order. */
  readonly stacks: readonly SeedStack[];
  /** Files that were skipped, in file name order. */
  readonly problems: readonly SeedProblem[];
};

/**
 * Every `.json` file placed directly in `apps/web/src/stacks/` becomes a demo stack.
 * Adding a file adds a stack with no code change. Files in sub-folders are not matched.
 * The `?raw` query gives the file text, so `parseStack` sees exactly what is on disk.
 */
const bundledFiles: Record<string, string> = import.meta.glob<string>('../stacks/*.json', {
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

/**
 * Parses the bundled demo stacks. Never throws. An invalid file, or a file whose stack id was
 * already used by an earlier file, is reported in `problems` and does not stop the others.
 * `files` maps a file name to its text; tests use it to inject content. The input is not modified.
 */
export function loadSeedSet(files: Readonly<Record<string, string>> = bundledFiles): SeedSet {
  const stacks: SeedStack[] = [];
  const problems: SeedProblem[] = [];
  const seenIds = new Set<string>();

  for (const file of Object.keys(files).sort(byFileName)) {
    const text = files[file];
    const parsed = parseStack(text);
    if (!parsed.ok) {
      problems.push({ file, errors: parsed.errors });
      continue;
    }
    const { id } = parsed.value;
    if (seenIds.has(id)) {
      problems.push({
        file,
        errors: [
          createValidationError({
            code: 'DUPLICATE_ID',
            path: '/id',
            message: `Stack id "${id}" is already used by an earlier demo stack file.`,
            expected: 'a stack id that no other demo stack file uses',
            hint: 'Give this demo stack a different id.',
            actual: id,
          }),
        ],
      });
      continue;
    }
    seenIds.add(id);
    stacks.push({ stack: parsed.value });
  }

  return { stacks, problems };
}
