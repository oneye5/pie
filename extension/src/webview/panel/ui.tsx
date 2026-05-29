/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type {
  ActiveRunSummary,
  ChatMessage,
  ChatPrefs,
  ComposerInput,
  ComposerInputDraft,
  ContextWindowUsage,
  ExtensionInfo,
  ModelInfo,
  ModelSettings,
  PruningCatalog,
  PruningResult,
  PruningSettings,
  SystemPromptEntry,
  ThinkingLevel,
  TranscriptWindow,
} from '../../shared/protocol';
import type { TurnActivityState } from './transcript/activity';
import { buildContextWindowBreakdown } from './context-window/breakdown';
import { buildContextWindowIndicatorState } from './context-window/indicator';
import { buildSessionTokenIndicator, buildSessionTokenUsage, type TokenRateState } from './session-tabs/token-usage';
import { shouldHandleGlobalComposerPaste } from './composer/affordances';
import { describeComposerInputSummary } from './composer/inputs';
import { resolveComposerModelState } from './composer/model-state';
import {
  canAcceptComposerTransfer,
  extractComposerInputs,
  formatComposerTransferError,
  hasClipboardFilePayload,
} from './file-drop';
import { ComposerAttachments } from './composer/attachments';
import { ComposerToolbar } from './composer/toolbar';
import { getComposerRunControls } from './session-tabs/run-state';
export { SessionTabs } from './session-tabs';

const COMPOSER_TEXTAREA_MAX_HEIGHT = 200;

/**
 * Build the busy-state composer placeholder from the current turn activity.
 * Falls back to a generic waiting message when no structured phase is known.
 */
function composerBusyPlaceholder(activityState?: TurnActivityState | null): string {
  if (!activityState) {
    return 'Waiting for a response...';
  }
  const detail = activityState.detail ? ` (${activityState.detail})` : '';
  return `Agent is ${activityState.label}${detail}…`;
}

function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT)}px`;
}

interface ComposerProps {
  busy: boolean;
  draftRestore?: { text: string; nonce: number } | null;
  activeModelId?: string;
  activeThinkingLevel?: ThinkingLevel;
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
  availableExtensions: ExtensionInfo[];
  contextUsage: ContextWindowUsage | null;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pruningCatalog: PruningCatalog;
  pruningResult: PruningResult | null;
  systemPrompts: SystemPromptEntry[];
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  pendingComposerInputs: ComposerInput[];
  activeRunSummary?: ActiveRunSummary | null;
  focusTrigger?: string;
  tokenRate: TokenRateState | null;
  activityState?: TurnActivityState | null;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onOpenFilePicker: () => void;
  onAddInput: (input: ComposerInputDraft) => void;
  onRemoveInput: (inputId: string) => void;
  onModelChange: (model: string, thinkingLevel: ThinkingLevel) => void;
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  onSetPruningSettings: (settings: Partial<PruningSettings>) => void;
  onMarkComplete?: () => void;
}

function ComposerView({
  busy,
  draftRestore,
  activeModelId,
  activeThinkingLevel,
  modelSettings,
  availableModels,
  availableExtensions,
  contextUsage,
  prefs,
  pruningSettings,
  pruningCatalog,
  pruningResult,
  systemPrompts,
  transcript,
  transcriptWindow,
  pendingComposerInputs,
  activeRunSummary,
  focusTrigger,
  tokenRate,
  activityState,
  onSend,
  onInterrupt,
  onOpenFilePicker,
  onAddInput,
  onRemoveInput,
  onModelChange,
  onSetPrefs,
  onSetPruningSettings,
  onMarkComplete,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [isDragActive, setIsDragActive] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const composerAreaRef = useRef<HTMLDivElement>(null);

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
      resizeComposerTextarea(textarea);
      textarea.focus();
    }
  }, [draftRestore?.nonce]);

  const resetComposer = useCallback(() => {
    setText('');
    setAttachmentError(null);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
    }
  }, []);

  const {
    selectedModel,
    selectedLevel,
    selectedModelInfo,
    supportsReasoning,
  } = useMemo(() => resolveComposerModelState({
    activeModelId,
    activeThinkingLevel,
    modelSettings,
    availableModels,
  }), [activeModelId, activeThinkingLevel, availableModels, modelSettings]);
  const supportsImageInputs = selectedModelInfo?.inputKinds.includes('image') ?? false;
  const runControls = getComposerRunControls(activeRunSummary ?? null);
  const hasUserMessages = transcriptWindow.hasUserMessages;
  const completionAction = runControls.action;

  const applyComposerTransfer = useCallback(async (dataTransfer: DataTransfer | null, source: 'drop' | 'paste') => {
    const { inputs, unsupportedInputs, rejectedFiles } = await extractComposerInputs(dataTransfer, source);
    const acceptedInputs = supportsImageInputs
      ? inputs
      : inputs.filter((input) => input.kind !== 'imageBlob');
    const blockedImageCount = supportsImageInputs
      ? 0
      : inputs.filter((input) => input.kind === 'imageBlob').length;

    for (const input of acceptedInputs) {
      onAddInput(input);
    }
    for (const unsupportedInput of unsupportedInputs) {
      onAddInput(unsupportedInput);
    }

    const unsupportedFileMessage = formatComposerTransferError(rejectedFiles);
    const blockedImageMessage = blockedImageCount > 0
      ? 'The selected model does not support image inputs. Switch to an image-capable model to paste or drop images.'
      : null;
    setAttachmentError([blockedImageMessage, unsupportedFileMessage].filter(Boolean).join(' ') || null);
  }, [onAddInput, supportsImageInputs]);

  const sendCurrentText = useCallback(() => {
    const trimmed = text.trim();
    if ((trimmed.length === 0 && pendingComposerInputs.length === 0) || busy) return;
    onSend(trimmed);
    resetComposer();
  }, [busy, onSend, pendingComposerInputs.length, resetComposer, text]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) {
        return;
      }

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
    resizeComposerTextarea(target);
  }, []);

  const handlePaste = useCallback((event: ClipboardEvent) => {
    const dataTransfer = event.clipboardData;
    if (!hasClipboardFilePayload(dataTransfer)) {
      return;
    }

    event.preventDefault();
    void applyComposerTransfer(dataTransfer, 'paste');
  }, [applyComposerTransfer]);

  useEffect(() => {
    const handleDocumentPaste = (event: ClipboardEvent) => {
      if (!shouldHandleGlobalComposerPaste(event.target)) {
        return;
      }

      const dataTransfer = event.clipboardData;
      if (!hasClipboardFilePayload(dataTransfer)) {
        return;
      }

      event.preventDefault();
      textareaRef.current?.focus();
      void applyComposerTransfer(dataTransfer, 'paste');
    };

    document.addEventListener('paste', handleDocumentPaste);
    return () => document.removeEventListener('paste', handleDocumentPaste);
  }, [applyComposerTransfer]);

  const handleDragOver = useCallback((event: DragEvent) => {
    if (!canAcceptComposerTransfer(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && composerShellRef.current?.contains(nextTarget)) {
      return;
    }
    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent) => {
    if (!canAcceptComposerTransfer(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setIsDragActive(false);
    void applyComposerTransfer(event.dataTransfer, 'drop');
  }, [applyComposerTransfer]);

  // Keep a CSS variable updated with the composer area's height so the
  // jump-to-latest button can be positioned above the composer without
  // overlapping it. We set the variable on document.documentElement so the
  // fixed-position button can read it.
  useEffect(() => {
    const el = composerAreaRef.current;
    if (!el) return;

    const update = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      try {
        document.documentElement.style.setProperty('--composer-height', `${height}px`);
      } catch {
        // ignore
      }
    };

    update();

    // Use ResizeObserver to respond to textarea growth and other layout changes.
    const ro = new (window as any).ResizeObserver(() => update());
    ro.observe(el);
    window.addEventListener('resize', update, { passive: true });

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const effectiveContextWindow = contextUsage?.contextWindow ?? selectedModelInfo?.contextWindow ?? 0;
  const contextBreakdown = useMemo(() => (
    effectiveContextWindow <= 0
      ? null
      : buildContextWindowBreakdown({
          contextUsage,
          effectiveContextWindow,
          systemPrompts,
          transcript,
          isPartial: transcriptWindow.isPartial,
        })
  ), [contextUsage, effectiveContextWindow, systemPrompts, transcript, transcriptWindow.isPartial]);
  const contextIndicator = useMemo(() => (
    contextBreakdown
      ? buildContextWindowIndicatorState(contextBreakdown.summary)
      : null
  ), [contextBreakdown]);
  const sessionTokenUsage = useMemo(() => buildSessionTokenUsage(transcript), [transcript]);
  const sessionTokenIndicator = useMemo(
    () => buildSessionTokenIndicator(sessionTokenUsage, tokenRate),
    [sessionTokenUsage, tokenRate],
  );
  const canSend = text.trim().length > 0 || pendingComposerInputs.length > 0;
  const attachmentSummary = useMemo(
    () => describeComposerInputSummary(pendingComposerInputs),
    [pendingComposerInputs],
  );
  const showAttachmentSummary = pendingComposerInputs.length > 1;
  const composerPlaceholder = busy
    ? composerBusyPlaceholder(activityState)
    : 'Ask PI anything...';

  return (
    <div class="composer-area" ref={composerAreaRef}>
      <ComposerToolbar
        prefs={prefs}
        pruningSettings={pruningSettings}
        pruningCatalog={pruningCatalog}
        pruningResult={pruningResult}
        onSetPrefs={onSetPrefs}
        onSetPruningSettings={onSetPruningSettings}
        availableExtensions={availableExtensions}
        availableModels={availableModels}
        selectedModel={selectedModel}
        selectedLevel={selectedLevel}
        supportsReasoning={supportsReasoning}
        contextIndicator={contextIndicator
          ? {
              label: contextIndicator.label,
              ariaLabel: contextIndicator.ariaLabel,
              severity: contextIndicator.severity ?? null,
            }
          : null}
        contextBreakdownTitle={contextBreakdown?.title ?? null}
        sessionTokenIndicator={{
              label: sessionTokenIndicator.label,
              rateLabel: sessionTokenIndicator.rateLabel,
              ariaLabel: sessionTokenIndicator.ariaLabel,
              tooltip: sessionTokenIndicator.tooltip,
            }}
        runStatus={runControls.status}
        onModelChange={onModelChange}
      />

      <div
        ref={composerShellRef}
        class={`composer-input-shell${isDragActive ? ' drag-active' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ComposerAttachments
          pendingComposerInputs={pendingComposerInputs}
          attachmentSummary={attachmentSummary}
          showAttachmentSummary={showAttachmentSummary}
          onRemoveInput={onRemoveInput}
        />
        <textarea
          ref={textareaRef}
          class="composer-textarea"
          rows={1}
          placeholder={composerPlaceholder}
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-label="Message composer"
        />
        <div class="composer-actions">
          <button
            class="action-btn icon-only"
            type="button"
            title="Attach file or folder path"
            onClick={onOpenFilePicker}
            aria-label="Attach file or folder path"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          {completionAction && (
            <button
              class={`composer-run-action ${completionAction.tone}`}
              type="button"
              title={completionAction.title}
              aria-label={completionAction.ariaLabel}
              disabled={busy || !hasUserMessages || !onMarkComplete}
              onClick={() => onMarkComplete?.()}
            >
              {completionAction.text}
            </button>
          )}
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
              disabled={!canSend}
              aria-label="Send message"
            >
              Send
            </button>
          )}
        </div>
      </div>

      {attachmentError && (
        <div class="composer-hint composer-hint-error" role="status">{attachmentError}</div>
      )}
    </div>
  );
}

export const Composer = memo(ComposerView);
