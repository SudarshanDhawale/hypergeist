import { serializeStack } from '@hypergeist/shared/format';
import type { Stack, ValidationError } from '@hypergeist/shared/format';

export type ExportResult =
  | { readonly ok: true; readonly filename: string; readonly text: string }
  | { readonly ok: false; readonly message: string };

const SLUG_MAX_LENGTH = 40;
const EXTENSION = '.hypergeist.json';

/**
 * Builds `<slug>-<id>.hypergeist.json`. The slug is the lower-cased name with every run of
 * characters outside `a-z0-9` replaced by one `-`, trimmed of `-` and cut to 40 characters.
 * An empty slug leaves `<id>.hypergeist.json`. Pure: the same input gives the same output.
 */
export function exportFilename(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
  return `${slug === '' ? id : `${slug}-${id}`}${EXTENSION}`;
}

function describeError(error: ValidationError): string {
  const place = error.path === '' ? 'the stack itself' : `"${error.path}"`;
  const message = error.message.replace(/[.\s]+$/, '');
  const hint = error.hint.replace(/[.\s]+$/, '');
  const sentence = `This stack cannot be exported because of a problem at ${place}: ${message}.`;
  return hint === '' ? sentence : `${sentence} ${hint}.`;
}

/**
 * Turns a stack into the text of an Export_File. The text is the canonical JSON of the stack
 * and nothing else. An invalid stack gives no file, only the first error as one plain message.
 */
export function exportStack(stack: Stack): ExportResult {
  const serialized = serializeStack(stack);
  if (!serialized.ok) {
    const first = serialized.errors[0];
    return {
      ok: false,
      message: first === undefined ? 'This stack cannot be exported.' : describeError(first),
    };
  }
  return { ok: true, filename: exportFilename(stack.name, stack.id), text: serialized.value };
}
