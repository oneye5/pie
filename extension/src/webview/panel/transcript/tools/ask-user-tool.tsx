/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useContext } from 'preact/hooks';

import type { ToolCall } from '../../../../shared/protocol';
import { AskUserContext, findMatchingRequest } from '../../hooks/ask-user-context';
import { SubagentCallContext } from '../subagent-call-context';
import { ToolCallCard } from '../tool-call-card';
import { getToolCallContextType } from '../../chat-prefs';
import { ExtensionUIPrompt } from '../../extension-ui-prompt';
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
  renderToolCall: _renderToolCall,
}: ToolRendererProps) {
  const parsedInput = parseAskUserInput(toolCall.input);
  const askUserCtx = useContext(AskUserContext);
  const subagentCallId = useContext(SubagentCallContext);
  const matchingRequest = findMatchingRequest(askUserCtx.pendingRequests, subagentCallId);
  const sessionPath = askUserCtx.sessionPath;
  const postMessage = askUserCtx.postMessage;

  // Running ask_user: show interactive prompt if we have a matching request
  if (toolCall.status === 'running') {
    if (matchingRequest && sessionPath) {
      return (
        <div onContextMenu={(e) => { e.preventDefault(); onContextMenu(getToolCallContextType('ask_user'), JSON.stringify(toolCall, null, 2), e as unknown as MouseEvent); }}>
          <ExtensionUIPrompt
            sessionPath={sessionPath}
            request={matchingRequest}
            postMessage={postMessage}
          />
        </div>
      );
    }

    // No matching request yet — show the question with a "waiting" indicator
    // and a gentle nudge that the UI is loading. This handles the brief moment
    // before the extension_ui.request event reaches the webview.
    if (parsedInput) {
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

    return (
      <div class="ask-user-prompt ask-user-prompt-loading">
        <div class="ask-user-header">
          <span class="ask-user-icon">?</span>
          <span class="ask-user-question">Loading prompt…</span>
        </div>
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