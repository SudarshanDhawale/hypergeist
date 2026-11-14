import { fileURLToPath } from 'node:url';
import { checkFiles } from './rules.ts';
import type { Violation } from './rules.ts';
import { collectFiles } from './scan.ts';

/** Exit codes: 0 no violations, 1 violations found, 2 the scan itself failed. */
const EXIT_OK = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_SCAN_FAILED = 2;

function formatViolation(violation: Violation): string {
  return `${violation.file}:${violation.line}  [${violation.rule}]  ${violation.message}  (${violation.specifier})`;
}

async function main(): Promise<number> {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

  let violations: readonly Violation[];
  try {
    const files = await collectFiles(repoRoot);
    violations = checkFiles(files);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check-deps: scan failed: ${reason}\n`);
    return EXIT_SCAN_FAILED;
  }

  if (violations.length === 0) return EXIT_OK;

  process.stdout.write(`${violations.map(formatViolation).join('\n')}\n`);
  return EXIT_VIOLATIONS;
}

process.exitCode = await main();
