/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { ChatMessage, ChatPrefs } from '../../../shared/protocol';
import { useNotice } from '../hooks/notice-context';
import { renderMarkdown, reasoningSummary } from '../markdown';
import {
  assistantReplyMeta,
  formatDuration,
  formatTimestamp,
  roleLabel,
} from './header';
import { InlineEditor } from './inline-editor';
import { shouldOpenUserMessageEditor } from './interactions';

import {
  assistantPartsFromMessage,
  getRenderableUserParts,
  messageHasUserImages,
  reasoningFromMessageParts,
  textFromMessageParts,
  toolCallsFromMessageParts,
  userImageSrc,
} from './parts';
import { BufferedTextPart } from './buffered-text-part';
import type { RenderToolCall, TranscriptContextMenuHandler } from './types';
import { useDisclosureOpen } from './use-disclosure-open';

interface ReasoningBlockProps {
  text: string;
  autoExpand: boolean;
  disclosureKey: string;
  onContextMenu: (e: MouseEvent) => void;
}

export function ReasoningBlock({ text, autoExpand, disclosureKey, onContextMenu }: ReasoningBlockProps) {
  const [open, setOpen] = useDisclosureOpen(disclosureKey, autoExpand);

  const html = useMemo(() => (open ? renderMarkdown(text) : ''), [open, text]);

  return (
    <div
      class={`thinking-block${open ? ' open' : ''}`}
      role="button"
      aria-expanded={open}
      tabIndex={0}
      onClick={() => setOpen((v) => !v)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
    >
      <div class="thinking-block-header">
        <svg class={`thinking-block-chevron${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="thinking-block-label">Reasoning</span>
        {!open && (
          <span class="thinking-block-summary">{reasoningSummary(text)}</span>
        )}
      </div>
      {open && (
        <div
          class="thinking-block-body message-body"
          dangerouslySetInnerHTML={{ __html: html }}
          aria-live="polite"
        />
      )}
    </div>
  );
}

// ─── Error Detail ────────────────────────────────────────────────────────────

const ERROR_TRUNCATE = 150;

function ErrorDetailWithFallback({ message }: { message: ChatMessage }) {
  const notice = useNotice();
  const detail = message.errorDetail || notice;
  if (!detail) return null;
  return <ErrorDetail detail={detail} />;
}

function ErrorDetail({ detail }: { detail: string }) {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const isLong = detail.length > ERROR_TRUNCATE;

  if (dismissed) return null;

  return (
    <div class="message-error-detail">
      <span class="message-error-detail-text">
        {isLong && !expanded ? detail.slice(0, ERROR_TRUNCATE) + '…' : detail}
      </span>
      <span class="message-error-detail-actions">
        {isLong && (
          <button class="message-error-detail-btn" onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Less' : 'More'}
          </button>
        )}
        <button class="message-error-detail-btn" onClick={() => setDismissed(true)} title="Dismiss">✕</button>
      </span>
    </div>
  );
}

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
}

function MessageItemView({
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
}: MessageItemProps) {

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
  const isCurrentlyStreaming = isStreaming && message.status === 'streaming';
  const isEditing = editingId === message.id;

  // Capture message body height for no-shift editing (Phase 5)
  const messageBodyRef = useRef<HTMLDivElement>(null);
  const [capturedHeight, setCapturedHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = messageBodyRef.current;
    if (!el || message.role !== 'user') return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setCapturedHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [message.role]);

  const createdAtLabel = formatTimestamp(message.createdAt);
  const statusLabel =
    message.status === 'interrupted' ? 'Interrupted'
    : message.status === 'error' ? 'Error'
    : null;
  const statusTone =
    message.status === 'interrupted' ? 'interrupted'
    : message.status === 'error' ? 'error'
    : '';
  const replyMeta = assistantReplyMeta(message);

  const html = useMemo(() => renderMarkdown(combinedMarkdown), [combinedMarkdown]);
  const getMessageRaw = useCallback(() => JSON.stringify({
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
  }, null, 2), [
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
  ]);

  const isClickableUserMsg = message.role === 'user'
    && !hasUserImages
    && !isEditing
    && !isCurrentlyStreaming
    && !readonly;
  const handleMessageClick = isClickableUserMsg
    ? (event: MouseEvent) => {
        if (!shouldOpenUserMessageEditor(event.target)) {
          return;
        }
        onEditRequest(message.id);
      }
    : undefined;

  return (
    <div
      class={`message role-${message.role}${isClickableUserMsg ? ' editable' : ''}${hasUserImages ? ' has-user-images' : ''}`}
      data-message-id={message.id}
      data-role={message.role}
      onClick={handleMessageClick}
      style={isClickableUserMsg ? { cursor: 'pointer' } : undefined}
      title={isClickableUserMsg ? 'Click to edit' : undefined}
    >
      <div class="message-head">
        <div class="message-head-main">
          {message.role !== 'user' && <span class="message-role">{roleLabel(message.role)}</span>}
          {createdAtLabel && <span class="message-time">{createdAtLabel}</span>}
          {message.role === 'assistant' && !isCurrentlyStreaming && message.durationMs !== undefined && (
            <span class="message-duration">{formatDuration(message.durationMs)}</span>
          )}
          {replyMeta && <span class="assistant-reply-hint">{replyMeta.compactText}</span>}
        </div>
        <div class="message-head-actions">
          {statusLabel && <span class={`message-status ${statusTone}`}>{statusLabel}</span>}
        </div>
      </div>

      {message.status === 'error' && (
        <ErrorDetailWithFallback message={message} />
      )}

      {isEditing ? (
        <InlineEditor
          initialText={message.markdown}
          capturedHeight={capturedHeight}
          onConfirm={(text) => onEditConfirm(message.id, text)}
          onCancel={onEditCancel}
        />
      ) : (
        <>
          {message.role === 'assistant' && combinedParts ? (
            combinedParts.map((part, index) => {
              if (part.kind === 'reasoning') {
                return (
                  <ReasoningBlock
                    key={`reasoning-${message.id}-${index}`}
                    text={part.text}
                    autoExpand={prefs.autoExpandReasoning}
                    disclosureKey={`reasoning:${message.id}:${index}`}
                    onContextMenu={(e) => onContextMenu('reasoning', part.text, e)}
                  />
                );
              }

              if (part.kind === 'toolCall') {
                return (
                  <div class="tool-call-list" key={`tool-${part.toolCall.id}-${index}`}>
                    {renderToolCall(part.toolCall, onContextMenu)}
                  </div>
                );
              }

              return (
                <BufferedTextPart
                  key={`text-${message.id}-${index}`}
                  messageId={message.id}
                  index={index}
                  text={part.text}
                  streaming={isCurrentlyStreaming}
                  onContextMenu={(e) => {
                    onContextMenu('message', getMessageRaw(), e as unknown as MouseEvent);
                  }}
                />
              );
            })
          ) : message.role === 'user' && renderableUserParts ? (
            renderableUserParts.map((part, index) => (
              part.kind === 'text' ? (
                <div
                  key={`user-text-${message.id}-${index}`}
                  class="message-body"
                  ref={index === 0 ? messageBodyRef : undefined}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text) }}
                />
              ) : (
                <figure key={`user-image-${message.id}-${index}`} class="message-user-image">
                  <img
                    class="message-user-image-element"
                    src={userImageSrc(part)}
                    alt={part.name || 'Attached image'}
                  />
                  {(part.name || (part.width && part.height)) && (
                    <figcaption class="message-user-image-caption">
                      {part.name || 'Image'}
                      {part.width && part.height ? ` · ${part.width}×${part.height}` : ''}
                    </figcaption>
                  )}
                </figure>
              )
            ))
          ) : (
            <div
              class="message-body"
              ref={message.role === 'user' ? messageBodyRef : undefined}
              dangerouslySetInnerHTML={{ __html: html }}
              onContextMenu={message.role === 'assistant' ? (e) => {
                e.preventDefault();
                onContextMenu('message', getMessageRaw(), e as unknown as MouseEvent);
              } : undefined}
            />
          )}

          {isLastAssistantMessage && message.role === 'assistant' && isCurrentlyStreaming && (
            <div class="message-glow-indicator" aria-label="Agent is responding" role="status" />
          )}
          {isLastAssistantMessage && message.role === 'assistant' && !isCurrentlyStreaming && (
            <div class="message-typing-indicator" role="status" aria-label="Agent is working">
              <span class="typing-indicator-dot" />
              <span class="typing-indicator-dot" />
              <span class="typing-indicator-dot" />
            </div>
          )}

        </>
      )}
    </div>
  );
}

export const MessageItem = memo(MessageItemView);
