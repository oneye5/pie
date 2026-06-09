/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type {
  ChatMessage,
  ComposerInputDraft,
  ContextWindowUsage,
  ModelInfo,
  ModelSettings,
  PruningDetails,
  PruningResult,
  SystemPromptEntry,
  ThinkingLevel,
  TranscriptWindow,
} from '../../../shared/protocol';
import { buildContextWindowBreakdown } from '../context-window/breakdown';
import { buildContextWindowIndicatorState } from '../context-window/indicator';
import {
  buildLiveSessionCostEstimate,
  buildSessionCostIndicator,
  buildSessionTokenIndicator,
  buildSessionTokenUsage,
  type TokenPricing,
} from '../session-tabs/token-usage';
import { shouldHandleGlobalComposerPaste } from './affordances';
import { resolveComposerModelState } from './model-state';
import {
  canAcceptComposerTransfer,
  extractComposerInputs,
  formatComposerTransferError,
  hasClipboardFilePayload,
} from '../file-drop';

const COMPOSER_TEXTAREA_MAX_HEIGHT = 200;

export function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT)}px`;
}

export function useComposerIndicators({
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
}: {
  activeModelId?: string;
  activeThinkingLevel?: ThinkingLevel;
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
  contextUsage: ContextWindowUsage | null;
  systemPrompts: SystemPromptEntry[];
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  pruningResult: PruningResult | null;
  busy: boolean;
}) {
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

  const pricingByModelId = useMemo(() => {
    const map = new Map<string, TokenPricing>();
    for (const model of availableModels) {
      const pricing = model.subagent?.pricing;
      if (pricing) map.set(model.id, pricing);
    }
    return map;
  }, [availableModels]);

  const supportsImageInputs = selectedModelInfo?.inputKinds.includes('image') ?? false;

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
    () => buildSessionTokenIndicator(sessionTokenUsage),
    [sessionTokenUsage],
  );
  const liveCostEstimate = useMemo(
    () => buildLiveSessionCostEstimate(transcript, contextUsage, busy),
    [transcript, contextUsage, busy],
  );
  const sessionCostIndicator = useMemo(
    () => buildSessionCostIndicator(
      sessionTokenUsage,
      selectedModelInfo?.subagent?.pricing,
      selectedModelInfo?.name,
      transcript,
      (pruningResult?.details as PruningDetails | undefined),
      (modelId) => pricingByModelId.get(modelId),
      liveCostEstimate,
    ),
    [sessionTokenUsage, selectedModelInfo, transcript, pruningResult, pricingByModelId, liveCostEstimate],
  );

  return {
    selectedModel,
    selectedLevel,
    selectedModelInfo,
    supportsReasoning,
    supportsImageInputs,
    contextBreakdown,
    contextIndicator,
    sessionTokenIndicator,
    sessionCostIndicator,
  };
}

export function useComposerInput({
  busy,
  onSend,
  pendingComposerInputsLength,
  draftRestore,
  focusTrigger,
  onAddInput,
  supportsImageInputs,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  pendingComposerInputsLength: number;
  draftRestore?: { text: string; nonce: number } | null;
  focusTrigger?: string;
  onAddInput: (input: ComposerInputDraft) => void;
  supportsImageInputs: boolean;
}) {
  const [text, setText] = useState('');
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
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

  const sendCurrentText = useCallback(() => {
    const trimmed = text.trim();
    if ((trimmed.length === 0 && pendingComposerInputsLength === 0) || busy) return;
    onSend(trimmed);
    resetComposer();
  }, [busy, onSend, pendingComposerInputsLength, resetComposer, text]);

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

  const handlePaste = useCallback((event: ClipboardEvent) => {
    const dataTransfer = event.clipboardData;
    if (!hasClipboardFilePayload(dataTransfer)) {
      return;
    }

    event.preventDefault();
    void applyComposerTransfer(dataTransfer, 'paste');
  }, [applyComposerTransfer]);

  return {
    text,
    setText,
    textareaRef,
    attachmentError,
    sendCurrentText,
    handleKeyDown,
    handleInput,
    handlePaste,
    applyComposerTransfer,
  };
}

export function useComposerDragDrop({
  applyComposerTransfer,
}: {
  applyComposerTransfer: (dataTransfer: DataTransfer | null, source: 'drop' | 'paste') => Promise<void>;
}) {
  const [isDragActive, setIsDragActive] = useState(false);
  const composerShellRef = useRef<HTMLDivElement>(null);

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

  return {
    isDragActive,
    composerShellRef,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}

export function useComposerPaste({
  applyComposerTransfer,
  textareaRef,
}: {
  applyComposerTransfer: (dataTransfer: DataTransfer | null, source: 'drop' | 'paste') => Promise<void>;
  textareaRef: { current: HTMLTextAreaElement | null };
}) {
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
}

export function useComposerHeightSync(composerAreaRef: { current: HTMLDivElement | null }) {
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
}
