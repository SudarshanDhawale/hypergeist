import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { AiFieldObject, StackObject } from '@hypergeist/shared/format';
import { accessibleName } from '../lib/accessible-name.ts';
import { objectCssVars } from '../lib/css-vars.ts';
import { useEffects, useEffectsStore } from '../state/EffectsContext.tsx';
import { useStackStore } from '../state/StackStoreContext.tsx';

const AI_FIELD_PLACEHOLDER = 'AI field. Press its button to fill it.';

/**
 * The read-only AI field. `running` shows the visible "Thinking..." text and `aria-busy`.
 * `announce` turns on the polite live region that says the field was updated after a run.
 */
function AiFieldBox({
  object,
  preview,
  running,
  announce,
}: {
  readonly object: AiFieldObject;
  readonly preview: boolean;
  readonly running: boolean;
  readonly announce: boolean;
}) {
  const name = accessibleName(object);
  const [message, setMessage] = useState('');
  const sawRun = useRef(false);
  const lastValue = useRef(object.value);

  useEffect(() => {
    const changed = object.value !== lastValue.current;
    lastValue.current = object.value;
    if (running) {
      // A new run clears the old message so the same text can be announced again.
      if (!sawRun.current) setMessage('');
      sawRun.current = true;
    }
    if (changed && sawRun.current) {
      sawRun.current = false;
      if (announce) setMessage(`AI field ${name} updated`);
    } else if (!running) {
      sawRun.current = false;
    }
  }, [running, object.value, announce, name]);

  return (
    <div className={running ? 'ai-field-box ai-active' : 'ai-field-box'}>
      <textarea
        aria-label={name}
        aria-busy={running}
        value={object.value}
        placeholder={AI_FIELD_PLACEHOLDER}
        readOnly
        tabIndex={preview ? -1 : undefined}
      />
      {running ? <span className="ai-thinking">Thinking...</span> : null}
      {announce && !preview ? (
        <span className="ai-live" aria-live="polite">
          {message}
        </span>
      ) : null}
    </div>
  );
}

/** Reads the running state from the effects store. Rendered only inside an `EffectsProvider`. */
function AiFieldWithEffects({
  object,
  preview,
}: {
  readonly object: AiFieldObject;
  readonly preview: boolean;
}) {
  const stackId = useStackStore((state) => state.stack.id);
  const running = useEffectsStore((state) => state.running.has(`${stackId}/${object.id}`));
  return <AiFieldBox object={object} preview={preview} running={running} announce />;
}

function AiFieldControl({
  object,
  preview,
}: {
  readonly object: AiFieldObject;
  readonly preview: boolean;
}) {
  const effects = useEffects();
  return effects === null ? (
    <AiFieldBox object={object} preview={preview} running={false} announce={false} />
  ) : (
    <AiFieldWithEffects object={object} preview={preview} />
  );
}

/**
 * The control of an Object. With `preview` set it is inert display only (Edit and AI edit modes):
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
      return <AiFieldControl object={object} preview={preview} />;
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
 * Edit and AI edit modes: the wrapper is a focusable button that selects the Object, and the
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
