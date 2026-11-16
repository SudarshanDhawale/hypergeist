import { useId } from 'react';
import type { JSX } from 'react';
import { Modal } from './Modal.tsx';

export type CopyDialogProps = {
  /** `import`: a file whose stack id is in use. `restore`: a trash record whose id is in use. */
  readonly kind: 'import' | 'restore';
  readonly name: string;
  readonly id: string;
  /** The id the copy will get. */
  readonly suggestedId: string;
  readonly onCopy: () => void;
  readonly onCancel: () => void;
};

/**
 * Asked when a stack id is already in use. A copy gets a new id, nothing is overwritten, and
 * Cancel changes nothing. The copy button is the default button.
 */
export function CopyDialog({
  kind,
  name,
  id,
  suggestedId,
  onCopy,
  onCancel,
}: CopyDialogProps): JSX.Element {
  const messageId = useId();
  const importing = kind === 'import';
  return (
    <Modal
      title={importing ? 'This stack id is in use' : 'Cannot restore under the same id'}
      onClose={onCancel}
      nested
      describedBy={messageId}
      className="dialog-small"
    >
      <div className="dialog-body">
        <p id={messageId} className="dialog-message">
          {importing
            ? `A stack with the id "${id}" is already in this browser. You can import "${name}" as a copy with the id "${suggestedId}", or cancel. The existing stack is not changed.`
            : `A stack with the id "${id}" is already in use. You can restore "${name}" as a copy with the id "${suggestedId}", or cancel. The existing stack is not changed.`}
        </p>
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button-primary" data-autofocus onClick={onCopy}>
          {importing ? 'Import as a copy' : 'Restore as a copy'}
        </button>
      </div>
    </Modal>
  );
}
