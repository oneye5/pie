/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

import type {
  ChatMessage,
  ChatPrefs,
  ContextWindowUsage,
  ModelInfo,
  ModelSettings,
  SessionSummary,
  SystemPromptEntry,
  ThinkingLevel,
} from '../../shared/protocol';
import { buildContextWindowBreakdown } from './context-window-breakdown';

// ─── SessionTabs ─────────────────────────────────────────────────────────────

interface SessionTabsProps {
  sessions: SessionSummary[];
  openTabPaths: string[];
  runningSessionPaths: string[];
  activeSession: SessionSummary | null;
  backendReady: boolean;
  statusLabel: string;
  statusClass: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onNew: () => void;
}

export function SessionTabs({
  sessions,
  openTabPaths,
  runningSessionPaths,
  activeSession,
  backendReady,
  statusLabel,
  statusClass,
  onSelect,
  onClose,
  onNew,
}: SessionTabsProps) {
  const sessionByPath = new Map(sessions.map((s) => [s.path, s]));

  return (
    <div class="session-tabs">
      <div class="session-tabs-strip" role="tablist" aria-label="Sessions">
        {openTabPaths.map((tabPath) => {
          const session = sessionByPath.get(tabPath);
          const label = session?.name ?? 'New Session';
          const isActive = activeSession?.path === tabPath;
          const isRunning = runningSessionPaths.includes(tabPath);

          return (
            <div key={tabPath} class={`session-tab${isActive ? ' active' : ''}`}>
              <button
                class="session-tab-main"
                type="button"
                role="tab"
                aria-selected={isActive}
                title={label}
                onClick={() => onSelect(tabPath)}
              >
                {isRunning && <span class="session-tab-running" aria-hidden="true" />}
                <span class="session-tab-label">{label}</span>
              </button>
              <button
                class="session-tab-close"
                type="button"
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                onClick={() => onClose(tabPath)}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          class="session-tabs-new"
          type="button"
          title="New session"
          onClick={onNew}
          aria-label="New session"
          disabled={!backendReady}
        >
          +
        </button>
      </div>
      <span class={`panel-status ${statusClass}`}>{statusLabel}</span>
    </div>
  );
}

// ─── Composer ────────────────────────────────────────────────────────────────

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
};

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${trimDecimal(tokens / 1_000_000)}M`;
  }
  if (tokens >= 1_000) {
    return `${trimDecimal(tokens / 1_000)}k`;
  }
  return String(tokens);
}

function formatReadableTokens(tokens: number): string {
  return new Intl.NumberFormat('en-US').format(tokens);
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

interface ComposerProps {
  busy: boolean;
  draftRestore?: { text: string; nonce: number } | null;
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
  contextUsage: ContextWindowUsage | null;
  systemPrompts: SystemPromptEntry[];
  transcript: ChatMessage[];
  pendingPaths: string[];
  focusTrigger?: string;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onOpenFilePicker: () => void;
  onRemovePath: (path: string) => void;
  onModelChange: (model: string, thinkingLevel: ThinkingLevel) => void;
}

export function Composer({
  busy,
  draftRestore,
  modelSettings,
  availableModels,
  contextUsage,
  systemPrompts,
  transcript,
  pendingPaths,
  focusTrigger,
  onSend,
  onInterrupt,
  onOpenFilePicker,
  onRemovePath,
  onModelChange,
}: ComposerProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusTrigger !== undefined) {
      textareaRef.current?.focus();
    }
  }, [focusTrigger]);

  useEffect(() => {
    if (!draftRestore) {
      return;
    }

    setText(draftRestore.text);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.value = draftRestore.text;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
      textarea.focus();
    }
  }, [draftRestore?.nonce]);

  const resetComposer = useCallback(() => {
    setText('');
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
    }
  }, []);

  const sendCurrentText = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onSend(trimmed);
    resetComposer();
  }, [busy, onSend, resetComposer, text]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrentText();
      }
    },
    [sendCurrentText],
  );

  const handleInput = useCallback((e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    setText(target.value);
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
  }, []);

  const selectedModel = modelSettings?.defaultModel ?? '';
  const selectedLevel = modelSettings?.defaultThinkingLevel ?? 'medium';
  const selectedModelInfo = availableModels.find((m) => m.id === selectedModel);
  const supportsReasoning = selectedModelInfo?.reasoning ?? false;
  const attachmentCountLabel = `${pendingPaths.length} file${pendingPaths.length === 1 ? '' : 's'} attached`;
  const effectiveContextWindow = contextUsage?.contextWindow ?? selectedModelInfo?.contextWindow ?? 0;
  const remainingContextTokens =
    effectiveContextWindow > 0 && contextUsage?.tokens !== null && contextUsage?.tokens !== undefined
      ? Math.max(effectiveContextWindow - contextUsage.tokens, 0)
      : null;
  const contextRatio =
    remainingContextTokens !== null && effectiveContextWindow > 0
      ? remainingContextTokens / effectiveContextWindow
      : null;
  const contextIndicatorClass =
    contextRatio !== null && contextRatio < 0.15
      ? ' critical'
      : contextRatio !== null && contextRatio < 0.3
        ? ' warning'
        : '';
  const contextIndicatorLabel =
    effectiveContextWindow <= 0
      ? null
      : remainingContextTokens === null
        ? `? left / ${formatCompactTokens(effectiveContextWindow)}`
        : `${formatCompactTokens(remainingContextTokens)} left / ${formatCompactTokens(effectiveContextWindow)}`;
  const contextBreakdown =
    effectiveContextWindow <= 0
      ? null
      : buildContextWindowBreakdown({
          contextUsage,
          effectiveContextWindow,
          systemPrompts,
          transcript,
        });
  const contextIndicatorAriaLabel =
    effectiveContextWindow <= 0
      ? ''
      : remainingContextTokens === null
        ? `Remaining context window is unknown. Total window: ${formatReadableTokens(effectiveContextWindow)} tokens.`
        : `${formatReadableTokens(remainingContextTokens)} tokens left out of ${formatReadableTokens(effectiveContextWindow)}.`;

  return (
    <div class="composer-area">
      <div class="composer-toolbar">
        {availableModels.length > 0 ? (
          <select
            class="model-select"
            value={selectedModel}
            onChange={(e) => {
              const target = e.target as HTMLSelectElement;
              onModelChange(target.value, selectedLevel);
            }}
            aria-label="Model"
            title="Select model"
          >
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        ) : selectedModel ? (
          <span class="model-select-static" title={selectedModel}>{selectedModel}</span>
        ) : null}

        {supportsReasoning && (
          <select
            class="model-select model-select-sm"
            value={selectedLevel}
            onChange={(e) => {
              const target = e.target as HTMLSelectElement;
              onModelChange(selectedModel, target.value as ThinkingLevel);
            }}
            aria-label="Reasoning level"
            title="Reasoning level"
          >
            {(Object.keys(THINKING_LEVEL_LABELS) as ThinkingLevel[]).map((level) => (
              <option key={level} value={level}>{THINKING_LEVEL_LABELS[level]}</option>
            ))}
          </select>
        )}

        {contextIndicatorLabel && contextBreakdown && (
          <div class="context-window-indicator-anchor">
            <span
              class={`model-select-static context-window-indicator${contextIndicatorClass}`}
              aria-label={`Remaining context window. ${contextIndicatorAriaLabel}`}
              aria-description={contextBreakdown.title}
              title={contextBreakdown.title}
            >
              {contextIndicatorLabel}
            </span>
          </div>
        )}
      </div>

      {pendingPaths.length > 0 && (
        <div class="composer-attachments">
          <span class="composer-section-label">Attached</span>
          {pendingPaths.map((p) => (
            <span key={p} class="attachment-chip" title={p}>
              <span class="attachment-chip-name">{p.split(/[\\/]/).pop()}</span>
              <button
                class="attachment-chip-remove"
                type="button"
                onClick={() => onRemovePath(p)}
                aria-label={`Remove ${p}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div class="composer-input-shell">
        <textarea
          ref={textareaRef}
          class="composer-textarea"
          rows={1}
          placeholder={busy ? 'Waiting for a response...' : 'Ask PI anything...'}
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          aria-label="Message composer"
        />
        <div class="composer-actions">
          <button
            class="action-btn icon-only"
            type="button"
            title="Attach file"
            onClick={onOpenFilePicker}
            aria-label="Attach file"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          {busy ? (
            <button
              class="action-btn danger"
              type="button"
              title="Interrupt"
              onClick={onInterrupt}
              aria-label="Interrupt response"
            >
              Stop
            </button>
          ) : (
            <button
              class="action-btn primary"
              type="button"
              title="Send (Enter)"
              onClick={sendCurrentText}
              disabled={!text.trim()}
              aria-label="Send message"
            >
              Send
            </button>
          )}
        </div>
      </div>
      </div>
  );
}
