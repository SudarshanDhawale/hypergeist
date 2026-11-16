/**
 * Public API of the AI orchestrator. Everything the UI may use is exported
 * here; the rest of `ai/` (wire helpers, prompts, JSON mode, tool parsing, the
 * scripted test provider under `testing/`) is internal.
 */

// Turns
export { DEFAULT_TURN_LIMITS, runTurn } from './turn.ts';
export type { StepRecord, TurnInput, TurnResult, TurnStopReason } from './turn.ts';

// Fallback chain
export { chooseProviderChain, demoNote, runTurnWithFallback } from './fallback.ts';
export type { ChooseChainResult, FallbackInfo, FallbackTurnResult } from './fallback.ts';

// Text completion for ai-field objects
export { completeText } from './complete-text.ts';
export type { CompleteTextResult } from './complete-text.ts';

// New stacks
export { pickNewStackId, startNewStack } from './new-stack.ts';

// Context and tools
export { buildContext } from './context.ts';
export { buildToolRegistry } from './tools.ts';

// Capabilities
export { createCapabilityCache, detectCapabilities } from './capabilities.ts';
export type { CapabilityReport } from './capabilities.ts';

// Providers
export { createDirectProvider } from './direct-provider.ts';
export { createProxyProvider } from './proxy-provider.ts';
export { createRecordedProvider } from './recorded-provider.ts';
export { loadScenarios, normalizePrompt } from './scenario-set.ts';
export type { Scenario } from './scenario-set.ts';

// Settings and the in-memory key holder
export {
  DEFAULT_AI_SETTINGS,
  createKeyHolder,
  createSettingsRepository,
  validateBaseUrl,
} from './settings.ts';
export type { AiSettings } from './settings.ts';

// Plain-language step descriptions
export { describeCall } from './describe.ts';

// Shared types and error codes
export { PROVIDER_ERROR_CODES } from './errors.ts';
export type { ChatMessage, Provider, ProviderError, ProviderKind } from './types.ts';
