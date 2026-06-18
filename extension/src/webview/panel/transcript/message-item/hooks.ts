import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { ChatMessage } from '../../../../shared/protocol';
import { renderMarkdown } from '../../markdown';
import { assistantReplyMeta, formatAssistantMetaTooltip } from '../header';
import {
  assistantPartsFromMessage,
  getRenderableUserParts,
  messageHasUserImages,
  reasoningFromMessageParts,
  textFromMessageParts,
  toolCallsFromMessageParts,
} from '../parts';
import { shouldOpenUserMessageEditor } from '../interactions';
import { AGENT_ACTIVITY_LABELS, type TurnActivityState } from '../activity';
import type { StatusTone } from '../status-chip';
import { useRecovery } from './footer';

export function buildMessageRaw(
  message: ChatMessage,
  combinedMarkdown: string,
  combinedThinking: string,
  combinedToolCalls: ChatMessage['toolCalls'],
  combinedParts: ReturnType<typeof assistantPartsFromMessage>,
): string {
  return JSON.stringify({
    role: message.role,
    createdAt: message.createdAt,
    status: message.status,
    markdown: combinedMarkdown,
    ...(message.modelId ? { modelId: message.modelId } : {}),
    ...(message.thinkingLevel ? { thinkingLevel: message.thinkingLevel } : {}),
    ...(combinedThinking ? { thinking: combinedThinking } : {}),
    ...(combinedToolCalls?.length ? { toolCalls: combinedToolCalls } : {}),
    ...(combinedParts?.length ? { parts: combinedParts } : {}),
    ...(message.userParts?.length ? { userParts: message.userParts } : {}),
  }, null, 2);
}

export function useMessageParts(message: ChatMessage) {
  const combinedParts = useMemo(() => (
    message.role === 'assistant'
      ? assistantPartsFromMessage(message)
      : undefined
  ), [message]);
  const combinedMarkdown = useMemo(() => (
    message.role === 'assistant'
      ? textFromMessageParts(combinedParts)
      : message.markdown
  ), [combinedParts, message.markdown, message.role]);
  const renderableUserParts = useMemo(() => getRenderableUserParts(message), [message]);
  const hasUserImages = useMemo(() => messageHasUserImages(message), [message]);
  const combinedThinking = useMemo(() => (
    message.role === 'assistant'
      ? reasoningFromMessageParts(combinedParts) ?? ''
      : message.thinking ?? ''
  ), [combinedParts, message.role, message.thinking]);
  const combinedToolCalls = useMemo(() => (
    message.role === 'assistant'
      ? toolCallsFromMessageParts(combinedParts)
      : message.toolCalls
  ), [combinedParts, message.role, message.toolCalls]);

  return {
    combinedParts,
    combinedMarkdown,
    renderableUserParts,
    hasUserImages,
    combinedThinking,
    combinedToolCalls,
  };
}

export function useCaptureHeight(messageRole: ChatMessage['role']) {
  const messageBodyRef = useRef<HTMLDivElement>(null);
  const [capturedHeight, setCapturedHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = messageBodyRef.current;
    if (!el || messageRole !== 'user') return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setCapturedHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [messageRole]);
  return { messageBodyRef, capturedHeight };
}

export function useMessageItemDerived({
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
}: {
  message: ChatMessage;
  isStreaming: boolean;
  isLastAssistantMessage?: boolean;
  activityState?: TurnActivityState | null;
  editingId: string | null;
  readonly?: boolean;
  hasUserImages: boolean;
  transcript?: ChatMessage[];
  transcriptIndex?: number;
  hasOlder?: boolean;
  combinedParts: ReturnType<typeof assistantPartsFromMessage> | undefined;
  combinedMarkdown: string;
  combinedThinking: string;
  combinedToolCalls: ChatMessage['toolCalls'];
  onEditRequest: (messageId: string) => void;
}) {
  const isCurrentlyStreaming = isStreaming && message.status === 'streaming';
  const isEditing = editingId === message.id;

  const recovery = useRecovery(message, transcript, transcriptIndex, hasOlder);

  const statusLabel =
    message.status === 'interrupted' ? 'Interrupted'
    : message.status === 'error' ? 'Error'
    : null;
  const statusTone: StatusTone =
    message.status === 'interrupted' ? 'interrupted'
    : message.status === 'error' ? 'error'
    : 'neutral';
  const replyMeta = assistantReplyMeta(message);
  const assistantMetaTooltip = formatAssistantMetaTooltip(message);

  const html = useMemo(() => {
    // Assistant messages with structured parts render through BufferedTextPart /
    // AssistantParts, which parse markdown per-part. Parsing the combined text
    // here too would duplicate marked+DOMPurify work on every streaming delta
    // for a result that is never consumed (MessageContent routes to
    // AssistantParts when combinedParts exists). Skip the parse in that case.
    if (message.role === 'assistant' && combinedParts) return '';
    return renderMarkdown(combinedMarkdown);
  }, [message.role, combinedParts, combinedMarkdown]);
  const getMessageRaw = useCallback(
    () => buildMessageRaw(message, combinedMarkdown, combinedThinking, combinedToolCalls, combinedParts as ReturnType<typeof assistantPartsFromMessage>),
    [
      combinedMarkdown,
      combinedParts,
      combinedThinking,
      combinedToolCalls,
      message.createdAt,
      message.modelId,
      message.role,
      message.status,
      message.thinkingLevel,
      message.userParts,
    ],
  );

  const isClickableUserMsg = message.role === 'user'
    && !hasUserImages
    && !isEditing
    && !isCurrentlyStreaming
    && !readonly;
  const footerActivityState = activityState ?? (
    isLastAssistantMessage && message.role === 'assistant' && isCurrentlyStreaming
      ? {
        phase: 'streaming' as const,
        label: AGENT_ACTIVITY_LABELS.responding,
        tone: 'active' as const,
        ariaLabel: 'Agent is responding',
      }
      : null
  );
  const hasActivityFooter = isLastAssistantMessage && message.role === 'assistant' && !!footerActivityState;
  const handleMessageClick = isClickableUserMsg
    ? (event: MouseEvent) => {
        if (!shouldOpenUserMessageEditor(event.target)) {
          return;
        }
        onEditRequest(message.id);
      }
    : undefined;

  return {
    isCurrentlyStreaming,
    isEditing,
    recovery,
    statusLabel,
    statusTone,
    replyMeta,
    assistantMetaTooltip,
    html,
    getMessageRaw,
    isClickableUserMsg,
    footerActivityState,
    hasActivityFooter,
    handleMessageClick,
  };
}
