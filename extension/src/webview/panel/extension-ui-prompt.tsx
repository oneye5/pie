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
          timeout={request.timeout}
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
          timeout={request.timeout}
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
          timeout={request.timeout}
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); onRespond({ id, confirmed: true }); }
      if (e.key === 'Escape') { e.preventDefault(); onRespond({ id, confirmed: false }); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [id, onRespond]);

  const dismiss = useCallback(() => onRespond({ id, confirmed: false }), [id, onRespond]);

  return (
      <div ref={containerRef} class="extension-ui-prompt" tabIndex={-1} role="alertdialog" aria-label={title}>
        {extensionId && <div class="extension-ui-prompt-extension-label">{extensionId}</div>}
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onRespond({ id, cancelled: true }); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
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
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onRespond({ id, cancelled: true });
    }
  }, [id, customValue, onRespond]);

  const dismiss = useCallback(() => onRespond({ id, cancelled: true }), [id, onRespond]);

  const allOptions = [...options, CUSTOM_SENTINEL];

  return (
      <div ref={containerRef} class="extension-ui-prompt" tabIndex={-1} role="dialog" aria-label={title}>
        {extensionId && <div class="extension-ui-prompt-extension-label">{extensionId}</div>}
        <div class="extension-ui-prompt-header">
          <span class="extension-ui-prompt-icon">?</span>
          <span class="extension-ui-prompt-title">{title}</span>
          {remaining !== null && <span class="extension-ui-prompt-countdown">{remaining}s</span>}
        </div>
        <div class="extension-ui-prompt-options">
          {allOptions.map((option) =>
            option === CUSTOM_SENTINEL ? (
              <button
                key={option}
                class="extension-ui-prompt-option custom-sentinel"
                type="button"
                onClick={() => setShowCustomInput(true)}
              >
                {option}
              </button>
            ) : (
              <button
                key={option}
                class="extension-ui-prompt-option"
                type="button"
                onClick={() => onRespond({ id, value: option })}
              >
                {option}
              </button>
            ),
          )}
        </div>
        {showCustomInput && (
          <div class="extension-ui-prompt-input-row">
            <input
              ref={customInputRef}
              class="extension-ui-prompt-input"
              type="text"
              value={customValue}
              placeholder="Type your answer…"
              onInput={(e) => setCustomValue((e.target as HTMLInputElement).value)}
              onKeyDown={handleCustomKeyDown}
            />
          </div>
        )}
        {showCustomInput && (
          <div class="extension-ui-prompt-actions">
            <button class="action-btn secondary" type="button" onClick={() => onRespond({ id, cancelled: true })}>
              Cancel
            </button>
            <button
              class="action-btn primary"
              type="button"
              disabled={!customValue.trim()}
              onClick={handleCustomSubmit}
            >
              Submit
            </button>
          </div>
        )}
        {!showCustomInput && (
          <div class="extension-ui-prompt-actions">
            <button class="action-btn secondary" type="button" onClick={() => onRespond({ id, cancelled: true })}>
              Cancel
            </button>
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

  const dismiss = useCallback(() => onRespond({ id, cancelled: true }), [id, onRespond]);

  return (
      <div class="extension-ui-prompt" role="dialog" aria-label={title}>
        {extensionId && <div class="extension-ui-prompt-extension-label">{extensionId}</div>}
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

// ─── Notify toast ────────────────────────────────────────────────────────────

export interface NotifyToastProps {
  message: string;
  notifyType?: 'info' | 'warning' | 'error';
  onClose: () => void;
}

/** Auto-dismissing toast for notify events. */
export function NotifyToast({ message, notifyType = 'info', onClose }: NotifyToastProps) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const dismiss = () => setExiting(true);
    const timer = setTimeout(dismiss, 5000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(onClose, 200);
    return () => clearTimeout(timer);
  }, [exiting, onClose]);

  const iconMap: Record<string, string> = { info: 'i', warning: '!', error: '×' };
  const icon = iconMap[notifyType] ?? 'i';

  return (
    <div
      class={`extension-ui-notify-toast ${notifyType}`}
      style={exiting ? { animation: 'notify-toast-exit 200ms ease-in forwards' } : undefined}
    >
      <span class="extension-ui-notify-toast-icon">{icon}</span>
      <span class="extension-ui-notify-toast-message">{message}</span>
      <button class="extension-ui-notify-toast-close" type="button" onClick={onClose}>×</button>
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