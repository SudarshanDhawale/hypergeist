import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, RefObject } from 'react';
import { chooseCanvasScale } from '../lib/canvas-scale.ts';
import type { Size } from '../lib/canvas-scale.ts';
import { useStackStore } from '../state/StackStoreContext.tsx';
import { ObjectView } from './ObjectView.tsx';
import { SelectionOverlay } from './SelectionOverlay.tsx';

/**
 * The content box of the element, kept current with a ResizeObserver.
 * `null` until measured, and always `null` where ResizeObserver does not exist (jsdom).
 */
function useContentSize(): readonly [RefObject<HTMLDivElement | null>, Size | null] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect === undefined) return;
      setSize((previous) =>
        previous !== null && previous.w === rect.width && previous.h === rect.height
          ? previous
          : { w: rect.width, h: rect.height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

/**
 * The current Card at the largest whole scale that fits the frame (1 when unmeasured).
 * Renders the `.canvas-frame` letterbox and the `.canvas` inside it.
 */
export function Canvas() {
  const cardWidth = useStackStore((state) => state.stack.cardWidth);
  const cardHeight = useStackStore((state) => state.stack.cardHeight);
  const card = useStackStore((state) =>
    state.stack.cards.find((candidate) => candidate.id === state.currentCardId),
  );
  const mode = useStackStore((state) => state.mode);
  const selectedObjectId = useStackStore((state) => state.selectedObjectId);
  const clearSelection = useStackStore((state) => state.clearSelection);

  const [frameRef, available] = useContentSize();
  const scale =
    available === null ? 1 : chooseCanvasScale(available, { w: cardWidth, h: cardHeight });

  const selected =
    selectedObjectId === null
      ? undefined
      : card?.objects.find((object) => object.id === selectedObjectId);

  // React's CSSProperties has no index signature for custom properties, so the
  // literal needs this one cast. The values are unitless numbers.
  const canvasVars = {
    '--card-w': cardWidth,
    '--card-h': cardHeight,
    '--scale': scale,
  } as CSSProperties;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') clearSelection();
  };

  return (
    <div className="canvas-frame" ref={frameRef}>
      {/* Pointer and Escape handling only clear the Selection. Every Object is
          keyboard operable through its own wrapper, so this needs no role. */}
      <div
        className="canvas"
        data-mode={mode}
        data-scale={scale}
        style={canvasVars}
        onClick={(event) => {
          if (event.target === event.currentTarget) clearSelection();
        }}
        onKeyDown={onKeyDown}
      >
        {card?.objects.map((object) => (
          <ObjectView key={object.id} object={object} />
        ))}
        {mode === 'edit' && selected !== undefined ? <SelectionOverlay object={selected} /> : null}
      </div>
    </div>
  );
}
