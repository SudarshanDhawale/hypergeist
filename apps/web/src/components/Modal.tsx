import { useEffect, useId, useRef } from 'react';
import type { JSX, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Open modals, oldest first. Only the newest one may take focus back. */
const openModals: symbol[] = [];

const FOCUSABLE = [
  'button:not(:disabled)',
  'input:not(:disabled):not([hidden]):not([type="hidden"])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export type ModalProps = {
  readonly title: string;
  readonly onClose: () => void;
  /** CSS class for the size of the window. */
  readonly className?: string;
  /** A modal opened on top of another one: no fill in the scrim, so the window below stays visible. */
  readonly nested?: boolean;
  /** Id of an element inside the dialog that describes it. */
  readonly describedBy?: string;
  readonly children: ReactNode;
};

/**
 * A modal window: paper window with a title bar over a dithered scrim, drawn in a portal on
 * `document.body`. The window has `role="dialog"` and `aria-modal`, is named by its title, takes
 * focus when it opens (on the child marked `data-autofocus`, else on the window itself), keeps
 * Tab inside, closes on Escape, and gives focus back to what had it before it opened.
 */
export function Modal({
  title,
  onClose,
  className,
  nested = false,
  describedBy,
  children,
}: ModalProps): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const tokenRef = useRef<symbol | null>(null);

  // Open: remember the opener, take focus. Close: give focus back if the opener is still there.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const opener = document.activeElement;
    const token = Symbol('modal');
    tokenRef.current = token;
    openModals.push(token);
    const target = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog;
    target.focus();
    return () => {
      openModals.splice(openModals.indexOf(token), 1);
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);

  // After every render: if focus fell to the page body (the control that had it was removed),
  // put it on the window, so keyboard users are not sent back to the start of the page. Focus
  // that was moved to another element on purpose, such as the opener while closing, stays there.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const isTop = openModals[openModals.length - 1] === tokenRef.current;
    if (isTop && (document.activeElement === null || document.activeElement === document.body)) {
      dialog.focus();
    }
  });

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      // Only the newest modal reacts, and nothing behind it sees the key.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    // Tab from a nested modal must not move the outer one's focus.
    event.stopPropagation();
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className={nested ? 'dialog-scrim dialog-scrim-nested' : 'dialog-scrim'}>
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={className === undefined ? 'window dialog' : `window dialog ${className}`}
        onKeyDown={onKeyDown}
      >
        <div className="title-bar">
          <h2 id={titleId}>{title}</h2>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  );
}
