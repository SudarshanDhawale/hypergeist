import { z } from 'zod';
import type { Stack } from '@hypergeist/shared/format';
import {
  chooseProviderChain,
  demoNote,
  detectCapabilities,
  runTurnWithFallback,
  startNewStack,
  validateBaseUrl,
} from '../ai/index.ts';
import type {
  AiSettings,
  CapabilityReport,
  FallbackTurnResult,
  Scenario,
  TurnInput,
  createKeyHolder,
  createSettingsRepository,
} from '../ai/index.ts';
import type { AiStoreApi, NewChatLine } from './ai-store.ts';
import { lastEntrySource } from './stack-store.ts';
import type { StackStoreApi } from './stack-store.ts';

/** The most chat lines (user and Ghost) sent as history. */
const HISTORY_LINES = 6;

type KeyHolder = ReturnType<typeof createKeyHolder>;
type SettingsRepository = ReturnType<typeof createSettingsRepository>;

export type { KeyHolder, SettingsRepository };

const QUOTA_ENDPOINT = '/api/ai/quota';

const QuotaSchema = z.object({
  dailyLimit: z.number(),
  dailyUsed: z.number(),
  visitorLimit: z.number(),
  visitorUsed: z.number(),
});

const UNEXPECTED_MESSAGE = 'Something went wrong. Nothing was changed.';
const STOPPED_LINE = 'Stopped. Changes already made are kept.';
const SWITCHED_LINE =
  'You opened another stack while the Ghost worked, so its change was not applied.';
const NOTHING_TO_UNDO_LINE = 'There is no Ghost change to undo.';
const UNDID_LINE = "Undid the Ghost's last change.";

export type AiControllerDeps = {
  readonly stackStore: StackStoreApi;
  readonly aiStore: AiStoreApi;
  readonly settingsRepo: SettingsRepository;
  readonly keyHolder: KeyHolder;
  readonly fetch: typeof fetch;
  readonly scenarios: readonly Scenario[];
  readonly now: () => number;
  /** Timer functions for the capability check, for tests. */
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  /** Replaces `chooseProviderChain`, for tests. */
  readonly chooseChain?: typeof chooseProviderChain;
};

export type MakeStackOutcome = {
  /** `null` when no provider could be used. */
  readonly result: FallbackTurnResult | null;
  /** The new stack when the status is `done` or `partial`, else `null`. */
  readonly stack: Stack | null;
  /** One plain sentence for the Stacks window. */
  readonly message: string;
};

export type SaveSettingsOutcome =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export type CheckProviderOutcome =
  | { readonly ok: true; readonly report: CapabilityReport }
  | { readonly ok: false; readonly message: string };

export type AiController = {
  send(text: string): Promise<void>;
  makeStack(
    text: string,
    options: { readonly takenIds: readonly string[] },
  ): Promise<MakeStackOutcome>;
  undo(): void;
  stop(): void;
  saveSettings(next: AiSettings, key?: string): Promise<SaveSettingsOutcome>;
  checkProvider(): Promise<CheckProviderOutcome>;
  refreshQuota(): Promise<void>;
  init(): Promise<void>;
};

function statusLine(result: FallbackTurnResult): NewChatLine {
  switch (result.status) {
    case 'done':
      return { kind: 'note', text: 'Done.' };
    case 'partial':
      return { kind: 'note', text: 'Partly done. Some steps were not applied.' };
    case 'aborted':
      return { kind: 'note', text: STOPPED_LINE };
    case 'failed':
      return {
        kind: 'error',
        text:
          result.error === undefined
            ? 'I could not do that. Nothing was changed.'
            : `I could not do that. ${result.error.message}`,
      };
  }
}

/** Ghost lines for a finished Turn: what it said, each step, the status, the demo note. */
function resultLines(result: FallbackTurnResult): NewChatLine[] {
  const lines: NewChatLine[] = [];
  for (const text of result.say) {
    if (text.trim() !== '') lines.push({ kind: 'ghost', text });
  }
  for (const step of result.steps) lines.push({ kind: 'step', text: step.description });
  lines.push(statusLine(result));
  const note = demoNote(result);
  if (note !== null) lines.push({ kind: 'note', text: note });
  return lines;
}

/**
 * The controller between the stores and the AI orchestrator. It has no React in it. Its actions
 * report problems as chat lines or values and never throw. The key stays in the key holder: it
 * is not copied into a store and is never passed to the settings repository.
 */
export function createAiController(deps: AiControllerDeps): AiController {
  const { stackStore, aiStore, settingsRepo, keyHolder } = deps;
  const choose = deps.chooseChain ?? chooseProviderChain;
  let chatAbort: AbortController | null = null;
  let newStackAbort: AbortController | null = null;

  function chain() {
    return choose({
      settings: aiStore.getState().settings,
      getKey: () => keyHolder.get(),
      fetch: deps.fetch,
      scenarios: deps.scenarios,
    });
  }

  async function send(text: string): Promise<void> {
    const message = text.trim();
    const state = aiStore.getState();
    if (state.busy || message === '') return;
    const history = state.lines
      .filter((line) => line.kind === 'user' || line.kind === 'ghost')
      .slice(-HISTORY_LINES)
      .map((line) => ({
        role: line.kind === 'user' ? ('user' as const) : ('assistant' as const),
        text: line.text,
      }));
    state.addLines([{ kind: 'user', text: message }]);
    state.setBusy(true);
    const abort = new AbortController();
    chatAbort = abort;
    try {
      const chosen = chain();
      if (!chosen.ok) {
        aiStore.getState().addLines([{ kind: 'error', text: chosen.message }]);
        return;
      }
      const open = stackStore.getState();
      const input: Omit<TurnInput, 'provider'> = {
        stack: open.stack,
        currentCardId: open.currentCardId,
        selectedObjectId: open.mode === 'ai-edit' ? open.selectedObjectId : null,
        userMessage: message,
        history,
        newStack: false,
        jsonMode: aiStore.getState().jsonMode,
        signal: abort.signal,
        clock: deps.now,
      };
      const result = await runTurnWithFallback(chosen.chain, input);
      const lines = resultLines(result);
      const after = result.after;
      if (after !== input.stack) {
        if (stackStore.getState().stack.id === input.stack.id) {
          stackStore.getState().applyStack(after, 'ai');
        } else {
          lines.push({ kind: 'error', text: SWITCHED_LINE });
        }
      }
      aiStore.getState().setJsonMode(result.usedJsonMode);
      aiStore.getState().addLines(lines);
    } catch {
      aiStore.getState().addLines([{ kind: 'error', text: UNEXPECTED_MESSAGE }]);
    } finally {
      if (chatAbort === abort) chatAbort = null;
      aiStore.getState().setBusy(false);
    }
    await refreshQuota();
  }

  async function makeStack(
    text: string,
    options: { readonly takenIds: readonly string[] },
  ): Promise<MakeStackOutcome> {
    const message = text.trim();
    const state = aiStore.getState();
    if (state.busyNewStack || message === '') {
      return { result: null, stack: null, message: 'Describe the stack you want first.' };
    }
    state.setBusyNewStack(true);
    const abort = new AbortController();
    newStackAbort = abort;
    let outcome: MakeStackOutcome;
    try {
      const chosen = chain();
      if (!chosen.ok) {
        outcome = { result: null, stack: null, message: chosen.message };
      } else {
        const start = startNewStack({ takenIds: options.takenIds });
        const result = await runTurnWithFallback(chosen.chain, {
          stack: start.stack,
          currentCardId: start.currentCardId,
          selectedObjectId: null,
          userMessage: message,
          history: [],
          newStack: true,
          jsonMode: aiStore.getState().jsonMode,
          signal: abort.signal,
          clock: deps.now,
        });
        const made = result.status === 'done' || result.status === 'partial';
        const summary = statusLine(result).text;
        const said = result.say.find((line) => line.trim() !== '');
        const note = demoNote(result);
        const parts = [made ? summary : (said ?? summary)];
        if (!made && said !== undefined && summary !== said) parts.push(summary);
        if (note !== null) parts.push(note);
        outcome = { result, stack: made ? result.after : null, message: parts.join(' ') };
      }
    } catch {
      outcome = { result: null, stack: null, message: UNEXPECTED_MESSAGE };
    } finally {
      if (newStackAbort === abort) newStackAbort = null;
      aiStore.getState().setBusyNewStack(false);
    }
    await refreshQuota();
    return outcome;
  }

  function undo(): void {
    try {
      const state = aiStore.getState();
      if (state.busy) return;
      if (lastEntrySource(stackStore.getState()) !== 'ai') {
        state.addLines([{ kind: 'note', text: NOTHING_TO_UNDO_LINE }]);
        return;
      }
      stackStore.getState().undoEdit();
      state.addLines([{ kind: 'note', text: UNDID_LINE }]);
    } catch {
      aiStore.getState().addLines([{ kind: 'error', text: UNEXPECTED_MESSAGE }]);
    }
  }

  function stop(): void {
    chatAbort?.abort();
    newStackAbort?.abort();
  }

  async function saveSettings(next: AiSettings, key?: string): Promise<SaveSettingsOutcome> {
    try {
      // Only these three fields go to the repository. The key never does.
      const saved = await settingsRepo.save({
        provider: next.provider,
        baseUrl: next.baseUrl,
        model: next.model,
      });
      if (!saved.ok) return { ok: false, message: saved.message };
      if (key !== undefined) keyHolder.set(key);
      const store = aiStore.getState();
      store.setSettings(saved.settings);
      store.setHasKey(keyHolder.get() !== undefined);
      store.setCapability(null);
      store.setJsonMode(false);
      await refreshQuota();
      return { ok: true };
    } catch {
      return { ok: false, message: 'The AI settings could not be saved.' };
    }
  }

  async function checkProvider(): Promise<CheckProviderOutcome> {
    try {
      const { settings } = aiStore.getState();
      if (settings.provider !== 'own') {
        return { ok: false, message: 'Choose "My own model" to check a provider.' };
      }
      const checked = validateBaseUrl(settings.baseUrl);
      if (!checked.ok) return { ok: false, message: checked.message };
      if (settings.model.trim() === '') {
        return { ok: false, message: 'Enter a model name first.' };
      }
      const report = await detectCapabilities({
        baseUrl: checked.url,
        model: settings.model.trim(),
        getKey: () => keyHolder.get(),
        fetch: deps.fetch,
        ...(deps.setTimeout === undefined ? {} : { setTimeout: deps.setTimeout }),
      });
      const store = aiStore.getState();
      store.setCapability(report);
      store.setJsonMode(report.toolCalling === 'no');
      return { ok: true, report };
    } catch {
      return { ok: false, message: 'The provider could not be checked.' };
    }
  }

  async function refreshQuota(): Promise<void> {
    try {
      if (aiStore.getState().settings.provider !== 'demo') {
        aiStore.getState().setQuota(null);
        return;
      }
      const response = await deps.fetch(QUOTA_ENDPOINT, { credentials: 'omit' });
      if (!response.ok) {
        // Release the unread body so the request is finished for the browser.
        await response.body?.cancel().catch(() => undefined);
        aiStore.getState().setQuota(null);
        return;
      }
      const parsed = QuotaSchema.safeParse(await response.json());
      if (!parsed.success) {
        aiStore.getState().setQuota(null);
        return;
      }
      const { dailyLimit, dailyUsed, visitorLimit, visitorUsed } = parsed.data;
      const remaining = Math.max(0, Math.min(dailyLimit - dailyUsed, visitorLimit - visitorUsed));
      aiStore.getState().setQuota({ remaining });
    } catch {
      aiStore.getState().setQuota(null);
    }
  }

  async function init(): Promise<void> {
    try {
      const loaded = await settingsRepo.load();
      const store = aiStore.getState();
      store.setSettings(loaded.settings);
      store.setHasKey(keyHolder.get() !== undefined);
    } catch {
      // The defaults stay.
    }
    await refreshQuota();
  }

  return { send, makeStack, undo, stop, saveSettings, checkProvider, refreshQuota, init };
}
