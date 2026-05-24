/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import type { ExtensionUIRequestPayload, ExtensionUIResponsePayload, WebviewToHostMessage } from '../../shared/protocol';

interface ExtensionUIPromptProps {
  request: ExtensionUIRequestPayload;
  postMessage: (msg: WebviewToHostMessage) => void;
}

export function ExtensionUIPrompt({ request, postMessage }: ExtensionUIPromptProps) {
  const respond = useCallback((response: ExtensionUIResponsePayload) => {
    postMessage({ type: 'extensionUiResponse', response });
  }, [postMessage]);

  switch (request.method) {
    case 'confirm':
      return (
        <ConfirmPrompt
          id={request.id}
          title={request.title}
          message={request.message}
          timeout={request.timeout}
          onRespond={respond}
        />
      );
    case 'select':
      return (
        <SelectPrompt
          id={request.id}
          title={request.title}
          options={request.options}
          timeout={request.timeout}
          onRespond={respond}
        />
      );
    case 'input':
      return (
        <InputPrompt
          id={request.id}
          title={request.title}
          placeholder={request.placeholder}
          timeout={request.timeout}
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
  onRespond: (r: ExtensionUIResponsePayload) => void;
}

function ConfirmPrompt({ id, title, message, timeout, onRespond }: ConfirmPromptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const remaining = useCountdown(timeout);

  useEffect(() => { containerRef.current?.focus(); }, []);

  useEffect(() => {
    if (remaining === 0) {
      onRespond({ id, cancelled: true });
    }
  }, [remaining, id, onRespond]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); onRespond({ id, confirmed: true }); }
      if (e.key === 'Escape') { e.preventDefault(); onRespond({ id, confirmed: false }); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [id, onRespond]);

  return (
    <div ref={containerRef} class="extension-ui-prompt" tabIndex={-1} role="alertdialog" aria-label={title}>
      <div class="extension-ui-prompt-header">
        <span class="extension-ui-prompt-icon">?</span>
        <span class="extension-ui-prompt-title">{title}</span>
        {remaining !== null && <span class="extension-ui-prompt-countdown">{remaining}s</span>}
      </div>
      <div class="extension-ui-prompt-body">{message}</div>
      <div class="extension-ui-prompt-actions">
        <button class="action-btn secondary" type="button" onClick={() => onRespond({ id, confirmed: false })}>
          Deny
        </button>
        <button class="action-btn primary" type="button" onClick={() => onRespond({ id, confirmed: true })}>
          Allow
        </button>
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
  onRespond: (r: ExtensionUIResponsePayload) => void;
}

function SelectPrompt({ id, title, options, timeout, onRespond }: SelectPromptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const remaining = useCountdown(timeout);

  useEffect(() => { containerRef.current?.focus(); }, []);

  useEffect(() => {
    if (remaining === 0) {
      onRespond({ id, cancelled: true });
    }
  }, [remaining, id, onRespond]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onRespond({ id, cancelled: true }); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [id, onRespond]);

  return (
    <div ref={containerRef} class="extension-ui-prompt" tabIndex={-1} role="dialog" aria-label={title}>
      <div class="extension-ui-prompt-header">
        <span class="extension-ui-prompt-icon">?</span>
        <span class="extension-ui-prompt-title">{title}</span>
        {remaining !== null && <span class="extension-ui-prompt-countdown">{remaining}s</span>}
      </div>
      <div class="extension-ui-prompt-options">
        {options.map((option) => (
          <button
            key={option}
            class="extension-ui-prompt-option"
            type="button"
            onClick={() => onRespond({ id, value: option })}
          >
            {option}
          </button>
        ))}
      </div>
      <div class="extension-ui-prompt-actions">
        <button class="action-btn secondary" type="button" onClick={() => onRespond({ id, cancelled: true })}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Input ───────────────────────────────────────────────────────────────────

interface InputPromptProps {
  id: string;
  title: string;
  placeholder?: string;
  timeout?: number;
  onRespond: (r: ExtensionUIResponsePayload) => void;
}

function InputPrompt({ id, title, placeholder, timeout, onRespond }: InputPromptProps) {
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
    <div class="extension-ui-prompt" role="dialog" aria-label={title}>
      <div class="extension-ui-prompt-header">
        <span class="extension-ui-prompt-icon">?</span>
        <span class="extension-ui-prompt-title">{title}</span>
        {remaining !== null && <span class="extension-ui-prompt-countdown">{remaining}s</span>}
      </div>
      <div class="extension-ui-prompt-input-row">
        <input
          ref={inputRef}
          class="extension-ui-prompt-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div class="extension-ui-prompt-actions">
        <button class="action-btn secondary" type="button" onClick={() => onRespond({ id, cancelled: true })}>
          Cancel
        </button>
        <button
          class="action-btn primary"
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
