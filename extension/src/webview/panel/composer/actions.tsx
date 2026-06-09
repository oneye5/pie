/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { getComposerRunControls } from '../session-tabs/run-state';

export interface ComposerActionsProps {
  busy: boolean;
  hasUserMessages: boolean;
  completionAction: ReturnType<typeof getComposerRunControls>['action'];
  onMarkComplete?: () => void;
  onInterrupt: () => void;
  sendCurrentText: () => void;
  canSend: boolean;
  onOpenFilePicker: () => void;
}

export function ComposerActions({
  busy,
  hasUserMessages,
  completionAction,
  onMarkComplete,
  onInterrupt,
  sendCurrentText,
  canSend,
  onOpenFilePicker,
}: ComposerActionsProps) {
  return (
    <div class="flex flex-wrap items-center justify-end gap-2">
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
  );
}
