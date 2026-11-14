import { useStackStore } from '../state/StackStoreContext.tsx';

/**
 * The Links of the current Card as buttons. In Edit mode they stay in the Tab order
 * with `aria-disabled` and ignore activation.
 */
export function LinkBar() {
  const links = useStackStore(
    (state) => state.stack.cards.find((card) => card.id === state.currentCardId)?.links,
  );
  const mode = useStackStore((state) => state.mode);
  const followLink = useStackStore((state) => state.followLink);

  if (links === undefined || links.length === 0) return null;

  const disabled = mode === 'edit';
  return (
    <nav className="link-bar" aria-label="Card links">
      {links.map((link) => (
        <button
          key={link.id}
          type="button"
          aria-disabled={disabled ? 'true' : undefined}
          onClick={() => {
            if (!disabled) followLink(link.id);
          }}
        >
          {link.label}
        </button>
      ))}
    </nav>
  );
}
