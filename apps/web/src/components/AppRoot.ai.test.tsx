import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { createSettingsRepository, loadScenarios } from '../ai/index.ts';
import { bootPersistence } from '../persistence/boot.ts';
import type { BootOptions } from '../persistence/boot.ts';
import { createMemoryRepository } from '../persistence/memory-repository.ts';
import type { SeedSet } from '../persistence/seed-set.ts';
import type { AiController } from '../state/ai-controller.ts';
import type { StackStoreApi } from '../state/stack-store.ts';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { AppRoot } from './AppRoot.tsx';

// The desktop is replaced by a probe that reads the AI context and the stack store.
const probe = vi.hoisted(() => ({
  controllers: [] as unknown[],
  stores: [] as unknown[],
}));

vi.mock('./Desktop.tsx', async () => {
  const { useAi: readAi } = await import('../state/AiContext.tsx');
  const { useStackStoreApi: readStore } = await import('../state/StackStoreContext.tsx');
  return {
    Desktop: () => {
      const ai = readAi();
      const store = readStore();
      probe.controllers.push(ai?.controller ?? null);
      probe.stores.push(store);
      return <p>probe</p>;
    },
  };
});

afterEach(() => {
  cleanup();
  probe.controllers.length = 0;
  probe.stores.length = 0;
});

const DEMO: Stack = (() => {
  const parsed = parseStack(demoText);
  if (!parsed.ok) throw new Error('The bundled demo stack is not valid.');
  return { ...parsed.value, id: 'demo', name: 'Demo stack' };
})();

const seedSet: SeedSet = { stacks: [{ stack: DEMO }], problems: [] };

function boot(options: BootOptions) {
  return bootPersistence({
    ...options,
    openRepository: () =>
      Promise.resolve({ repository: createMemoryRepository(), mode: 'indexeddb' as const }),
  });
}

describe('AppRoot: AI wiring', () => {
  it('provides one controller, calls init once, and the controller works on the app stack store', async () => {
    const settingsRepo = createSettingsRepository(null);
    const load = vi.spyOn(settingsRepo, 'load');
    const quotaCalls: string[] = [];
    const fetchStub = (input: RequestInfo | URL): Promise<Response> => {
      quotaCalls.push(typeof input === 'string' ? input : 'other');
      return Promise.reject(new Error('offline'));
    };
    render(
      <AppRoot
        boot={boot}
        now={() => 1}
        seedSet={seedSet}
        fetch={fetchStub as typeof fetch}
        scenarios={loadScenarios().scenarios}
        settingsRepository={settingsRepo}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const controller = probe.controllers.at(-1) as AiController | null;
    const store = probe.stores.at(-1) as StackStoreApi | undefined;
    expect(controller).not.toBeNull();
    expect(store).toBeDefined();
    expect(load).toHaveBeenCalledTimes(1);
    expect(quotaCalls).toEqual(['/api/ai/quota']);
    // Every render saw the same controller and the same stack store.
    expect(new Set(probe.controllers).size).toBe(1);
    expect(new Set(probe.stores).size).toBe(1);

    // The proxy is offline, so the recorded example answers and changes the app's own stack.
    const before = store?.getState().stack;
    await act(async () => {
      await controller?.send('Add a button');
    });
    expect(before).toBeDefined();
    expect(store?.getState().stack).not.toBe(before);
    expect(store?.getState().stack.id).toBe('demo');
  });
});
