import type { KeyboardEvent } from 'react';
import type { StackObject } from '@hypergeist/shared/format';
import { accessibleName } from '../lib/accessible-name.ts';
import { objectCssVars } from '../lib/css-vars.ts';
import { useStackStore } from '../state/StackStoreContext.tsx';

/**
 * The control of an Object. With `preview` set it is inert display only (Edit mode):
 * Fields are read-only with no change handler and Buttons run nothing.
 */
function ObjectControl({
  object,
  preview,
}: {
  readonly object: StackObject;
  readonly preview: boolean;
}) {
  const activateButton = useStackStore((state) => state.activateButton);
  const typeInField = useStackStore((state) => state.typeInField);
  const name = accessibleName(object);

  switch (object.type) {
    case 'button':
      return (
        <button
          type="button"
          aria-label={name}
          tabIndex={preview ? -1 : undefined}
          onClick={preview ? undefined : () => activateButton(object.id)}
        >
          {object.label}
        </button>
      );
    case 'field': {
      const readOnly = preview || object.readOnly;
      const onChange = readOnly
        ? undefined
        : (event: { readonly target: { readonly value: string } }) =>
            typeInField(object.id, event.target.value);
      return object.multiline ? (
        <textarea
          aria-label={name}
          value={object.value}
          placeholder={object.placeholder}
          readOnly={readOnly}
          tabIndex={preview ? -1 : undefined}
          onChange={onChange}
        />
      ) : (
        <input
          type="text"
          aria-label={name}
          value={object.value}
          placeholder={object.placeholder}
          readOnly={readOnly}
          tabIndex={preview ? -1 : undefined}
          onChange={onChange}
        />
      );
    }
    case 'image':
      // A placeholder only. No `<img>` is ever created and `src` is never loaded.
      return (
        <div
          className="image-placeholder"
          role="img"
          aria-label={object.alt !== '' ? object.alt : name}
        >
          <span className="image-placeholder-title">Image</span>
          <span className="image-placeholder-alt">{object.alt}</span>
        </div>
      );
    case 'ai-field':
      return (
        <textarea
          aria-label={name}
          value={object.value}
          placeholder="AI field. AI arrives in a later release."
          readOnly
          tabIndex={preview ? -1 : undefined}
        />
      );
    case 'list': {
      const items = object.items.map((item, index) => <li key={index}>{item}</li>);
      // The list takes the keyboard focus so it can scroll without a pointer.
      return object.ordered ? (
        <ol aria-label={name} tabIndex={preview ? -1 : 0}>
          {items}
        </ol>
      ) : (
        <ul aria-label={name} tabIndex={preview ? -1 : 0}>
          {items}
        </ul>
      );
    }
  }
}

/**
 * One Object on the Canvas.
 *
 * Interact mode: the native control sits directly in the positioned wrapper.
 * Edit mode: the wrapper is a focusable button that selects the Object, and the
 * control inside it is an inert preview, so typing and Handlers cannot run.
 */
export function ObjectView({ object }: { readonly object: StackObject }) {
  const mode = useStackStore((state) => state.mode);
  const selected = useStackStore((state) => state.selectedObjectId === object.id);
  const selectObject = useStackStore((state) => state.selectObject);

  const common = {
    className: 'canvas-object',
    style: objectCssVars(object),
    'data-type': object.type,
    'data-readonly': object.type === 'field' ? String(object.readOnly) : undefined,
  };

  if (mode === 'interact') {
    return (
      <div {...common}>
        <ObjectControl object={object} preview={false} />
      </div>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectObject(object.id);
    }
  };

  return (
    <div
      {...common}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${accessibleName(object)} (${object.type})`}
      onClick={(event) => {
        // The click is handled here, so the Canvas background handler must not clear it.
        event.stopPropagation();
        selectObject(object.id);
      }}
      onKeyDown={onKeyDown}
    >
      <div className="object-preview" inert aria-hidden="true">
        <ObjectControl object={object} preview />
      </div>
    </div>
  );
}
