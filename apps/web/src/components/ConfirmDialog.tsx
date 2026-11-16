import { useId } from 'react';
import type { JSX, ReactNode } from 'react';
import { Modal } from './Modal.tsx';

export type ConfirmDialogProps = {
  readonly title: string;
  /** Says what will happen and what is lost. */
  readonly message: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

/**
 * Asks before something that cannot be undone. Cancel is the default button: it has the double
 * border and takes focus, so Enter right after the dialog opens changes nothing. Escape cancels.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  const messageId = useId();
  return (
    <Modal title={title} onClose={onCancel} nested describedBy={messageId} className="dialog-small">
      <div className="dialog-body">
        <div id={messageId} className="dialog-message">
          {message}
        </div>
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="button-primary" data-autofocus onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
