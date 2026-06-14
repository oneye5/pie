/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

interface InlineEditorProps {
  initialText: string;
  /** Captured height of the message body before entering edit mode. */
  capturedHeight: number | null;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}

export function InlineEditor({ initialText, capturedHeight, onConfirm, onCancel }: InlineEditorProps) {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoSize = useCallback((el: HTMLTextAreaElement) => {
    // Fallback for browsers without field-sizing:content
    if (!CSS.supports('field-sizing', 'content')) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    }
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autoSize(el);
  }, [autoSize]);

  const handleInput = useCallback((e: Event) => {
    const el = e.target as HTMLTextAreaElement;
    setText(el.value);
    autoSize(el);
  }, [autoSize]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim()) onConfirm(text);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  }, [text, onConfirm, onCancel]);

  // min-height locks the container to prevent scroll shift
  const containerStyle = capturedHeight != null
    ? `min-height:${capturedHeight}px;position:relative`
    : 'position:relative';

  return (
    <div class="inline-editor-wrapper">
      <div class="inline-editor" style={containerStyle}>
        <textarea
          ref={textareaRef}
          class="inline-editor-textarea"
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          aria-label="Edit message"
          placeholder="Edit message…"
        />
        <div class="inline-editor-actions">
          <button class="action-btn secondary" type="button" onClick={onCancel}>Cancel</button>
          <button
            class="action-btn primary"
            type="button"
            disabled={!text.trim()}
            onClick={() => { if (text.trim()) onConfirm(text); }}
          >Save</button>
        </div>
      </div>
    </div>
  );
}
