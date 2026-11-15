import type { Stack } from '../format/index.ts';

/** The current text of one input Object of an ai-field, in `inputObjectIds` order. */
export type EffectInput = {
  readonly objectId: string;
  readonly name: string;
  readonly text: string;
};

export type RunAiFieldEffect = {
  readonly kind: 'run_ai_field';
  /** Zero-based position of the Action in the Handler. Lets a runtime match results and messages. */
  readonly actionIndex: number;
  readonly targetObjectId: string;
  readonly prompt: string;
  readonly inputs: readonly EffectInput[];
};

export type FetchNewsEffect = {
  readonly kind: 'fetch_news';
  readonly actionIndex: number;
  readonly targetObjectId: string;
  readonly topics: readonly string[];
};

export type TranscribeAudioEffect = {
  readonly kind: 'transcribe_audio';
  readonly actionIndex: number;
  readonly targetObjectId: string;
};

export type ScheduleNotificationEffect = {
  readonly kind: 'schedule_notification';
  readonly actionIndex: number;
  readonly message: string;
  /** The Action's `at`, or the current text of the `atFromObjectId` Field. The runtime parses it. */
  readonly at: string;
  /** Present only when `at` came from a Field. */
  readonly atFromObjectId?: string;
};

/**
 * A request for work that needs the outside world (AI call, news, transcription,
 * notification). Plain data with no functions, so it can cross a Worker boundary. The
 * discriminant is `kind`, so an effect is never confused with an Action (`type`).
 */
export type EffectRequest =
  RunAiFieldEffect | FetchNewsEffect | TranscribeAudioEffect | ScheduleNotificationEffect;

/** What `executeHandler` returns. `effects` lists the outside-world work the Handler asked for. */
export type ExecutionResult = {
  readonly stack: Stack;
  readonly effects: readonly EffectRequest[];
  /** Present only when a `go_to_card` Action ran. */
  readonly navigateTo?: string;
  readonly messages: readonly string[];
};
