import { describe, expect, expectTypeOf, it } from 'vitest';
import { createSaveStateStore } from './save-state-store.ts';
import type { SaveState, SaveStatus } from './save-state-store.ts';

describe('createSaveStateStore', () => {
  it('starts saved with no reason and no export offer', () => {
    const state = createSaveStateStore().getState();
    expect(state.status).toBe('saved');
    expect(state.reason).toBeNull();
    expect(state.canExport).toBe(false);
  });

  it('markSaving sets the status to saving', () => {
    const store = createSaveStateStore();
    store.getState().markSaving();
    expect(store.getState().status).toBe('saving');
    expect(store.getState().reason).toBeNull();
    expect(store.getState().canExport).toBe(false);
  });

  it('markSaved sets the status to saved', () => {
    const store = createSaveStateStore();
    store.getState().markSaving();
    store.getState().markSaved();
    expect(store.getState().status).toBe('saved');
  });

  it('markNotSaved stores the reason and the export flag', () => {
    const store = createSaveStateStore();
    store.getState().markNotSaved("The browser's storage is full", true);
    expect(store.getState().status).toBe('not-saved');
    expect(store.getState().reason).toBe("The browser's storage is full");
    expect(store.getState().canExport).toBe(true);
  });

  it('markNotSaved with canExport false keeps the flag false', () => {
    const store = createSaveStateStore();
    store.getState().markNotSaved('Writing failed', false);
    expect(store.getState().status).toBe('not-saved');
    expect(store.getState().reason).toBe('Writing failed');
    expect(store.getState().canExport).toBe(false);
  });

  it('markSaved clears the reason and the export flag of an earlier failure', () => {
    const store = createSaveStateStore();
    store.getState().markNotSaved("The browser's storage is full", true);
    store.getState().markSaved();
    expect(store.getState().status).toBe('saved');
    expect(store.getState().reason).toBeNull();
    expect(store.getState().canExport).toBe(false);
  });

  it('markSaving after a failure keeps the reason until the write finishes', () => {
    const store = createSaveStateStore();
    store.getState().markNotSaved('Writing failed', true);
    store.getState().markSaving();
    expect(store.getState().status).toBe('saving');
    store.getState().markSaved();
    expect(store.getState().reason).toBeNull();
    expect(store.getState().canExport).toBe(false);
  });

  it('notifies subscribers on each transition', () => {
    const store = createSaveStateStore();
    const seen: SaveStatus[] = [];
    store.subscribe((state) => seen.push(state.status));
    store.getState().markSaving();
    store.getState().markNotSaved('Writing failed', false);
    store.getState().markSaved();
    expect(seen).toEqual(['saving', 'not-saved', 'saved']);
  });

  it('keeps separate state per store', () => {
    const first = createSaveStateStore();
    const second = createSaveStateStore();
    first.getState().markSaving();
    expect(second.getState().status).toBe('saved');
  });

  it('types the state fields as readonly', () => {
    expectTypeOf<SaveState>().toEqualTypeOf<{
      readonly status: SaveStatus;
      readonly reason: string | null;
      readonly canExport: boolean;
    }>();
    // Compile-time only: the function is never called, so nothing is mutated at run time.
    const assignAll = (state: SaveState): void => {
      // @ts-expect-error status is readonly
      state.status = 'saving';
      // @ts-expect-error reason is readonly
      state.reason = 'x';
      // @ts-expect-error canExport is readonly
      state.canExport = true;
    };
    expect(typeof assignAll).toBe('function');
  });
});
