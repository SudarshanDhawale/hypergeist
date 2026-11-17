import { Fragment } from 'react';
import { propertyRows } from '../lib/property-rows.ts';
import { useStackStore } from '../state/StackStoreContext.tsx';

/**
 * Read-only table of the selected Object's properties. Shown in Edit and AI edit modes.
 * It holds no editable control: every value is plain text in a `<dd>`.
 */
export function PropertyReadout() {
  const mode = useStackStore((state) => state.mode);
  const selected = useStackStore((state) => {
    const card = state.stack.cards.find((candidate) => candidate.id === state.currentCardId);
    return card?.objects.find((object) => object.id === state.selectedObjectId);
  });

  if (mode === 'interact') return null;

  return (
    <section className="property-readout" aria-label="Properties">
      {selected === undefined ? (
        <p>Select an object to see its properties.</p>
      ) : (
        <dl>
          {propertyRows(selected).map((row) => (
            <Fragment key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.text}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  );
}
