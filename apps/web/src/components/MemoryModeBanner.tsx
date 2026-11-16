import { usePersistenceInfo } from '../state/SaveStateContext.tsx';

/** Shown in Memory_Mode only: nothing is stored, so the user is told to export. */
export function MemoryModeBanner() {
  const info = usePersistenceInfo();
  if (info === null || !info.memoryMode) return null;

  return (
    <div className="memory-banner" role="note">
      <p>Changes are lost when you close this page. Export before leaving.</p>
      <button type="button" onClick={info.onExport}>
        Export this stack
      </button>
    </div>
  );
}
