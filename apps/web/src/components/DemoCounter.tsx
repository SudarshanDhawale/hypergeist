import type { JSX } from 'react';
import { useAi, useAiStore } from '../state/AiContext.tsx';

export const DEMO_LIMIT_REACHED_TEXT = 'Demo limit reached: examples only';

/** Text for the remaining demo answers. */
export function demoCounterText(remaining: number): string {
  return remaining <= 0 ? DEMO_LIMIT_REACHED_TEXT : `Demo: ${String(remaining)} left today`;
}

function Counter(): JSX.Element | null {
  const quota = useAiStore((state) => state.quota);
  const provider = useAiStore((state) => state.settings.provider);
  if (quota === null || provider !== 'demo') return null;
  return <span className="demo-counter">{demoCounterText(quota.remaining)}</span>;
}

/** The shared demo allowance. Renders nothing without AI, in own-model mode, or without a quota. */
export function DemoCounter(): JSX.Element | null {
  return useAi() === null ? null : <Counter />;
}
