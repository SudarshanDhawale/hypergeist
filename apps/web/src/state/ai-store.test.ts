import { describe, expect, it } from 'vitest';
import { createAiStore } from './ai-store.ts';

describe('ai-store', () => {
  it('starts empty, idle, in demo mode, with no quota', () => {
    const state = createAiStore().getState();
    expect(state.lines).toEqual([]);
    expect(state.busy).toBe(false);
    expect(state.busyNewStack).toBe(false);
    expect('undo' in state).toBe(false);
    expect(state.settings).toEqual({ provider: 'demo', baseUrl: '', model: '' });
    expect(state.hasKey).toBe(false);
    expect(state.capability).toBeNull();
    expect(state.jsonMode).toBe(false);
    expect(state.quota).toBeNull();
  });

  it('adds lines with growing ids, in order, and ignores an empty batch', () => {
    const store = createAiStore();
    store.getState().addLines([]);
    expect(store.getState().lines).toEqual([]);
    store.getState().addLines([
      { kind: 'user', text: 'a' },
      { kind: 'ghost', text: 'b' },
    ]);
    store.getState().addLines([{ kind: 'note', text: 'c' }]);
    expect(store.getState().lines).toEqual([
      { id: 1, kind: 'user', text: 'a' },
      { id: 2, kind: 'ghost', text: 'b' },
      { id: 3, kind: 'note', text: 'c' },
    ]);
  });

  it('counts a thinking start for each busy flag and not the end', () => {
    const store = createAiStore();
    store.getState().setBusy(true);
    expect(store.getState().thinkingSeq).toBe(1);
    store.getState().setBusy(false);
    expect(store.getState().thinkingSeq).toBe(1);
    store.getState().setBusyNewStack(true);
    expect(store.getState().thinkingSeq).toBe(2);
    expect(store.getState().busyNewStack).toBe(true);
  });

  it('sets settings, key flag, capability, json mode and quota', () => {
    const store = createAiStore();
    store.getState().setSettings({ provider: 'own', baseUrl: 'https://a.example', model: 'm' });
    store.getState().setHasKey(true);
    store.getState().setJsonMode(true);
    store.getState().setQuota({ remaining: 3 });
    const state = store.getState();
    expect(state.settings.provider).toBe('own');
    expect(state.hasKey).toBe(true);
    expect(state.jsonMode).toBe(true);
    expect(state.quota).toEqual({ remaining: 3 });
    store.getState().setQuota(null);
    expect(store.getState().quota).toBeNull();
  });
});
