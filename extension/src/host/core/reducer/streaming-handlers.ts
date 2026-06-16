import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { ChatMessage } from '../../../shared/protocol.js';
import {
  appendAssistantTextPart,
  appendContinuationSeparator,
  upsertAssistantToolCall,
  withAssistantParts,
  mergeAssistantToolCallsPreservingResolvedState,
  mergeContinuationToolCalls,
} from '../transcript-helpers.js';
import {
  withIncrementedWindowCounts,
} from '../transcript-window.js';
import type { ReducerResult } from './helpers.js';
import { resolveAlias, enforceLoadedWindowBudget } from './helpers.js';
import type { Event } from '../events.js';

export function handleMessageStarted(state: ArchState, event: Extract<Event, { kind: 'MessageStarted' }>): ReducerResult {
  const { sessionPath, messageId, requestId, modelId, thinkingLevel, timestamp } = event;
  const currentTurn = state.pending.currentTurnBySession[sessionPath];

  // Determine if this is a continuation (alias) of an existing turn
  const isAlias = !!(requestId && currentTurn && currentTurn.requestId === requestId);
  const canonicalMessageId = isAlias ? currentTurn!.firstMessageId : messageId;

  const nextState = produce(state, (draft) => {
    // Update alias map or currentTurnBySession
    if (isAlias) {
      draft.pending.messageIdAlias[messageId] = currentTurn!.firstMessageId;
    } else if (requestId) {
      draft.pending.currentTurnBySession[sessionPath] = { requestId, firstMessageId: messageId };
      // Clean up requestIdToLocalId mapping to avoid leaks. We do NOT reconcile
      // the optimistic message ID here because MessageStarted carries the
      // assistant message ID, not the user message ID. Reconciliation will be
      // handled when the backend echoes localId back in a future event.
      delete draft.pending.requestIdToLocalId[requestId];
    }

    // Ensure assistant message in transcript
    const list = draft.transcript.bySession[sessionPath] ??= [];

    if (isAlias) {
      // Alias path: continuation of an existing turn — append separator & update metadata
      const canonical = list.find((m: ChatMessage) => m.id === canonicalMessageId);
      if (canonical) {
        appendContinuationSeparator(canonical);
        if (modelId) canonical.modelId = modelId;
        if (thinkingLevel) canonical.thinkingLevel = thinkingLevel;
        canonical.status = 'streaming';
      }
    } else {
      // Non-alias: check if message already exists (update metadata only)
      const existing = list.find((m: ChatMessage) => m.id === messageId);
      if (existing) {
        if (modelId) existing.modelId = modelId;
        if (thinkingLevel) existing.thinkingLevel = thinkingLevel;
      } else {
        // New message: create it
        list.push({
          id: messageId,
          role: 'assistant',
          createdAt: new Date(timestamp).toISOString(),
          markdown: '',
          modelId,
          thinkingLevel,
          parts: [],
          status: 'streaming',
          toolCalls: [],
        });

        draft.transcript.windowBySession[sessionPath] = withIncrementedWindowCounts(
          draft.transcript.windowBySession[sessionPath],
        );
        enforceLoadedWindowBudget(draft, sessionPath);
      }
    }
  });

  return { state: nextState, effects: [] };
}

export function handleMessageDelta(state: ArchState, event: Extract<Event, { kind: 'MessageDelta' }>): ReducerResult {
  const messageId = resolveAlias(state, event.messageId);
  const nextState = produce(state, (draft) => {
    const message = draft.transcript.bySession[event.sessionPath]?.find(
      (m: ChatMessage) => m.id === messageId,
    );
    if (message && message.status !== 'completed' && message.status !== 'interrupted') {
      appendAssistantTextPart(message, 'text', event.delta);
      message.status = 'streaming';
    }
  });

  return { state: nextState, effects: [] };
}

export function handleMessageThinking(state: ArchState, event: Extract<Event, { kind: 'MessageThinking' }>): ReducerResult {
  const messageId = resolveAlias(state, event.messageId);
  const nextState = produce(state, (draft) => {
    const message = draft.transcript.bySession[event.sessionPath]?.find(
      (m: ChatMessage) => m.id === messageId,
    );
    if (message && message.status !== 'completed' && message.status !== 'interrupted') {
      appendAssistantTextPart(message, 'reasoning', event.thinking);
      message.status = 'streaming';
    }
  });

  return { state: nextState, effects: [] };
}

export function handleToolCall(state: ArchState, event: Extract<Event, { kind: 'ToolCall' }>): ReducerResult {
  const messageId = resolveAlias(state, event.messageId);
  const nextState = produce(state, (draft) => {
    const message = draft.transcript.bySession[event.sessionPath]?.find(
      (m: ChatMessage) => m.id === messageId,
    );
    if (message) {
      upsertAssistantToolCall(message, event.toolCall);
    }
  });

  return { state: nextState, effects: [] };
}

export function handleMessageFinished(state: ArchState, event: Extract<Event, { kind: 'MessageFinished' }>): ReducerResult {
  const messageId = resolveAlias(state, event.message.id);
  const isAlias = messageId !== event.message.id;
  const normalizedMessage = withAssistantParts(event.message);

  const nextState = produce(state, (draft) => {
    const list = draft.transcript.bySession[event.sessionPath] ??= [];

    if (isAlias) {
      // Alias merge: incoming message is a continuation — merge into canonical
      const canonical = list.find((m: ChatMessage) => m.id === messageId);
      if (canonical) {
        canonical.status = normalizedMessage.status;
        if (normalizedMessage.modelId) canonical.modelId = normalizedMessage.modelId;
        if (normalizedMessage.thinkingLevel) canonical.thinkingLevel = normalizedMessage.thinkingLevel;
        if (normalizedMessage.durationMs !== undefined) {
          canonical.durationMs = (canonical.durationMs ?? 0) + normalizedMessage.durationMs;
        }
        mergeContinuationToolCalls(canonical, normalizedMessage);
      }
    } else {
      const index = list.findIndex((m: ChatMessage) => m.id === normalizedMessage.id);
      if (index === -1) {
        list.push(normalizedMessage);
        draft.transcript.windowBySession[event.sessionPath] = withIncrementedWindowCounts(
          draft.transcript.windowBySession[event.sessionPath],
        );
        if (normalizedMessage.role === 'user') {
          draft.transcript.windowBySession[event.sessionPath].hasUserMessages = true;
        }
        enforceLoadedWindowBudget(draft, event.sessionPath);
      } else {
        const previousMessage = list[index];
        if (previousMessage) {
          mergeAssistantToolCallsPreservingResolvedState(normalizedMessage, previousMessage);
          // Preserve errorDetail set by onError if the replacement doesn't carry its own
          if (normalizedMessage.status === 'error' && !normalizedMessage.errorDetail && previousMessage.errorDetail) {
            normalizedMessage.errorDetail = previousMessage.errorDetail;
          }
        }
        list[index] = normalizedMessage;
      }
    }
  });

  return { state: nextState, effects: [] };
}

export function handleMessageAborted(state: ArchState, event: Extract<Event, { kind: 'MessageAborted' }>): ReducerResult {
  const { sessionPath, messageId } = event;
  if (!messageId) {
    return { state, effects: [] };
  }

  const canonicalId = resolveAlias(state, messageId);
  const nextState = produce(state, (draft) => {
    const message = draft.transcript.bySession[sessionPath]?.find(
      (m: ChatMessage) => m.id === canonicalId,
    );
    if (message) {
      message.status = 'interrupted';
    }
  });

  return { state: nextState, effects: [] };
}

export function handleStreamingEvent(state: ArchState, event: Event): ReducerResult {
  switch (event.kind) {
    case 'MessageStarted':
      return handleMessageStarted(state, event);
    case 'MessageDelta':
      return handleMessageDelta(state, event);
    case 'MessageThinking':
      return handleMessageThinking(state, event);
    case 'ToolCall':
      return handleToolCall(state, event);
    case 'MessageFinished':
      return handleMessageFinished(state, event);
    case 'MessageAborted':
      return handleMessageAborted(state, event);
    default:
      return {
        state,
        effects: [
          {
            kind: 'Log',
            corrId: '',
            level: 'warn',
            message: `Unhandled streaming event: ${(event as { kind?: string }).kind}`,
          },
        ],
      };
  }
}
