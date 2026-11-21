import { useId, useState } from 'react';
import type { JSX } from 'react';
import { validateBaseUrl } from '../ai/index.ts';
import type { AiSettings } from '../ai/index.ts';
import { useAi, useAiStore } from '../state/AiContext.tsx';
import { Modal } from './Modal.tsx';

export const KEY_MEMORY_TEXT =
  'The key is kept only in memory. You must enter it again after you reload the page.';
export const OWN_PRIVACY_TEXT =
  'With your own model, the stack and your message are sent to that provider.';
export const DEMO_PRIVACY_TEXT =
  "In demo mode, the stack and your message go through this app's server to a hosted model provider.";

type Props = { readonly onClose: () => void };

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string };

function Dialog({ onClose }: Props): JSX.Element | null {
  const ai = useAi();
  const saved = useAiStore((state) => state.settings);
  const hasKey = useAiStore((state) => state.hasKey);
  const [provider, setProvider] = useState<AiSettings['provider']>(saved.provider);
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl);
  const [model, setModel] = useState(saved.model);
  const [key, setKey] = useState('');
  const [touched, setTouched] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [messages, setMessages] = useState<readonly string[]>([]);
  const groupName = useId();
  const urlId = useId();
  const urlErrorId = useId();
  const modelId = useId();
  const keyId = useId();

  if (ai === null) return null;
  const { controller } = ai;
  const own = provider === 'own';

  const urlCheck = validateBaseUrl(baseUrl);
  const urlMessage =
    own && !urlCheck.ok && (touched || baseUrl.trim() !== '') ? urlCheck.message : null;

  function draft(): AiSettings {
    return { provider, baseUrl: baseUrl.trim(), model: model.trim() };
  }

  async function persist(): Promise<boolean> {
    setNotice(null);
    if (own) {
      if (!urlCheck.ok) {
        // The message shows under the field.
        setTouched(true);
        return false;
      }
      if (model.trim() === '') {
        setNotice({ kind: 'error', text: 'Enter a model name first.' });
        return false;
      }
    }
    const outcome = await controller.saveSettings(draft(), key === '' ? undefined : key);
    if (!outcome.ok) {
      setNotice({ kind: 'error', text: outcome.message });
      return false;
    }
    return true;
  }

  async function onSave(): Promise<void> {
    setWorking(true);
    setMessages([]);
    try {
      if (await persist()) setNotice({ kind: 'ok', text: 'Saved.' });
    } finally {
      setWorking(false);
    }
  }

  async function onCheck(): Promise<void> {
    setWorking(true);
    setMessages([]);
    try {
      // The check reads the saved settings and the key holder, so save the entries first.
      if (!(await persist())) return;
      const outcome = await controller.checkProvider();
      if (outcome.ok) {
        setMessages(outcome.report.messages);
        if (outcome.report.messages.length === 0) {
          setNotice({ kind: 'ok', text: 'The model answered.' });
        }
      } else {
        setNotice({ kind: 'error', text: outcome.message });
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal title="AI settings" onClose={onClose} className="ai-settings">
      <div className="dialog-body">
        <fieldset className="ai-settings-choice">
          <legend>Model</legend>
          <label className="ai-settings-option">
            <input
              type="radio"
              name={groupName}
              checked={!own}
              data-autofocus
              onChange={() => setProvider('demo')}
            />
            <span>Demo (no key needed)</span>
          </label>
          <label className="ai-settings-option">
            <input
              type="radio"
              name={groupName}
              checked={own}
              onChange={() => setProvider('own')}
            />
            <span>My own model</span>
          </label>
        </fieldset>

        {own ? (
          <div className="ai-settings-fields">
            <label htmlFor={urlId}>Base URL</label>
            <input
              id={urlId}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={baseUrl}
              aria-invalid={urlMessage !== null}
              aria-describedby={urlMessage === null ? undefined : urlErrorId}
              onChange={(event) => setBaseUrl(event.target.value)}
              onBlur={() => setTouched(true)}
            />
            {urlMessage === null ? null : (
              <p id={urlErrorId} className="ai-settings-error">
                {urlMessage}
              </p>
            )}
            <label htmlFor={modelId}>Model name</label>
            <input
              id={modelId}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <label htmlFor={keyId}>Key</label>
            <input
              id={keyId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              placeholder={hasKey ? 'A key is set in memory' : ''}
              onChange={(event) => setKey(event.target.value)}
            />
            <p>{KEY_MEMORY_TEXT}</p>
            <p>{OWN_PRIVACY_TEXT}</p>
            <div>
              <button type="button" disabled={working} onClick={() => void onCheck()}>
                Check this model
              </button>
            </div>
          </div>
        ) : (
          <p>{DEMO_PRIVACY_TEXT}</p>
        )}

        <div aria-live="polite" className="ai-settings-results">
          {notice === null ? null : (
            <p className={notice.kind === 'error' ? 'ai-settings-error' : undefined}>
              {notice.text}
            </p>
          )}
          {messages.length === 0 ? null : (
            <ul aria-label="Check results" className="ai-settings-messages">
              {messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="button-primary"
          disabled={working}
          onClick={() => void onSave()}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

/** The AI settings window. Renders nothing without AI. */
export function AiSettingsDialog({ onClose }: Props): JSX.Element | null {
  return useAi() === null ? null : <Dialog onClose={onClose} />;
}
