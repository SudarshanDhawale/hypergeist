import { useId, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { useAi, useAiStore } from '../state/AiContext.tsx';

/** The example sentences, as in the recorded examples. */
export const EXAMPLE_PROMPTS: readonly string[] = ['Make me a to-do list', 'Add a button'];

export type MakeStackSectionProps = {
  /**
   * Makes, stores and opens the stack. Resolves with a message to show when nothing was opened,
   * or `null` when the stack was opened.
   */
  readonly onMake: (text: string) => Promise<string | null>;
};

/**
 * "Make a stack with the Ghost": a sentence, a button, and the example sentences. It renders
 * nothing without an `AiProvider`.
 */
export function MakeStackSection(props: MakeStackSectionProps): JSX.Element | null {
  const ai = useAi();
  if (ai === null) return null;
  return <MakeStackForm {...props} stop={() => ai.controller.stop()} />;
}

function MakeStackForm({
  onMake,
  stop,
}: MakeStackSectionProps & { readonly stop: () => void }): JSX.Element {
  const inputId = useId();
  const turnRunning = useAiStore((state) => state.busyNewStack);
  const [text, setText] = useState('');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const busy = turnRunning || working;

  async function make(sentence: string): Promise<void> {
    const trimmed = sentence.trim();
    if (busy || trimmed === '') return;
    setWorking(true);
    setMessage(null);
    try {
      setMessage(await onMake(trimmed));
    } finally {
      setWorking(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void make(text);
  }

  return (
    <section className="make-stack" aria-labelledby={`${inputId}-title`}>
      <h3 id={`${inputId}-title`}>Make a stack with the Ghost</h3>
      <form className="make-stack-form" onSubmit={onSubmit}>
        <label htmlFor={inputId} className="make-stack-label">
          Describe the stack
        </label>
        <input
          id={inputId}
          type="text"
          className="make-stack-input"
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <button type="submit" className="button-primary" disabled={busy || text.trim() === ''}>
          Make it
        </button>
        {turnRunning ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : null}
      </form>
      <div className="make-stack-examples">
        <span className="stacks-meta">Examples:</span>
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={busy}
            onClick={() => {
              setText(prompt);
              void make(prompt);
            }}
          >
            {prompt}
          </button>
        ))}
      </div>
      <div role="status" aria-live="polite" className="make-stack-status">
        {busy ? <p className="stacks-note">The Ghost is making your stack.</p> : null}
        {!busy && message !== null ? <p className="stacks-note">{message}</p> : null}
      </div>
    </section>
  );
}
