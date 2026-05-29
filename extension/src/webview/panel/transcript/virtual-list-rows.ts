import type { ChatMessage } from '../../../shared/protocol';
import { AGENT_ACTIVITY_LABELS, type TurnActivityState } from './activity';
import { isPruningResultMessage, pruningDetailsFromMessage, type PruningHeaderState } from './pruning';

export type TranscriptRow =
  | { kind: 'systemPrompts'; key: string }
  | { kind: 'topGap'; key: string }
  | { kind: 'message'; key: string; message: ChatMessage; pruningHeaderState?: PruningHeaderState; activityState?: TurnActivityState | null; transcriptIndex?: number }
  | { kind: 'typingIndicator'; key: string; activityState?: TurnActivityState | null }
  | { kind: 'bottomGap'; key: string };

interface BuildTranscriptRowsOptions {
  transcript: readonly ChatMessage[];
  systemPromptCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
  busy: boolean;
  /** Deprecated: retained for older call sites; pruning now renders per assistant turn. */
  hasPruningResult?: boolean;
  /** Controls whether pruning-result custom messages are attached to assistant headers. */
  showPruningMessages?: boolean;
  /** Structured in-flight activity state for the current busy phase. */
  activityState?: TurnActivityState | null;
  /** Selected assistant model known before message_start. */
  pendingAssistantModelId?: string;
  /** Selected assistant thinking level known before message_start. */
  pendingAssistantThinkingLevel?: ChatMessage['thinkingLevel'];
}

type ResultPruningHeaderState = Extract<PruningHeaderState, { kind: 'result' }>;

function shouldSuppressInlineActivity(
  row: Extract<TranscriptRow, { kind: 'message' }>,
  activityState: TurnActivityState | null,
): boolean {
  if (!row.pruningHeaderState) {
    return false;
  }

  // Only suppress when pruning is still in progress (pending state animates its own label).
  // Once pruning completes (result), allow the next activity label through.
  if (row.pruningHeaderState.kind === 'result') {
    return activityState?.phase === 'pruning';
  }

  return activityState?.phase === 'pruning' || activityState?.phase === 'startingModel';
}

export function buildTranscriptRows({
  transcript,
  systemPromptCount,
  hasOlder,
  hasNewer,
  busy,
  showPruningMessages = true,
  activityState = null,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
}: BuildTranscriptRowsOptions): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  if (systemPromptCount > 0) {
    rows.push({ kind: 'systemPrompts', key: 'system-prompts' });
  }
  if (hasOlder) {
    rows.push({ kind: 'topGap', key: 'gap:older' });
  }

  let pendingPruning: { state: ResultPruningHeaderState; message: ChatMessage } | null = null;
  let lastAssistantRowIndexSinceUser: number | null = null;
  let latestUserMessage: ChatMessage | null = null;

  for (let i = 0; i < transcript.length; i++) {
    const message = transcript[i];
    if (isPruningResultMessage(message)) {
      const details = showPruningMessages ? pruningDetailsFromMessage(message) : null;
      if (!details) {
        pendingPruning = null;
        if (showPruningMessages) {
          rows.push({ kind: 'message', key: `message:${message.id}`, message, transcriptIndex: i });
        }
        continue;
      }

      const pruningHeaderState: ResultPruningHeaderState = {
        kind: 'result',
        details,
        fallbackText: message.markdown,
      };

      // Normal ordering is: pruning custom message, then assistant start. In
      // that case, keep the details pending and fold them into the following
      // assistant row. Some live streams can deliver the pruning custom message
      // after the assistant row has already been created; fold it backward into
      // that same assistant row instead of rendering a separate pruning card.
      if (lastAssistantRowIndexSinceUser !== null) {
        const row = rows[lastAssistantRowIndexSinceUser];
        if (row?.kind === 'message' && row.message.role === 'assistant') {
          rows[lastAssistantRowIndexSinceUser] = {
            ...row,
            pruningHeaderState,
          };
        }
        pendingPruning = null;
      } else {
        pendingPruning = { state: pruningHeaderState, message };
      }
      continue;
    }

    if (message.role === 'user') {
      pendingPruning = null;
      lastAssistantRowIndexSinceUser = null;
      latestUserMessage = message;
    }

    if (message.role === 'assistant') {
      const row: TranscriptRow = pendingPruning
        ? {
          kind: 'message',
          key: `message:${message.id}`,
          message,
          pruningHeaderState: pendingPruning.state,
          transcriptIndex: i,
        }
        : { kind: 'message', key: `message:${message.id}`, message, transcriptIndex: i };
      rows.push(row);
      lastAssistantRowIndexSinceUser = rows.length - 1;
      pendingPruning = null;
      continue;
    }

    rows.push({ kind: 'message', key: `message:${message.id}`, message, transcriptIndex: i });
  }

  const placeholderPruningHeaderState: PruningHeaderState | null = pendingPruning?.state ?? (
    showPruningMessages && latestUserMessage && activityState?.phase === 'pruning'
      ? { kind: 'pending', label: AGENT_ACTIVITY_LABELS.pruning }
      : null
  );
  const placeholderAssistantId = placeholderPruningHeaderState
    ? latestUserMessage
      ? `assistant-placeholder:${latestUserMessage.id}`
      : pendingPruning
        ? `assistant-placeholder:${pendingPruning.message.id}`
        : null
    : null;
  const placeholderCreatedAt = latestUserMessage?.createdAt || pendingPruning?.message.createdAt || '';

  // Keep a single assistant header shell visible through pruning pending →
  // pruning result, so the transcript does not jump between a standalone
  // activity bubble and a later header chip in a different location.
  let hasPlaceholderAssistant = false;
  const shouldRenderPlaceholderAssistant = !!placeholderPruningHeaderState
    && !!placeholderAssistantId
    && lastAssistantRowIndexSinceUser === null
    && (busy || placeholderPruningHeaderState.kind === 'result');
  if (shouldRenderPlaceholderAssistant && placeholderPruningHeaderState && placeholderAssistantId) {
    rows.push({
      kind: 'message',
      key: `message:${placeholderAssistantId}`,
      message: {
        id: placeholderAssistantId,
        role: 'assistant',
        createdAt: placeholderCreatedAt,
        markdown: '',
        modelId: pendingAssistantModelId,
        thinkingLevel: pendingAssistantThinkingLevel,
        status: 'completed',
        parts: [],
        toolCalls: [],
      },
      pruningHeaderState: placeholderPruningHeaderState,
    });
    hasPlaceholderAssistant = busy;
  }

  // Show an activity indicator when the backend is processing but hasn't started
  // streaming a response yet. When an assistant row is visible, activity text
  // renders inline at the end of that row unless pruning already owns the
  // header state for this waiting phase.
  if (busy) {
    const hasStreamingAssistant = transcript.some(
      (message) => message.role === 'assistant' && message.status === 'streaming',
    );
    if (!hasStreamingAssistant) {
      const lastVisibleRow = rows[rows.length - 1];
      const lastVisibleIsAssistant = lastVisibleRow?.kind === 'message' && lastVisibleRow.message.role === 'assistant';
      if (!lastVisibleIsAssistant) {
        rows.push({ kind: 'typingIndicator', key: 'typing-indicator', activityState });
      } else if (lastVisibleRow?.kind === 'message' && !shouldSuppressInlineActivity(lastVisibleRow, activityState)) {
        rows[rows.length - 1] = { ...lastVisibleRow, activityState };
      }
    }
  }

  if (hasNewer) {
    rows.push({ kind: 'bottomGap', key: 'gap:newer' });
  }
  return rows;
}

export function estimateTranscriptRowSize(row: TranscriptRow): number {
  if (row.kind === 'systemPrompts') {
    return 140;
  }
  if (row.kind === 'topGap' || row.kind === 'bottomGap') {
    return 56;
  }
  if (row.kind === 'typingIndicator') {
    return 64;
  }
  if (row.message.role === 'user') return 120;
  return row.pruningHeaderState?.kind === 'result' ? 220 : 180;
}
