/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import { useMemo, useRef } from 'preact/hooks';

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
  PruningDetails,
  PruningResult,
  PruningSettings,
  SystemPromptEntry,
  ThinkingLevel,
  TranscriptWindow,
} from '../../shared/protocol';
import { describeComposerInputSummary } from './composer/inputs';
import { ComposerAttachments } from './composer/attachments';
import { ComposerToolbar } from './composer/toolbar';
import { getComposerRunControls } from './session-tabs/run-state';
import { cx } from './utils/cx';
import { ComposerActions } from './composer/actions';
import {
  useComposerIndicators,
  useComposerInput,
  useComposerDragDrop,
  useComposerPaste,
  useComposerHeightSync,
} from './composer/hooks';
export { SessionTabs } from './session-tabs';

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
  const composerAreaRef = useRef<HTMLDivElement>(null);

  const {
    selectedModel,
    selectedLevel,
    selectedModelInfo,
    supportsReasoning,
    supportsImageInputs,
    contextBreakdown,
    contextIndicator,
    sessionTokenIndicator,
    sessionCostIndicator,
  } = useComposerIndicators({
    activeModelId,
    activeThinkingLevel,
    modelSettings,
    availableModels,
    contextUsage,
    systemPrompts,
    transcript,
    transcriptWindow,
    pruningResult,
    busy,
  });

  const {
    text,
    textareaRef,
    attachmentError,
    sendCurrentText,
    handleKeyDown,
    handleInput,
    handlePaste,
    applyComposerTransfer,
  } = useComposerInput({
    busy,
    onSend,
    pendingComposerInputsLength: pendingComposerInputs.length,
    draftRestore,
    focusTrigger,
    onAddInput,
    supportsImageInputs,
  });

  const {
    isDragActive,
    composerShellRef,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useComposerDragDrop({ applyComposerTransfer });

  useComposerPaste({ applyComposerTransfer, textareaRef });
  useComposerHeightSync(composerAreaRef);

  const runControls = getComposerRunControls(activeRunSummary ?? null);
  const hasUserMessages = transcriptWindow.hasUserMessages;
  const completionAction = runControls.action;

  const canSend = text.trim().length > 0 || pendingComposerInputs.length > 0;
  const attachmentSummary = useMemo(
    () => describeComposerInputSummary(pendingComposerInputs),
    [pendingComposerInputs],
  );
  const showAttachmentSummary = pendingComposerInputs.length > 1;
  // Composer stays neutral; turn status is surfaced in the transcript activity strip.
  const composerPlaceholder = '';

  return (
    <div class="composer-area flex shrink-0 flex-col gap-1.5 border-t border-border/50 bg-surface px-3 py-2 pb-2.5" ref={composerAreaRef}>
      <div class="composer-rail flex flex-col gap-1.5">
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
              ariaLabel: sessionTokenIndicator.ariaLabel,
              tooltip: sessionTokenIndicator.tooltip,
            }}
        sessionCostIndicator={sessionCostIndicator}
        runStatus={runControls.status}
        onModelChange={onModelChange}
      />

      <div
        ref={composerShellRef}
        class={cx(
          'flex flex-col gap-1.5 rounded-xl border border-transparent bg-input px-2 py-1.5 pb-2 shadow-sm transition-[background,border-color,box-shadow] duration-150',
          'focus-within:border-border-subtle/80 focus-within:shadow-md',
          'forced-colors:border forced-colors:border-[ButtonText] forced-colors:focus-within:outline-1 forced-colors:focus-within:outline-[Highlight]',
          isDragActive && 'border-accent/40 bg-accent/5 shadow-md',
        )}
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
          class="max-h-[200px] min-h-10 w-full resize-none border-0 bg-transparent p-0 leading-normal text-foreground outline-none placeholder:text-muted/60"
          rows={1}
          placeholder={composerPlaceholder}
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-label="Message composer"
        />
        <ComposerActions
          busy={busy}
          hasUserMessages={hasUserMessages}
          completionAction={completionAction}
          onMarkComplete={onMarkComplete}
          onInterrupt={onInterrupt}
          sendCurrentText={sendCurrentText}
          canSend={canSend}
          onOpenFilePicker={onOpenFilePicker}
        />
      </div>

      {attachmentError && (
        <div class="composer-hint composer-hint-error" role="status">{attachmentError}</div>
      )}
      </div>
    </div>
  );
}

export const Composer = memo(ComposerView);
