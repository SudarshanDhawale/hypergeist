import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSaveStateStore } from '../state/save-state-store.ts';
import { SaveStateProvider } from '../state/SaveStateContext.tsx';
import { MemoryModeBanner } from './MemoryModeBanner.tsx';

afterEach(cleanup);

function setup(memoryMode: boolean) {
  const onExport = vi.fn();
  const view = render(
    <SaveStateProvider store={createSaveStateStore()} memoryMode={memoryMode} onExport={onExport}>
      <MemoryModeBanner />
    </SaveStateProvider>,
  );
  return { onExport, view };
}

describe('MemoryModeBanner', () => {
  it('renders nothing without a provider', () => {
    const { container } = render(<MemoryModeBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing outside Memory_Mode', () => {
    const { view } = setup(false);
    expect(view.container.innerHTML).toBe('');
  });

  it('shows the exact text as a note in Memory_Mode', () => {
    setup(true);
    expect(screen.getByRole('note').textContent).toContain(
      'Changes are lost when you close this page. Export before leaving.',
    );
    expect(screen.getByRole('note').querySelector('p')?.textContent).toBe(
      'Changes are lost when you close this page. Export before leaving.',
    );
  });

  it('calls onExport from the Export button', () => {
    const { onExport } = setup(true);
    fireEvent.click(screen.getByRole('button', { name: 'Export this stack' }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('adds no status role', () => {
    setup(true);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
