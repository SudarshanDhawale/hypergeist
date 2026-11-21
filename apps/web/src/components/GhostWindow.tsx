import { useEffect, useId, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { useAi, useAiStore } from '../state/AiContext';
import type { AiController } from '../state/ai-controller';
import { useStackStore } from '../state/StackStoreContext';
import { lastEntrySource } from '../state/stack-store';
import { GhostSprite } from './GhostSprite';

/** Example prompts that fill the input. They match the recorded examples. */
const EXAMPLE_PROMPTS: readonly string[] = ['Make me a to-do list', 'Add a button'];

const HONEST_TEXT =
  'Demo answers come from a shared model or recorded examples. The AI can make mistakes. Undo restores the stack as it was.';

function GhostPanel({ controller }: { readonly controller: AiController }): JSX.Element {
  const lines = useAiStore((state) => state.lines);
  const busy = useAiStore((state) => state.busy);
  const canUndo = useStackStore((state) => lastEntrySource(state) === 'ai');
  const chipText = useStackStore((state) => {
    if (state.mode !== 'ai-edit' || state.selectedObjectId === null) return null;
    const card = state.stack.cards.find((candidate) => candidate.id === state.currentCardId);
    const object = card?.objects.find((candidate) => candidate.id === state.selectedObjectId);
    return object === undefined ? null : `Selected: ${object.name} (${object.type})`;
  });
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const inputId = useId();

  useEffect(() => {
    const log = logRef.current;
    if (log !== null) log.scrollTop = log.scrollHeight;
  }, [lines]);

  function submit(): void {
    const message = text.trim();
    if (busy || message === '') return;
    setText('');
    void controller.send(message);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  return (
    <aside
      className={busy ? 'window ghost-window is-thinking' : 'window ghost-window'}
      aria-label="Ghost chat"
    >
      <div className="title-bar">
        <h2>Ghost</h2>
      </div>
      <div className="ghost-body">
        <GhostSprite />
        <p className="ghost-note">{HONEST_TEXT}</p>
        <div className="ghost-log" ref={logRef} aria-live="polite">
          {lines.map((line) => (
            <p key={line.id} className={`ghost-line ghost-line-${line.kind}`}>
              {line.kind === 'user' ? <span className="ghost-who">You: </span> : null}
              {line.text}
            </p>
          ))}
        </div>
        {chipText === null ? null : <p className="ghost-chip">{chipText}</p>}
        <div className="ghost-examples">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button key={prompt} type="button" onClick={() => setText(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
        <label className="ghost-label" htmlFor={inputId}>
          Tell the Ghost what to do
        </label>
        <textarea
          id={inputId}
          className="ghost-input"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="ghost-actions">
          <button type="button" onClick={submit} disabled={busy || text.trim() === ''}>
            Send
          </button>
          {busy ? (
            <button type="button" onClick={() => controller.stop()}>
              Stop
            </button>
          ) : null}
          <button type="button" onClick={() => controller.undo()} disabled={!canUndo || busy}>
            Undo
          </button>
        </div>
      </div>
    </aside>
  );
}

/** The Ghost window: a chat panel, or a sleeping sprite when this build has no AI. */
export function GhostWindow(): JSX.Element {
  const ai = useAi();
  if (ai === null) {
    return (
      <aside className="window ghost-window" aria-label="Ghost is asleep. AI is not available.">
        <div className="title-bar">
          <h2>Ghost</h2>
        </div>
        <div className="ghost-body">
          <GhostSprite />
          <p className="ghost-text">AI is not available in this build</p>
        </div>
      </aside>
    );
  }
  return <GhostPanel controller={ai.controller} />;
}
