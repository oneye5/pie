/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';

import { CUSTOM_SENTINEL } from '../../../../shared/ask-user-sentinel';
import type { ExtensionUIResponsePayload, ToolCall, WebviewToHostMessage } from '../../../../shared/protocol';
import { AskUserContext } from '../../hooks/ask-user-context';
import { ToolCallCard } from '../tool-call-card';
import { getToolCallContextType } from '../../chat-prefs';
import { registerToolRenderer, type ToolRendererProps } from '../registry';
import type { TranscriptContextMenuHandler } from '../types';

// ─── Input type ──────────────────────────────────────────────────────────────

interface AskUserInput {
  question: string;
  options: string[];
  allowCustom?: boolean;
  context?: string;
}

function parseAskUserInput(input: unknown): AskUserInput | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.question !== 'string') return null;
  if (!Array.isArray(obj.options)) return null;
  if (!obj.options.every((o): o is string => typeof o === 'string')) return null;
  return {
    question: obj.question,
    options: obj.options as string[],
    allowCustom: typeof obj.allowCustom === 'boolean' ? obj.allowCustom : undefined,
    context: typeof obj.context === 'string' ? obj.context : undefined,
  };
}

// ─── Result type ──────────────────────────────────────────────────────────────

interface AskUserResult {
  answer: string;
  source: 'option' | 'custom' | 'cancelled';
  cancelled: boolean;
}

function parseAskUserResult(result: unknown): AskUserResult | null {
  if (!result || typeof result !== 'object') return null;
  const obj = result as Record<string, unknown>;
  // Also accept Content[] format: [{ type: 'text', text: '...' }]
  if (Array.isArray(obj.content)) {
    const textPart = (obj.content as Array<Record<string, unknown>>).find(
      (p) => p.type === 'text' && typeof p.text === 'string',
    );
    if (textPart && typeof obj.details === 'object' && obj.details !== null) {
      const details = obj.details as Record<string, unknown>;
      return {
        answer: typeof details.answer === 'string' ? details.answer : String(textPart.text),
        source: details.source === 'option' || details.source === 'custom' || details.source === 'cancelled'
          ? details.source : 'option',
        cancelled: details.cancelled === true,
      };
    }
  }
  if (typeof obj.answer === 'string') {
    return {
      answer: obj.answer,
      source: obj.source === 'option' || obj.source === 'custom' || obj.source === 'cancelled'
        ? obj.source : 'option',
      cancelled: obj.cancelled === true,
    };
  }
  return null;
}

// ─── Inline prompt for running ask_user ───────────────────────────────────────

function AskUserInlinePrompt({
  toolCall,
  parsedInput,
  request,
  sessionPath,
  postMessage,
  onContextMenu,
}: {
  toolCall: ToolCall;
  parsedInput: AskUserInput;
  request: { id: string; options?: string[] } | null;
  sessionPath: string | null;
  postMessage: (msg: WebviewToHostMessage) => void;
  onContextMenu: TranscriptContextMenuHandler;
}) {
  const [customValue, setCustomValue] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const customInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showCustomInput && customInputRef.current) {
      customInputRef.current.focus();
    }
  }, [showCustomInput]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const respond = useCallback((response: ExtensionUIResponsePayload) => {
    if (submitted) return;
    setSubmitted(true);
    postMessage({ type: 'extensionUiResponse', sessionPath, response } as WebviewToHostMessage);
  }, [submitted, sessionPath, postMessage]);

  // Use the matching request's options (which may include CUSTOM_SENTINEL),
  // but fall back to the parsed input's options if no request is matched yet.
  const displayOptions = request?.options
    ? request.options.filter((o) => o !== CUSTOM_SENTINEL)
    : parsedInput.options;

  const allowCustom = parsedInput.allowCustom !== false || displayOptions.length === 0;
  const contextText = parsedInput.context;

  const handleCustomSubmit = useCallback(() => {
    if (customValue.trim()) {
      respond({ id: request?.id ?? '', value: customValue.trim() });
    }
  }, [customValue, request, respond]);

  const handleCustomKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && customValue.trim()) {
      e.preventDefault();
      handleCustomSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      respond({ id: request?.id ?? '', cancelled: true });
    }
  }, [customValue, handleCustomSubmit, respond, request]);

  const contextType = getToolCallContextType('ask_user');
  const handleContextMenu = (e: MouseEvent) => onContextMenu(contextType, JSON.stringify(toolCall, null, 2), e);

  return (
    <div
      ref={containerRef}
      class="ask-user-prompt"
      tabIndex={-1}
      role="dialog"
      aria-label={parsedInput.question}
      onContextMenu={(e) => { e.preventDefault(); handleContextMenu(e as unknown as MouseEvent); }}
    >
      <div class="ask-user-header">
        <span class="ask-user-icon">?</span>
        <span class="ask-user-question">{parsedInput.question}</span>
      </div>
      {contextText && <div class="ask-user-context">{contextText}</div>}
      {!submitted && !showCustomInput && (
        <div class="ask-user-options">
          {displayOptions.map((option) => (
            <button
              key={option}
              class="ask-user-option"
              type="button"
              onClick={() => respond({ id: request?.id ?? '', value: option })}
            >
              {option}
            </button>
          ))}
          {allowCustom && (
            <button
              class="ask-user-option ask-user-option-custom"
              type="button"
              onClick={() => setShowCustomInput(true)}
            >
              ✎ Write my own answer…
            </button>
          )}
          <button
            class="ask-user-cancel"
            type="button"
            onClick={() => respond({ id: request?.id ?? '', cancelled: true })}
          >
            Cancel
          </button>
        </div>
      )}
      {!submitted && showCustomInput && (
        <div class="ask-user-custom-row">
          <input
            ref={customInputRef}
            class="ask-user-custom-input"
            type="text"
            value={customValue}
            placeholder="Type your answer…"
            onInput={(e) => setCustomValue((e.target as HTMLInputElement).value)}
            onKeyDown={handleCustomKeyDown}
          />
          <button
            class="ask-user-custom-submit"
            type="button"
            disabled={!customValue.trim()}
            onClick={handleCustomSubmit}
          >
            Submit
          </button>
          <button
            class="ask-user-cancel"
            type="button"
            onClick={() => respond({ id: request?.id ?? '', cancelled: true })}
          >
            Cancel
          </button>
        </div>
      )}
      {submitted && (
        <div class="ask-user-pending">Waiting for response…</div>
      )}
    </div>
  );
}

// ─── Completed ask_user display ───────────────────────────────────────────────

function AskUserCompleted({ toolCall, parsedInput, parsedResult, onContextMenu }: {
  toolCall: ToolCall;
  parsedInput: AskUserInput;
  parsedResult: AskUserResult | null;
  onContextMenu: TranscriptContextMenuHandler;
}) {
  const contextType = getToolCallContextType('ask_user');
  const handleContextMenu = (e: MouseEvent) => onContextMenu(contextType, JSON.stringify(toolCall, null, 2), e);

  return (
    <div
      class="ask-user-completed"
      onContextMenu={(e) => { e.preventDefault(); handleContextMenu(e as unknown as MouseEvent); }}
    >
      <div class="ask-user-header ask-user-header-completed">
        <span class="ask-user-icon ask-user-icon-completed">?</span>
        <span class="ask-user-question ask-user-question-completed">{parsedInput.question}</span>
      </div>
      {parsedResult && !parsedResult.cancelled && (
        <div class="ask-user-answer">
          <span class="ask-user-answer-label">Answer:</span>
          <span class="ask-user-answer-text">{parsedResult.answer}</span>
        </div>
      )}
      {parsedResult?.cancelled && (
        <div class="ask-user-cancelled">Cancelled</div>
      )}
      {!parsedResult && toolCall.result !== undefined && (
        <div class="ask-user-answer">
          <span class="ask-user-answer-label">Result:</span>
          <span class="ask-user-answer-text">{typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result)}</span>
        </div>
      )}
    </div>
  );
}

// ─── Main renderer ────────────────────────────────────────────────────────────

function renderAskUserTool({
  toolCall,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  renderToolCall,
}: ToolRendererProps) {
  const parsedInput = parseAskUserInput(toolCall.input);
  const askUserCtx = useContext(AskUserContext);
  const pendingRequest = askUserCtx.pendingRequest;
  const sessionPath = askUserCtx.sessionPath;
  const postMessage = askUserCtx.postMessage;

  // Running ask_user: show interactive prompt if we have a matching request
  if (toolCall.status === 'running' && parsedInput) {
    // Match the pending request to this tool call: the request must be a
    // 'select' method with an id (from the extension UI bridge).
    const matchingRequest =
      pendingRequest &&
      pendingRequest.method === 'select' &&
      pendingRequest.id
        ? pendingRequest
        : null;

    if (matchingRequest && sessionPath) {
      return (
        <AskUserInlinePrompt
          toolCall={toolCall}
          parsedInput={parsedInput}
          request={matchingRequest}
          sessionPath={sessionPath}
          postMessage={postMessage}
          onContextMenu={onContextMenu}
        />
      );
    }

    // No matching request yet — show the question with a "waiting" indicator
    // and a gentle nudge that the UI is loading. This handles the brief moment
    // before the extension_ui.request event reaches the webview.
    return (
      <div class="ask-user-prompt ask-user-prompt-loading">
        <div class="ask-user-header">
          <span class="ask-user-icon">?</span>
          <span class="ask-user-question">{parsedInput.question}</span>
        </div>
        {parsedInput.context && <div class="ask-user-context">{parsedInput.context}</div>}
        <div class="ask-user-pending">Loading response options…</div>
      </div>
    );
  }

  // Completed ask_user: show question + answer
  if ((toolCall.status === 'completed' || toolCall.status === 'failed') && parsedInput) {
    const parsedResult = typeof toolCall.result !== 'undefined' ? parseAskUserResult(toolCall.result) : null;
    return (
      <AskUserCompleted
        toolCall={toolCall}
        parsedInput={parsedInput}
        parsedResult={parsedResult}
        onContextMenu={onContextMenu}
      />
    );
  }

  // Fallback: render as a generic tool call card
  return (
    <ToolCallCard
      toolCall={toolCall}
      autoExpand={prefs.autoExpandToolCalls}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={(e) => onContextMenu(getToolCallContextType('ask_user'), JSON.stringify(toolCall, null, 2), e)}
    />
  );
}

// Register the renderer
registerToolRenderer('ask_user', renderAskUserTool);