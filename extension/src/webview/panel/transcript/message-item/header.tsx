/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';

import type { ChatMessage } from '../../../../shared/protocol';
import {
  assistantReplyMeta,
  formatAssistantMetaTooltip,
  formatDuration,
  roleLabel,
} from '../header';
import { MessageHeader } from '../message-header';
import { PruningHeaderChip } from '../pruning-header';
import type { PruningHeaderState } from '../pruning';
import { StatusChip, type StatusTone } from '../status-chip';

interface MessageHeaderActionsProps {
  pruningHeaderState: PruningHeaderState | undefined;
  pruningExpanded: boolean;
  onTogglePruning: () => void;
  statusLabel: string | null;
  statusTone: StatusTone;
}

export function MessageHeaderActions({
  pruningHeaderState,
  pruningExpanded,
  onTogglePruning,
  statusLabel,
  statusTone,
}: MessageHeaderActionsProps) {
  if (!pruningHeaderState && !statusLabel) return null;
  return (
    <>
      {pruningHeaderState && (
        <PruningHeaderChip
          state={pruningHeaderState}
          expanded={pruningExpanded}
          onToggle={onTogglePruning}
        />
      )}
      {statusLabel && <StatusChip tone={statusTone} label={statusLabel} />}
    </>
  );
}

interface MessageItemHeaderProps {
  role: ChatMessage['role'];
  isCurrentlyStreaming: boolean;
  durationMs: number | undefined;
  replyMeta: ReturnType<typeof assistantReplyMeta>;
  assistantMetaTooltip: string | null;
  actions: ComponentChildren;
}

export function MessageItemHeader({
  role,
  isCurrentlyStreaming,
  durationMs,
  replyMeta,
  assistantMetaTooltip,
  actions,
}: MessageItemHeaderProps) {
  return (
    <MessageHeader
      label={role !== 'user' ? roleLabel(role) : null}
      duration={role === 'assistant' && !isCurrentlyStreaming && durationMs !== undefined ? formatDuration(durationMs) : null}
      meta={replyMeta?.compactText ?? null}
      title={assistantMetaTooltip ?? undefined}
      actions={actions}
      align={role === 'user' ? 'end' : 'start'}
    />
  );
}
