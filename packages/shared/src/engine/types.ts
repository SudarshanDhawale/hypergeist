import type { Stack } from '../format/index.ts';

/**
 * A request for work that needs the outside world (AI call, news, transcription,
 * notification). The slice has none, so the type is `never`. The full engine widens
 * this union and no slice code creates a value of it.
 */
export type EffectRequest = never;

/** What `executeHandler` returns. `effects` is always `[]` in the slice. */
export type ExecutionResult = {
  readonly stack: Stack;
  readonly effects: readonly EffectRequest[];
  /** Present only when a `go_to_card` Action ran. */
  readonly navigateTo?: string;
  readonly messages: readonly string[];
};
