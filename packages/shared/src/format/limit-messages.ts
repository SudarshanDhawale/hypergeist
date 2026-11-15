/** The message, expected, and hint texts of one `LIMIT_EXCEEDED` error. */
export type LimitMessages = {
  readonly message: string;
  readonly expected: string;
  readonly hint: string;
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Builds the texts for a text or array that is longer than its maximum.
 * `max` is the inclusive maximum (characters for text, items for arrays).
 * `length` is the actual size when known. The Zod mapper and the semantic
 * pass both use this helper, so their texts cannot drift apart.
 */
export function limitMessages(
  kind: 'text' | 'array',
  max: number,
  length: number | undefined,
): LimitMessages {
  const isText = kind === 'text';
  const unit = isText ? 'character' : 'item';
  const over = length === undefined ? undefined : length - max;
  return {
    message:
      length === undefined
        ? `The ${isText ? 'text' : 'array'} is longer than the maximum of ${plural(max, unit)}.`
        : `The ${isText ? 'text' : 'array'} has ${plural(length, unit)}, more than the maximum of ${max}.`,
    expected: isText
      ? `text of at most ${plural(max, unit)}`
      : `an array of at most ${plural(max, unit)}`,
    hint:
      over === undefined || over < 1
        ? isText
          ? `Shorten the text to at most ${plural(max, unit)}.`
          : `Remove items so that at most ${plural(max, unit)} remain.`
        : isText
          ? `Remove ${plural(over, unit)} from this text.`
          : `Remove ${plural(over, unit)} from this array.`,
  };
}
