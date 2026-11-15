import { describe, expect, it } from 'vitest';
import type {
  EffectRequest,
  ExecutionResult,
  FetchNewsEffect,
  RunAiFieldEffect,
  ScheduleNotificationEffect,
  TranscribeAudioEffect,
} from './types.ts';

const runAiField = {
  kind: 'run_ai_field',
  actionIndex: 0,
  targetObjectId: 'summary',
  prompt: 'Summarize the notes.',
  inputs: [{ objectId: 'notes', name: 'Notes', text: 'one\ntwo' }],
} satisfies RunAiFieldEffect;

const fetchNews = {
  kind: 'fetch_news',
  actionIndex: 1,
  targetObjectId: 'headlines',
  topics: ['science', 'weather'],
} satisfies FetchNewsEffect;

const transcribeAudio = {
  kind: 'transcribe_audio',
  actionIndex: 2,
  targetObjectId: 'transcript',
} satisfies TranscribeAudioEffect;

const scheduleNotification = {
  kind: 'schedule_notification',
  actionIndex: 3,
  message: 'Stand up',
  at: '2026-12-01T09:00:00Z',
  atFromObjectId: 'when',
} satisfies ScheduleNotificationEffect;

const scheduleNotificationLiteral = {
  kind: 'schedule_notification',
  actionIndex: 4,
  message: 'Stretch',
  at: '2026-12-01T10:00:00Z',
} satisfies ScheduleNotificationEffect;

const samples: readonly EffectRequest[] = [
  runAiField,
  fetchNews,
  transcribeAudio,
  scheduleNotification,
  scheduleNotificationLiteral,
];

describe('EffectRequest', () => {
  it('covers the four kinds', () => {
    expect(new Set(samples.map((e) => e.kind))).toEqual(
      new Set(['run_ai_field', 'fetch_news', 'transcribe_audio', 'schedule_notification']),
    );
  });

  it('is plain data: every sample survives a JSON round trip unchanged', () => {
    for (const sample of samples) {
      expect(JSON.parse(JSON.stringify(sample))).toEqual(sample);
    }
  });

  it('lets ExecutionResult carry both an empty and a filled effects list', () => {
    const base = { messages: [] } as const;
    const stack = {
      schemaVersion: 1,
      name: 's',
      cards: [],
      links: [],
    } as unknown as ExecutionResult['stack'];
    const empty: ExecutionResult = { ...base, stack, effects: [] };
    const filled: ExecutionResult = { ...base, stack, effects: samples };
    expect(empty.effects).toHaveLength(0);
    expect(filled.effects).toHaveLength(samples.length);
  });
});
