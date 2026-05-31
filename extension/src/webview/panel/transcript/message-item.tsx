/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { ChatMessage, ChatPrefs } from '../../../shared/protocol';
import { useNotice } from '../hooks/notice-context';
import { renderMarkdown, reasoningSummary } from '../markdown';
import { cx } from '../utils/cx';
import {
  assistantReplyMeta,
  formatAssistantMetaTooltip,
  formatDuration,
  formatTimestamp,
  roleLabel,
} from './header';
import { InlineEditor } from './inline-editor';
import { shouldOpenUserMessageEditor } from './interactions';
import { MessageHeader } from './message-header';
import { PruningHeaderChip, PruningHeaderPanel } from './pruning-header';
import type { PruningHeaderState } from './pruning';
import { StatusChip, type StatusTone } from './status-chip';
import type { TurnActivityState } from './activity';
import {
  TurnActivityStrip,
  activityPhaseHasRunningDot,
  activityToneToStripTone,
} from './turn-activity-strip';

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
      class={cx(
        'cursor-pointer select-none rounded-md transition-colors duration-150 hover:bg-control-hover',
        open && 'bg-control/60',
      )}
      role="button"
      aria-expanded={open}
      tabIndex={0}
      onClick={() => setOpen((v) => !v)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
    >
      <div class="flex items-center gap-1.5 px-2 py-1">
        <svg class={cx('shrink-0 text-muted transition-transform duration-150', open && 'rotate-90')} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="text-[10px] font-bold uppercase tracking-wider text-muted">Reasoning</span>
        {!open && (
          <span class="min-w-0 truncate text-[11px] text-foreground/70">{reasoningSummary(text)}</span>
        )}
      </div>
      {open && (
        <div class="px-2.5 pb-2.5 text-xs leading-relaxed text-foreground select-text">
          <div
            class="message-body"
            dangerouslySetInnerHTML={{ __html: html }}
            aria-live="polite"
          />
        </div>
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
        <button
          class="message-error-detail-btn"
          onClick={() => { void navigator.clipboard?.writeText(detail); }}
          title="Copy error detail"
          aria-label="Copy error detail"
        >
          Copy
        </button>
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
  pruningHeaderState,
  activityState,
  transcript,
  transcriptIndex,
  hasOlder,
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

  const [pruningExpanded, setPruningExpanded] = useState(false);
  const [pruningRawExpanded, setPruningRawExpanded] = useState(false);

  // Locate the previous user prompt for failed/interrupted recovery actions.
  const recovery = useMemo(() => {
    if (message.role !== 'assistant') return null;
    if (message.status !== 'error' && message.status !== 'interrupted') return null;
    if (transcript && typeof transcriptIndex === 'number') {
      for (let i = transcriptIndex - 1; i >= 0; i -= 1) {
        if (transcript[i]?.role === 'user') {
          return { kind: 'available' as const, userId: transcript[i]!.id };
        }
      }
    }
    // Previous prompt is not in the loaded window.
    return hasOlder ? { kind: 'unloaded' as const } : null;
  }, [message.role, message.status, transcript, transcriptIndex, hasOlder]);

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
  const statusTone: StatusTone =
    message.status === 'interrupted' ? 'interrupted'
    : message.status === 'error' ? 'error'
    : 'neutral';
  const replyMeta = assistantReplyMeta(message);
  const assistantMetaTooltip = formatAssistantMetaTooltip(message);

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
  const hasActivityFooter = isLastAssistantMessage && message.role === 'assistant';
  const handleMessageClick = isClickableUserMsg
    ? (event: MouseEvent) => {
        if (!shouldOpenUserMessageEditor(event.target)) {
          return;
        }
        onEditRequest(message.id);
      }
    : undefined;
  const headerActions = pruningHeaderState || statusLabel
    ? (
      <>
        {pruningHeaderState && (
          <PruningHeaderChip
            state={pruningHeaderState}
            expanded={pruningExpanded}
            onToggle={() => setPruningExpanded((v) => !v)}
          />
        )}
        {statusLabel && <StatusChip tone={statusTone} label={statusLabel} />}
      </>
    )
    : null;

  return (
    <div
      class={cx(
        'flex w-fit max-w-[88%] min-w-0 flex-col gap-2 self-start rounded-xl bg-card px-3 py-2.5 shadow-sm',
        'forced-colors:border forced-colors:border-[ButtonText]',
        message.role === 'user' && 'self-end rounded-br-sm bg-accent/6',
        message.role === 'assistant' && 'rounded-bl-sm',
        message.role === 'system' && 'w-auto max-w-none self-stretch bg-control',
        isCurrentlyStreaming && 'w-[min(var(--message-assistant-width),100%)] max-[340px]:w-[min(var(--message-assistant-width-narrow),100%)]',
        isClickableUserMsg && 'cursor-pointer hover:ring-1 hover:ring-border-subtle',
      )}
      data-message-id={message.id}
      data-role={message.role}
      onClick={handleMessageClick}
      title={isClickableUserMsg ? 'Click to edit' : undefined}
    >
      <MessageHeader
        label={message.role !== 'user' ? roleLabel(message.role) : null}
        timestamp={createdAtLabel}
        duration={message.role === 'assistant' && !isCurrentlyStreaming && message.durationMs !== undefined ? formatDuration(message.durationMs) : null}
        meta={replyMeta?.compactText ?? null}
        title={assistantMetaTooltip ?? undefined}
        actions={headerActions}
      />

      {pruningHeaderState?.kind === 'result' && pruningExpanded && (
        <PruningHeaderPanel
          details={pruningHeaderState.details}
          rawExpanded={pruningRawExpanded}
          onRawToggle={() => setPruningRawExpanded((v) => !v)}
        />
      )}

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

          {hasActivityFooter && (
            <div class="message-activity-footer">
              {isCurrentlyStreaming ? (
                <div class="message-glow-indicator" aria-label="Agent is responding" role="status" />
              ) : activityState ? (
                <TurnActivityStrip
                  label={activityState.label}
                  detail={activityState.detail}
                  tone={activityToneToStripTone(activityState.tone)}
                  runningDot={activityPhaseHasRunningDot(activityState.phase)}
                  ariaLabel={activityState.ariaLabel}
                />
              ) : null}
            </div>
          )}

          {recovery && (
            <div class="message-recovery">
              {recovery.kind === 'available' ? (
                <button
                  class="message-retry-btn"
                  type="button"
                  onClick={() => onEditRequest(recovery.userId)}
                  title="Edit the previous prompt and resend"
                >
                  ↻ Edit previous prompt
                </button>
              ) : (
                <span class="message-retry-hint">Load older messages to retry</span>
              )}
            </div>
          )}

        </>
      )}
    </div>
  );
}

export const MessageItem = memo(MessageItemView);
