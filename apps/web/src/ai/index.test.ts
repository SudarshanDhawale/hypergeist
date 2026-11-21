import { describe, expect, it } from 'vitest';
import * as api from './index.ts';
import indexSource from './index.ts?raw';
import type {
  AiSettings,
  CapabilityReport,
  ChatMessage,
  ChooseChainResult,
  CompleteTextResult,
  FallbackInfo,
  FallbackTurnResult,
  Provider,
  ProviderError,
  ProviderKind,
  Scenario,
  StepRecord,
  TurnInput,
  TurnResult,
  TurnStopReason,
} from './index.ts';

/** Compile-time check: each exported type must resolve (not be `any`/missing). */
type ExportedTypes = [
  AiSettings,
  CapabilityReport,
  ChatMessage,
  ChooseChainResult,
  CompleteTextResult,
  FallbackInfo,
  FallbackTurnResult,
  Provider,
  ProviderError,
  ProviderKind,
  Scenario,
  StepRecord,
  TurnInput,
  TurnResult,
  TurnStopReason,
];

const EXPECTED_RUNTIME_EXPORTS = [
  'DEFAULT_AI_SETTINGS',
  'DEFAULT_TURN_LIMITS',
  'PROVIDER_ERROR_CODES',
  'buildContext',
  'buildToolRegistry',
  'chooseProviderChain',
  'completeText',
  'completeTextWithFallback',
  'createCapabilityCache',
  'createDirectProvider',
  'createKeyHolder',
  'createProxyProvider',
  'createRecordedProvider',
  'createSettingsRepository',
  'demoNote',
  'describeCall',
  'detectCapabilities',
  'loadScenarios',
  'normalizePrompt',
  'pickNewStackId',
  'runTurn',
  'runTurnWithFallback',
  'startNewStack',
  'validateBaseUrl',
].sort();

describe('ai public API', () => {
  it('exports exactly the pinned set of runtime names', () => {
    expect(Object.keys(api).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS);
  });

  it('exports functions and data of the expected kind', () => {
    expect(typeof api.runTurn).toBe('function');
    expect(typeof api.createRecordedProvider).toBe('function');
    expect(Array.isArray(api.PROVIDER_ERROR_CODES)).toBe(true);
    expect(api.DEFAULT_TURN_LIMITS.maxRequests).toBeGreaterThan(0);
    expect(api.DEFAULT_AI_SETTINGS).toBeTypeOf('object');
  });

  it('keeps internals out of the public API', () => {
    const names = Object.keys(api);
    for (const internal of [
      'createScriptedProvider',
      'parseToolCall',
      'buildSystemPrompt',
      'extractJson',
      'buildRepairMessage',
    ]) {
      expect(names).not.toContain(internal);
    }
  });

  it('does not re-export anything from testing/', () => {
    // Only module specifiers count; the header comment may mention `testing/`.
    const specifiers = [...indexSource.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/testing\//);
      expect(specifier).not.toMatch(/scripted-provider/);
    }
  });

  it('has type exports that compile', () => {
    const marker: ExportedTypes | null = null;
    expect(marker).toBeNull();
  });
});
