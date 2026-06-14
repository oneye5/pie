/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';

import type { ChatMessage, ChatPrefs } from '../../../shared/protocol';
import type { PruningHeaderState } from './pruning';
import type { TurnActivityState } from './activity';
import type { RenderToolCall, TranscriptContextMenuHandler } from './types';
import { useCaptureHeight, useMessageItemDerived, useMessageParts } from './message-item/hooks';
import { MessageItemInner, MessageItemShell } from './message-item/inner';

export { ReasoningBlock } from './message-item/reasoning-block';

interface MessageItemProps {
  message: ChatMessage;
  isStreaming: boolean;
  prefs: ChatPrefs;
  readonly?: boolean;
  workingDirectory: string | null;
  editingId: string | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
  isLastAssistantMessage?: boolean;
  /** Pruning diagnostics folded into this assistant turn's header, when present. */
  pruningHeaderState?: PruningHeaderState;
  /** Structured in-flight activity for the current turn (last assistant row only). */
  activityState?: TurnActivityState | null;
  /** Full transcript window, used to locate the previous user prompt for recovery. */
  transcript?: ChatMessage[];
  /** Index of this message within the transcript window. */
  transcriptIndex?: number;
  /** Whether older messages exist outside the loaded window. */
  hasOlder?: boolean;
}

export function MessageItemView({
  message,
  isStreaming,
  prefs,
  readonly,
  workingDirectory: _workingDirectory,
  editingId,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile: _onOpenFile,
  onContextMenu,
  renderToolCall,
  isLastAssistantMessage,
  pruningHeaderState,
  activityState,
  transcript,
  transcriptIndex,
  hasOlder,
}: MessageItemProps) {

  const {
    combinedParts,
    combinedMarkdown,
    renderableUserParts,
    hasUserImages,
    combinedThinking,
    combinedToolCalls,
  } = useMessageParts(message);

  const [pruningExpanded, setPruningExpanded] = useState(false);
  const [pruningRawExpanded, setPruningRawExpanded] = useState(false);

  const { messageBodyRef, capturedHeight } = useCaptureHeight(message.role);

  const derived = useMessageItemDerived({
    message,
    isStreaming,
    isLastAssistantMessage,
    activityState,
    editingId,
    readonly,
    hasUserImages,
    transcript,
    transcriptIndex,
    hasOlder,
    combinedParts,
    combinedMarkdown,
    combinedThinking,
    combinedToolCalls,
    onEditRequest,
  });

  return (
    <MessageItemShell
      messageId={message.id}
      role={message.role}
      isCurrentlyStreaming={derived.isCurrentlyStreaming}
      isClickableUserMsg={derived.isClickableUserMsg}
      isEditing={derived.isEditing}
      handleMessageClick={derived.handleMessageClick}
    >
      <MessageItemInner
        message={message}
        isEditing={derived.isEditing}
        isCurrentlyStreaming={derived.isCurrentlyStreaming}
        capturedHeight={capturedHeight}
        pruningHeaderState={pruningHeaderState}
        pruningExpanded={pruningExpanded}
        setPruningExpanded={setPruningExpanded}
        pruningRawExpanded={pruningRawExpanded}
        setPruningRawExpanded={setPruningRawExpanded}
        statusLabel={derived.statusLabel}
        statusTone={derived.statusTone}
        replyMeta={derived.replyMeta}
        assistantMetaTooltip={derived.assistantMetaTooltip}
        html={derived.html}
        getMessageRaw={derived.getMessageRaw}
        combinedParts={combinedParts}
        renderableUserParts={renderableUserParts}
        prefs={prefs}
        renderToolCall={renderToolCall}
        onContextMenu={onContextMenu}
        messageBodyRef={messageBodyRef}
        hasActivityFooter={derived.hasActivityFooter}
        footerActivityState={derived.footerActivityState}
        recovery={derived.recovery}
        onEditRequest={onEditRequest}
        onEditConfirm={onEditConfirm}
        onEditCancel={onEditCancel}
      />
    </MessageItemShell>
  );
}

export const MessageItem = memo(MessageItemView);
