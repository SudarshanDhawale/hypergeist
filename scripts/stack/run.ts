import { validateStack } from '@hypergeist/shared/format';

export type RunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0 | 1 | 2;
};

/** Reads a file as UTF-8 text. Throws when the file cannot be read. */
export type ReadText = (path: string) => string;

const USAGE = 'usage: pnpm stack validate <file>';

function usageFailure(): RunResult {
  return { stdout: '', stderr: `${USAGE}\n`, exitCode: 2 };
}

/** Node errors carry a string `code` such as ENOENT or EISDIR. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'UNKNOWN';
}

/**
 * Pure core of `pnpm stack validate <file>`. `argv` holds the arguments after
 * the script name. The file text goes to the validator unparsed.
 *
 * Exit codes: 0 valid, 1 invalid (including INVALID_JSON), 2 usage or read error.
 */
export function run(argv: readonly string[], readText: ReadText): RunResult {
  const [subcommand, file, ...extra] = argv;
  if (subcommand !== 'validate' || file === undefined || file === '' || extra.length > 0) {
    return usageFailure();
  }

  let text: string;
  try {
    text = readText(file);
  } catch (error: unknown) {
    // JSON.stringify quotes the path and escapes newlines, so stderr stays one line.
    return {
      stdout: '',
      stderr: `stack: cannot read ${JSON.stringify(file)}: ${errorCode(error)}\n`,
      exitCode: 2,
    };
  }

  const result = validateStack(text);
  return {
    stdout: `${JSON.stringify(result, null, 2)}\n`,
    stderr: '',
    exitCode: result.valid ? 0 : 1,
  };
}
