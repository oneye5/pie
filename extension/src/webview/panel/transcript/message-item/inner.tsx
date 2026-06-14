/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren, RefObject } from 'preact';

import type { ChatMessage, ChatPrefs } from '../../../../shared/protocol';
import { cx } from '../../utils/cx';
import { InlineEditor } from '../inline-editor';
import type { PruningHeaderState } from '../pruning';
import { PruningHeaderPanel } from '../pruning-header';
import type { RenderToolCall, TranscriptContextMenuHandler } from '../types';
import type { TurnActivityState } from '../activity';
import { assistantPartsFromMessage, getRenderableUserParts } from '../parts';
import { assistantReplyMeta } from '../header';
import type { StatusTone } from '../status-chip';
import { ErrorDetailWithFallback } from './error-detail';
import { MessageContent } from './content';
import { MessageFooter } from './footer';
import { MessageItemHeader, MessageHeaderActions } from './header';

interface MessageItemShellProps {
  messageId: string;
  role: ChatMessage['role'];
  isCurrentlyStreaming: boolean;
  isClickableUserMsg: boolean;
  isEditing: boolean;
  handleMessageClick: ((event: MouseEvent) => void) | undefined;
  children: ComponentChildren;
}

export function MessageItemShell({
  messageId,
  role,
  isCurrentlyStreaming,
  isClickableUserMsg,
  isEditing,
  handleMessageClick,
  children,
}: MessageItemShellProps) {
  return (
    <div
      class={cx(
        'flex w-fit max-w-[88%] min-w-0 flex-col gap-2 rounded-xl px-3 py-2.5',
        'transition-[background-color,box-shadow] duration-[var(--panel-duration-normal)]',
        'forced-colors:border forced-colors:border-[ButtonText]',
        role === 'assistant' && 'self-start rounded-xl bg-card shadow-sm',
        role === 'user' && 'self-end rounded-xl bg-accent/15 shadow-none',
        role === 'system' && 'w-auto max-w-none self-stretch bg-surface shadow-none',
        isCurrentlyStreaming && 'w-[min(var(--message-assistant-width),100%)] max-[340px]:w-[min(var(--message-assistant-width-narrow),100%)]',
        isClickableUserMsg && 'cursor-pointer hover:ring-1 hover:ring-border-subtle hover:bg-accent/20',
      )}
      data-message-id={messageId}
      data-role={role}
      data-editing={isEditing ? 'true' : undefined}
      data-streaming={isCurrentlyStreaming ? 'true' : undefined}
      onClick={handleMessageClick}
      title={isClickableUserMsg ? 'Click to edit' : undefined}
    >
      {children}
    </div>
  );
}

interface MessageItemInnerProps {
  message: ChatMessage;
  isEditing: boolean;
  isCurrentlyStreaming: boolean;
  capturedHeight: number | null;
  pruningHeaderState: PruningHeaderState | undefined;
  pruningExpanded: boolean;
  setPruningExpanded: (fn: (v: boolean) => boolean) => void;
  pruningRawExpanded: boolean;
  setPruningRawExpanded: (fn: (v: boolean) => boolean) => void;
  statusLabel: string | null;
  statusTone: StatusTone;
  replyMeta: ReturnType<typeof assistantReplyMeta>;
  assistantMetaTooltip: string | null;
  html: string;
  getMessageRaw: () => string;
  combinedParts: ReturnType<typeof assistantPartsFromMessage> | undefined;
  renderableUserParts: ReturnType<typeof getRenderableUserParts> | undefined;
  prefs: ChatPrefs;
  renderToolCall: RenderToolCall;
  onContextMenu: TranscriptContextMenuHandler;
  messageBodyRef: RefObject<HTMLDivElement>;
  hasActivityFooter: boolean | undefined;
  footerActivityState: TurnActivityState | null;
  recovery: { kind: 'available'; userId: string } | { kind: 'unloaded' } | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
  onEditCancel: () => void;
}

export function MessageItemInner({
  message,
  isEditing,
  isCurrentlyStreaming,
  capturedHeight,
  pruningHeaderState,
  pruningExpanded,
  setPruningExpanded,
  pruningRawExpanded,
  setPruningRawExpanded,
  statusLabel,
  statusTone,
  replyMeta,
  assistantMetaTooltip,
  html,
  getMessageRaw,
  combinedParts,
  renderableUserParts,
  prefs,
  renderToolCall,
  onContextMenu,
  messageBodyRef,
  hasActivityFooter,
  footerActivityState,
  recovery,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
}: MessageItemInnerProps) {
  const showHeaderActions = pruningHeaderState || statusLabel;
  const headerActions = showHeaderActions ? (
    <MessageHeaderActions
      pruningHeaderState={pruningHeaderState}
      pruningExpanded={pruningExpanded}
      onTogglePruning={() => setPruningExpanded((v) => !v)}
      statusLabel={statusLabel}
      statusTone={statusTone}
    />
  ) : null;

  return (
    <>
      <MessageItemHeader
        role={message.role}
        isCurrentlyStreaming={isCurrentlyStreaming}
        durationMs={message.durationMs}
        replyMeta={replyMeta}
        assistantMetaTooltip={assistantMetaTooltip}
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
          <MessageContent
            messageId={message.id}
            role={message.role}
            combinedParts={combinedParts}
            renderableUserParts={renderableUserParts}
            html={html}
            isCurrentlyStreaming={isCurrentlyStreaming}
            messageBodyRef={messageBodyRef}
            prefs={prefs}
            renderToolCall={renderToolCall}
            onContextMenu={onContextMenu}
            getMessageRaw={getMessageRaw}
          />

          <MessageFooter
            hasActivityFooter={hasActivityFooter}
            footerActivityState={footerActivityState}
            recovery={recovery}
            onEditRequest={onEditRequest}
          />
        </>
      )}
    </>
  );
}
