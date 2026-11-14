import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceFile } from './rules.ts';

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.wrangler',
  'coverage',
]);

const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx'];

/**
 * Walks `dir` and appends repo-relative POSIX paths of source files to `found`.
 * `relative` is the POSIX path of `dir` from the root.
 */
async function walk(root: string, relative: string, found: string[]): Promise<void> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await walk(root, childRelative, found);
      }
    } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      found.push(childRelative);
    }
  }
}

/**
 * Collects every `.ts` and `.tsx` file under `dirs` (relative to `root`), skipping
 * `node_modules`, `dist`, `.wrangler`, and `coverage`. Paths are repo-relative with
 * POSIX separators and the result is sorted by path. Rejects if a directory or file
 * cannot be read.
 */
export async function collectFiles(
  root: string,
  dirs: readonly string[] = ['apps', 'packages'],
): Promise<readonly SourceFile[]> {
  const paths: string[] = [];
  for (const dir of dirs) {
    await walk(root, dir, paths);
  }
  paths.sort();

  const files: SourceFile[] = [];
  for (const path of paths) {
    files.push({ path, text: await readFile(join(root, path), 'utf8') });
  }
  return files;
}
