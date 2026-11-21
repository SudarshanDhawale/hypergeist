import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiController } from '../state/ai-controller.ts';
import { AiProvider } from '../state/AiContext.tsx';
import { createAiStore } from '../state/ai-store.ts';
import type { AiStoreApi } from '../state/ai-store.ts';
import { DemoCounter } from './DemoCounter.tsx';

afterEach(cleanup);

function renderCounter(store: AiStoreApi) {
  const controller = { init: vi.fn() } as unknown as AiController;
  return render(
    <AiProvider controller={controller} store={store}>
      <DemoCounter />
    </AiProvider>,
  );
}

describe('DemoCounter', () => {
  it('renders nothing without a provider', () => {
    const { container } = render(<DemoCounter />);
    expect(container.textContent).toBe('');
  });

  it('is hidden while the quota is null', () => {
    const { container } = renderCounter(createAiStore());
    expect(container.textContent).toBe('');
  });

  it('shows N left', () => {
    const store = createAiStore();
    store.getState().setQuota({ remaining: 7 });
    renderCounter(store);
    expect(screen.getByText('Demo: 7 left today')).toBeTruthy();
  });

  it('says the limit is reached at 0', () => {
    const store = createAiStore();
    store.getState().setQuota({ remaining: 0 });
    renderCounter(store);
    expect(screen.getByText('Demo limit reached: examples only')).toBeTruthy();
  });

  it('is hidden in own-model mode and follows store changes', () => {
    const store = createAiStore();
    store.getState().setQuota({ remaining: 3 });
    const { container } = renderCounter(store);
    expect(container.textContent).toBe('Demo: 3 left today');
    act(() => {
      store.getState().setSettings({ provider: 'own', baseUrl: '', model: '' });
    });
    expect(container.textContent).toBe('');
    act(() => {
      store.getState().setSettings({ provider: 'demo', baseUrl: '', model: '' });
      store.getState().setQuota({ remaining: 2 });
    });
    expect(container.textContent).toBe('Demo: 2 left today');
  });
});
