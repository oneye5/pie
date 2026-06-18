/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import type {
  ComposerInputDraft,
  WebviewToHostMessage,
} from '../../../shared/protocol';
import { shouldHandleGlobalComposerPaste } from './affordances';
import {
  canAcceptComposerTransfer,
  extractComposerInputs,
  formatComposerTransferError,
  hasClipboardFilePayload,
} from '../file-drop';

export { useComposerIndicators } from './use-composer-indicators';
export { useTokenRateIndicator, tickTokenRate, createTokenRateAccumulator } from './use-token-rate';
export type { TokenRateIndicatorState } from './use-token-rate';

const COMPOSER_TEXTAREA_MAX_HEIGHT = 200;

export function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT)}px`;
}

export function useComposerInput({
  busy,
  onSend,
  pendingComposerInputsLength,
  sessionPath,
  draftText,
  postMessage,
  draftRestore,
  focusTrigger,
  onAddInput,
  supportsImageInputs,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  pendingComposerInputsLength: number;
  sessionPath: string | null;
  draftText: string;
  postMessage: (msg: WebviewToHostMessage) => void;
  draftRestore?: { text: string; nonce: number } | null;
  focusTrigger?: string;
  onAddInput: (input: ComposerInputDraft) => void;
  supportsImageInputs: boolean;
}) {
  const [text, setText] = useState('');
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftPostTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (focusTrigger !== undefined) {
      textareaRef.current?.focus();
    }
  }, [focusTrigger]);

  // Seed the composer text from the host-persisted draft when the component
  // mounts or the active session changes. Host-backed draftText is the source
  // of truth across reloads and session switches.
  useEffect(() => {
    setText(draftText);
  }, [sessionPath]);

  // Debounce-post draft text back to the host so it survives reloads and
  // session switches. A 300 ms window coalesces rapid keystrokes.
  useEffect(() => {
    if (sessionPath === null) return;
    if (text === draftText) return;

    if (draftPostTimeoutRef.current) {
      clearTimeout(draftPostTimeoutRef.current);
    }
    draftPostTimeoutRef.current = setTimeout(() => {
      draftPostTimeoutRef.current = null;
      postMessage({ type: 'setComposerDraft', sessionPath, text });
    }, 300);

    return () => {
      if (draftPostTimeoutRef.current) {
        clearTimeout(draftPostTimeoutRef.current);
        draftPostTimeoutRef.current = null;
      }
    };
  }, [text, sessionPath, draftText, postMessage]);

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
