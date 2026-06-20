/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { CUSTOM_SENTINEL } from '../../shared/ask-user-sentinel';
import type { ExtensionUIRequestPayload, ExtensionUIResponsePayload, WebviewToHostMessage } from '../../shared/protocol';

interface ExtensionUIPromptProps {
  sessionPath: string;
  request: ExtensionUIRequestPayload;
  postMessage: (msg: WebviewToHostMessage) => void;
}

export function ExtensionUIPrompt({ sessionPath, request, postMessage }: ExtensionUIPromptProps) {
  const respond = useCallback((response: ExtensionUIResponsePayload) => {
    postMessage({ type: 'extensionUiResponse', sessionPath, response });
  }, [postMessage, sessionPath]);

  switch (request.method) {
    case 'confirm':
      return (
        <ConfirmPrompt
          id={request.id}
          title={request.title}
          message={request.message}
          extensionId={request.extensionId}
          onRespond={respond}
        />
      );
    case 'select':
      return (
        <SelectPrompt
          id={request.id}
          title={request.title}
          options={request.options}
          extensionId={request.extensionId}
          onRespond={respond}
        />
      );
    case 'input':
      return (
        <InputPrompt
          id={request.id}
          title={request.title}
          placeholder={request.placeholder}
          extensionId={request.extensionId}
          onRespond={respond}
        />
      );
    default:
      return null;
  }
}

// ─── Confirm ─────────────────────────────────────────────────────────────────

interface ConfirmPromptProps {
  id: string;
  title: string;
  message: string;
  timeout?: number;
  extensionId?: string;
  onRespond: (r: ExtensionUIResponsePayload) => void;
}

function ConfirmPrompt({ id, title, message, timeout, extensionId, onRespond }: ConfirmPromptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const remaining = useCountdown(timeout);

  useEffect(() => { containerRef.current?.focus(); }, []);

  useEffect(() => {
    if (remaining === 0) {
      onRespond({ id, cancelled: true });
    }
  }, [remaining, id, onRespond]);

  // Scope the keydown handler to the prompt container (focused on mount) instead
  // of `document`, so pressing Enter to send a message in the composer (or to
  // confirm an inline edit) no longer also confirms/denies this prompt.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        // Let focused buttons handle Enter via their native click (so Enter on
        // Deny denies instead of confirming). Only confirm when focus is on the
        // prompt body itself.
        const target = e.target as HTMLElement | null;
        if (target?.closest('button')) return;
        e.preventDefault();
        onRespond({ id, confirmed: true });
      }
      if (e.key === 'Escape') { e.preventDefault(); onRespond({ id, confirmed: false }); }
    };
    node.addEventListener('keydown', handler);
    return () => node.removeEventListener('keydown', handler);
  }, [id, onRespond]);

  return (
    <div ref={containerRef} class="ext-prompt" tabIndex={-1} role="alertdialog" aria-label={title}>
      <div class="ext-prompt-row">
        <span class="ext-prompt-icon" aria-hidden="true">?</span>
        <div class="ext-prompt-content">
          {extensionId && <span class="ext-prompt-eyebrow">{extensionId}</span>}
          <span class="ext-prompt-text">{message || title}</span>
          {remaining !== null && <span class="ext-prompt-countdown">{remaining}s</span>}
        </div>
        <div class="ext-prompt-actions">
          <button class="ext-prompt-btn secondary" type="button" onClick={() => onRespond({ id, confirmed: false })}>
            Deny
          </button>
          <button class="ext-prompt-btn primary" type="button" onClick={() => onRespond({ id, confirmed: true })}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Select ──────────────────────────────────────────────────────────────────

interface SelectPromptProps {
  id: string;
  title: string;
  options: string[];
  timeout?: number;
  extensionId?: string;
  onRespond: (r: ExtensionUIResponsePayload) => void;
}

function SelectPrompt({ id, title, options, timeout, extensionId, onRespond }: SelectPromptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const remaining = useCountdown(timeout);
  const [customValue, setCustomValue] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { containerRef.current?.focus(); }, []);

  useEffect(() => {
    if (remaining === 0) {
      onRespond({ id, cancelled: true });
    }
  }, [remaining, id, onRespond]);

  useEffect(() => {
    if (showCustomInput) {
      customInputRef.current?.focus();
    }
  }, [showCustomInput]);

  // Scope the Escape handler to the prompt container so pressing Escape to
  // cancel an inline edit or blur the composer no longer also cancels this
  // ask_user prompt from anywhere on the page.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onRespond({ id, cancelled: true }); }
    };
    node.addEventListener('keydown', handler);
    return () => node.removeEventListener('keydown', handler);
  }, [id, onRespond]);

  const handleCustomSubmit = useCallback(() => {
    if (customValue.trim()) {
      onRespond({ id, value: customValue.trim() });
    }
  }, [id, customValue, onRespond]);

  const handleCustomKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && customValue.trim()) {
      e.preventDefault();
      onRespond({ id, value: customValue.trim() });
    }
    // Escape is handled by the container-scoped listener; handling it here too
    // would double-respond because the event bubbles up to the container.
  }, [id, customValue, onRespond]);

  return (
    <div ref={containerRef} class="ext-prompt" tabIndex={-1} role="dialog" aria-label={title}>
      <div class="ext-prompt-row">
        <span class="ext-prompt-icon" aria-hidden="true">?</span>
        <div class="ext-prompt-content">
          {extensionId && <span class="ext-prompt-eyebrow">{extensionId}</span>}
          <span class="ext-prompt-text">{title}</span>
        </div>
        {!showCustomInput && (
          <button class="ext-prompt-cancel" type="button" onClick={() => onRespond({ id, cancelled: true })}>
            Cancel
          </button>
        )}
      </div>
      <div class="ext-prompt-row">
        <div class="ext-prompt-options">
          {options.map((option) =>
            option === CUSTOM_SENTINEL ? (
              <button
                key={option}
                class="ext-prompt-option custom"
                type="button"
                onClick={() => setShowCustomInput(true)}
              >
                Custom…
              </button>
            ) : (
              <button
                key={option}
                class="ext-prompt-option"
                type="button"
                onClick={() => onRespond({ id, value: option })}
              >
                {option}
              </button>
            ),
          )}
        </div>
      </div>
      {showCustomInput && (
        <div class="ext-prompt-row ext-prompt-custom-row">
          <input
            ref={customInputRef}
            class="ext-prompt-input"
            type="text"
            value={customValue}
            placeholder="Type your answer…"
            onInput={(e) => setCustomValue((e.target as HTMLInputElement).value)}
            onKeyDown={handleCustomKeyDown}
          />
          <div class="ext-prompt-actions">
            <button class="ext-prompt-btn secondary" type="button" onClick={() => onRespond({ id, cancelled: true })}>
              Cancel
            </button>
            <button
              class="ext-prompt-btn primary"
              type="button"
              disabled={!customValue.trim()}
              onClick={handleCustomSubmit}
            >
              Submit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Input ───────────────────────────────────────────────────────────────────

interface InputPromptProps {
  id: string;
  title: string;
  placeholder?: string;
  timeout?: number;
  extensionId?: string;
  onRespond: (r: ExtensionUIResponsePayload) => void;
}

function InputPrompt({ id, title, placeholder, timeout, extensionId, onRespond }: InputPromptProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const remaining = useCountdown(timeout);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (remaining === 0) {
      onRespond({ id, cancelled: true });
    }
  }, [remaining, id, onRespond]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && value.trim()) {
      e.preventDefault();
      onRespond({ id, value });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onRespond({ id, cancelled: true });
    }
  }, [id, value, onRespond]);

  return (
    <div class="ext-prompt" role="dialog" aria-label={title}>
      <div class="ext-prompt-row">
        <span class="ext-prompt-icon" aria-hidden="true">?</span>
        <div class="ext-prompt-content">
          {extensionId && <span class="ext-prompt-eyebrow">{extensionId}</span>}
          <span class="ext-prompt-text">{title}</span>
        </div>
        <button class="ext-prompt-cancel" type="button" onClick={() => onRespond({ id, cancelled: true })}>
          Cancel
        </button>
      </div>
      <div class="ext-prompt-row">
        <input
          ref={inputRef}
          class="ext-prompt-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
        />
        <button
          class="ext-prompt-btn primary"
          type="button"
          disabled={!value.trim()}
          onClick={() => onRespond({ id, value })}
        >
          Submit
        </button>
      </div>
    </div>
  );
}



// ─── Countdown hook ──────────────────────────────────────────────────────────

function useCountdown(timeoutMs?: number): number | null {
  const [remaining, setRemaining] = useState<number | null>(
    timeoutMs ? Math.ceil(timeoutMs / 1000) : null,
  );

  useEffect(() => {
    if (!timeoutMs) return;
    const end = Date.now() + timeoutMs;
    const tick = () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setRemaining(left);
    };
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [timeoutMs]);

  return remaining;
}