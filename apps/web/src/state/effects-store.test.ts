import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectsProvider, useEffects, useEffectsStore } from './EffectsContext.tsx';
import type { EffectsActions } from './EffectsContext.tsx';
import { createEffectsStore } from './effects-store.ts';
import type { Reminder } from './effects-store.ts';

afterEach(() => {
  cleanup();
});

function reminder(id: string, state: Reminder['state'] = 'pending'): Reminder {
  return {
    id,
    stackId: 'smart-todo',
    message: `Message ${id}`,
    dueAt: 2000,
    createdAt: 1000,
    state,
  };
}

describe('effects-store', () => {
  it('starts with nothing running, no reminders and no notices', () => {
    const state = createEffectsStore().getState();
    expect(state.running.size).toBe(0);
    expect(state.reminders).toEqual([]);
    expect(state.notices).toEqual([]);
  });

  it('setRunning adds and removes keys without touching the old set', () => {
    const store = createEffectsStore();
    const before = store.getState().running;
    store.getState().setRunning('s/a', true);
    const afterAdd = store.getState().running;
    expect(afterAdd).not.toBe(before);
    expect(before.size).toBe(0);
    expect(afterAdd.has('s/a')).toBe(true);

    store.getState().setRunning('s/b', true);
    expect([...store.getState().running]).toEqual(['s/a', 's/b']);
    expect(afterAdd.has('s/b')).toBe(false);

    const beforeRemove = store.getState().running;
    store.getState().setRunning('s/a', false);
    expect([...store.getState().running]).toEqual(['s/b']);
    expect(beforeRemove.has('s/a')).toBe(true);
  });

  it('setRunning with no change keeps the same state object', () => {
    const store = createEffectsStore();
    store.getState().setRunning('s/a', true);
    const state = store.getState();
    store.getState().setRunning('s/a', true);
    store.getState().setRunning('s/zzz', false);
    expect(store.getState()).toBe(state);
  });

  it('setReminders replaces the list and does not keep the caller array', () => {
    const store = createEffectsStore();
    const first = [reminder('r1'), reminder('r2')];
    store.getState().setReminders(first);
    const stored = store.getState().reminders;
    expect(stored).toEqual(first);
    expect(stored).not.toBe(first);

    first.push(reminder('r3'));
    expect(store.getState().reminders).toHaveLength(2);

    store.getState().setReminders([reminder('r9', 'missed')]);
    expect(store.getState().reminders.map((item) => item.id)).toEqual(['r9']);
    expect(stored).toHaveLength(2);
  });

  it('addNotice appends in order and leaves the old list unchanged', () => {
    const store = createEffectsStore();
    store.getState().addNotice({ id: 'n1', text: 'One' });
    const old = store.getState().notices;
    store.getState().addNotice({ id: 'n2', text: 'Two' });
    expect(store.getState().notices).toEqual([
      { id: 'n1', text: 'One' },
      { id: 'n2', text: 'Two' },
    ]);
    expect(old).toEqual([{ id: 'n1', text: 'One' }]);
  });

  it('addNotice ignores an id that is already shown', () => {
    const store = createEffectsStore();
    store.getState().addNotice({ id: 'n1', text: 'One' });
    const state = store.getState();
    store.getState().addNotice({ id: 'n1', text: 'Changed' });
    expect(store.getState()).toBe(state);
    expect(store.getState().notices).toEqual([{ id: 'n1', text: 'One' }]);
  });

  it('dismissNotice removes only that notice and ignores an unknown id', () => {
    const store = createEffectsStore();
    store.getState().addNotice({ id: 'n1', text: 'One' });
    store.getState().addNotice({ id: 'n2', text: 'Two' });
    const old = store.getState().notices;

    store.getState().dismissNotice('n1');
    expect(store.getState().notices).toEqual([{ id: 'n2', text: 'Two' }]);
    expect(old).toHaveLength(2);

    const state = store.getState();
    store.getState().dismissNotice('nope');
    expect(store.getState()).toBe(state);
  });

  it('actions do not change the other parts of the state', () => {
    const store = createEffectsStore();
    store.getState().setReminders([reminder('r1')]);
    store.getState().addNotice({ id: 'n1', text: 'One' });
    store.getState().setRunning('s/a', true);
    const { reminders, notices } = store.getState();
    store.getState().setRunning('s/b', true);
    expect(store.getState().reminders).toBe(reminders);
    expect(store.getState().notices).toBe(notices);
  });
});

describe('EffectsContext', () => {
  it('useEffects returns null without a provider', () => {
    function Probe() {
      return createElement('span', { 'data-testid': 'probe' }, String(useEffects() === null));
    }
    render(createElement(Probe));
    expect(screen.getByTestId('probe').textContent).toBe('true');
  });

  it('useEffectsStore throws without a provider', () => {
    function Probe() {
      useEffectsStore((state) => state.notices);
      return null;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(createElement(Probe))).toThrow(/EffectsProvider/);
    spy.mockRestore();
  });

  it('the provider gives the store and the runtime handle', () => {
    const store = createEffectsStore();
    const runtime: EffectsActions = { cancelReminder: vi.fn(), dismissReminder: vi.fn() };
    let seen: ReturnType<typeof useEffects> = null;
    function Probe() {
      seen = useEffects();
      return null;
    }
    render(createElement(EffectsProvider, { store, runtime, children: createElement(Probe) }));
    expect(seen).not.toBeNull();
    expect(seen).toEqual({ store, runtime });
  });

  it('the runtime handle is null when the provider gets none', () => {
    const store = createEffectsStore();
    let seen: ReturnType<typeof useEffects> = null;
    function Probe() {
      seen = useEffects();
      return null;
    }
    render(createElement(EffectsProvider, { store, children: createElement(Probe) }));
    expect(seen).not.toBeNull();
    expect(seen).toEqual({ store, runtime: null });
  });

  it('useEffectsStore re-renders when the selected state changes', () => {
    const store = createEffectsStore();
    function Probe() {
      const count = useEffectsStore((state) => state.notices.length);
      const busy = useEffectsStore((state) => state.running.has('s/a'));
      return createElement('span', { 'data-testid': 'probe' }, `${count}:${String(busy)}`);
    }
    render(createElement(EffectsProvider, { store, children: createElement(Probe) }));
    expect(screen.getByTestId('probe').textContent).toBe('0:false');
    act(() => {
      store.getState().addNotice({ id: 'n1', text: 'One' });
      store.getState().setRunning('s/a', true);
    });
    expect(screen.getByTestId('probe').textContent).toBe('1:true');
    act(() => {
      store.getState().setRunning('s/a', false);
    });
    expect(screen.getByTestId('probe').textContent).toBe('1:false');
  });
});
