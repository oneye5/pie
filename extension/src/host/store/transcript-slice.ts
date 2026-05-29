import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type {
  ChatMessage,
  SystemPromptEntry,
  ToolCall,
  TranscriptWindow,
  UserContentPart,
} from '../../shared/protocol';
import { TRANSCRIPT_WINDOW_BUDGETS } from '../../shared/transcript-window';
import {
  buildFullTranscriptWindow,
  cullTranscriptWindowAroundActiveTurn,
  normalizeTranscriptWindow,
  trimTranscriptWindowTail,
  withDecrementedWindowCounts,
  withIncrementedWindowCounts,
} from '../session-service/transcript-window';
import {
  appendAssistantTextPart,
  appendContinuationSeparator,
  markdownFromUserParts,
  mergeAssistantToolCallsPreservingResolvedState,
  mergeContinuationToolCalls,
  upsertAssistantToolCall,
  withAssistantParts,
  type TranscriptState,
} from './transcript-helpers';

function ensureSessionWindow(state: TranscriptState, sessionPath: string): TranscriptWindow {
  const existing = state.windowBySession[sessionPath];
  if (existing) {
    return existing;
  }

  const built = buildFullTranscriptWindow(state.bySession[sessionPath] ?? []);
  state.windowBySession[sessionPath] = built;
  return built;
}

function enforceLoadedWindowBudget(state: TranscriptState, sessionPath: string): void {
  const transcript = state.bySession[sessionPath];
  if (!transcript || transcript.length === 0) {
    return;
  }

  const transcriptWindow = ensureSessionWindow(state, sessionPath);
  const activeTurnMessageId = transcript[transcript.length - 1]?.id;
  const culled = cullTranscriptWindowAroundActiveTurn({
    transcript,
    transcriptWindow,
    activeTurnMessageId,
    maxLoadedCount: TRANSCRIPT_WINDOW_BUDGETS.maxLoadedCount,
  });

  state.bySession[sessionPath] = culled.transcript;
  state.windowBySession[sessionPath] = culled.transcriptWindow;
}

const transcriptSlice = createSlice({
  name: 'transcript',
  initialState: {
    bySession: {},
    systemPromptsBySession: {},
    windowBySession: {},
  } as TranscriptState,
  reducers: {
    setTranscript(
      state,
      action: PayloadAction<{
        sessionPath: string;
        transcript: ChatMessage[];
        transcriptWindow?: TranscriptWindow;
        systemPrompts?: SystemPromptEntry[];
        preserveCurrentTurn?: boolean;
        preserveAliases?: boolean;
      }>,
    ) {
      const {
        sessionPath,
        transcript,
        transcriptWindow,
        systemPrompts,
        preserveCurrentTurn,
      } = action.payload;

      state.bySession[sessionPath] = transcript;
      state.windowBySession[sessionPath] = normalizeTranscriptWindow(transcript, transcriptWindow);

      if (systemPrompts !== undefined || !preserveCurrentTurn) {
        state.systemPromptsBySession[sessionPath] = systemPrompts ?? [];
      }
    },
    setTranscriptWindowMetadata(
      state,
      action: PayloadAction<{ sessionPath: string; transcriptWindow: TranscriptWindow }>,
    ) {
      const { sessionPath, transcriptWindow } = action.payload;
      const transcript = state.bySession[sessionPath] ?? [];
      state.windowBySession[sessionPath] = normalizeTranscriptWindow(transcript, transcriptWindow);
    },
    trimTranscriptForInactivity(
      state,
      action: PayloadAction<{ sessionPath: string; keepTailCount: number; dropAll?: boolean }>,
    ) {
      const { sessionPath, keepTailCount, dropAll } = action.payload;
      const transcript = state.bySession[sessionPath] ?? [];
      const transcriptWindow = ensureSessionWindow(state, sessionPath);

      if (dropAll) {
        state.bySession[sessionPath] = [];
        state.windowBySession[sessionPath] = {
          ...transcriptWindow,
          loadedStart: transcriptWindow.totalCount,
          loadedEnd: transcriptWindow.totalCount,
          hasOlder: transcriptWindow.totalCount > 0,
          hasNewer: false,
          isPartial: transcriptWindow.totalCount > 0,
        };
        return;
      }

      const trimmed = trimTranscriptWindowTail(transcript, transcriptWindow, keepTailCount);
      state.bySession[sessionPath] = trimmed.transcript;
      state.windowBySession[sessionPath] = trimmed.transcriptWindow;
    },
    clearTranscript(state, action: PayloadAction<string>) {
      delete state.bySession[action.payload];
      delete state.systemPromptsBySession[action.payload];
      delete state.windowBySession[action.payload];
    },
    clearSessionState(state, action: PayloadAction<string>) {
      delete state.bySession[action.payload];
      delete state.systemPromptsBySession[action.payload];
      delete state.windowBySession[action.payload];
    },
    replaceSessionPath(
      state,
      action: PayloadAction<{ oldPath: string; newPath: string }>,
    ) {
      const { oldPath, newPath } = action.payload;
      if (oldPath === newPath) return;
      const oldTranscript = state.bySession[oldPath];
      if (oldTranscript) {
        const existing = state.bySession[newPath] ?? [];
        state.bySession[newPath] = [...existing, ...oldTranscript];
        delete state.bySession[oldPath];
      }
      const oldWindow = state.windowBySession[oldPath];
      if (oldWindow && !state.windowBySession[newPath]) {
        state.windowBySession[newPath] = oldWindow;
        delete state.windowBySession[oldPath];
      } else {
        delete state.windowBySession[oldPath];
      }
      const oldPrompts = state.systemPromptsBySession[oldPath];
      if (oldPrompts && !state.systemPromptsBySession[newPath]) {
        state.systemPromptsBySession[newPath] = oldPrompts;
      }
      delete state.systemPromptsBySession[oldPath];
    },
    ensureAssistantMessage(
      state,
      action: PayloadAction<{
        sessionPath: string;
        messageId: string;
        /** Whether this message is a continuation alias (resolved by arch reducer). */
        isAlias?: boolean;
        requestId?: string;
        modelId?: string;
        thinkingLevel?: ChatMessage['thinkingLevel'];
      }>,
    ) {
      const { sessionPath, messageId, isAlias, modelId, thinkingLevel } = action.payload;
      const list = (state.bySession[sessionPath] ??= []);

      // Alias path: this is a continuation of an existing turn. The messageId
      // passed here is the canonical (first) message ID, resolved by the arch reducer.
      if (isAlias) {
        const canonical = list.find((message) => message.id === messageId);
        if (canonical) {
          appendContinuationSeparator(canonical);
          if (modelId) {
            canonical.modelId = modelId;
          }
          if (thinkingLevel) {
            canonical.thinkingLevel = thinkingLevel;
          }
          canonical.status = 'streaming';
        }
        return;
      }

      // Non-alias: check if message already exists (update metadata only).
      const existing = list.find((m) => m.id === messageId);
      if (existing) {
        if (modelId) {
          existing.modelId = modelId;
        }
        if (thinkingLevel) {
          existing.thinkingLevel = thinkingLevel;
        }
        return;
      }

      // New message: create it.
      list.push({
        id: messageId,
        role: 'assistant',
        createdAt: new Date().toISOString(),
        markdown: '',
        modelId,
        thinkingLevel,
        parts: [],
        status: 'streaming',
        toolCalls: [],
      });

      state.windowBySession[sessionPath] = withIncrementedWindowCounts(state.windowBySession[sessionPath]);
      enforceLoadedWindowBudget(state, sessionPath);
    },
    appendDelta(
      state,
      action: PayloadAction<{ sessionPath: string; messageId: string; delta: string }>,
    ) {
      const { sessionPath, messageId, delta } = action.payload;
      const message = state.bySession[sessionPath]?.find((item) => item.id === messageId);
      if (message && message.status !== 'completed' && message.status !== 'interrupted') {
        appendAssistantTextPart(message, 'text', delta);
        message.status = 'streaming';
      }
    },
    appendThinking(
      state,
      action: PayloadAction<{ sessionPath: string; messageId: string; thinking: string }>,
    ) {
      const { sessionPath, messageId, thinking } = action.payload;
      const message = state.bySession[sessionPath]?.find((item) => item.id === messageId);
      if (message && message.status !== 'completed' && message.status !== 'interrupted') {
        appendAssistantTextPart(message, 'reasoning', thinking);
        message.status = 'streaming';
      }
    },
    upsertToolCall(
      state,
      action: PayloadAction<{ sessionPath: string; messageId: string; toolCall: ToolCall }>,
    ) {
      const { sessionPath, messageId, toolCall } = action.payload;
      const message = state.bySession[sessionPath]?.find((item) => item.id === messageId);
      if (message) {
        upsertAssistantToolCall(message, toolCall);
      }
    },
    upsertMessage(
      state,
      action: PayloadAction<{ sessionPath: string; message: ChatMessage; canonicalMessageId?: string }>,
    ) {
      const { sessionPath, message, canonicalMessageId } = action.payload;
      const normalizedMessage = withAssistantParts(message);
      const list = (state.bySession[sessionPath] ??= []);

      // Alias merge: incoming message is a continuation — merge into canonical.
      if (canonicalMessageId && canonicalMessageId !== normalizedMessage.id) {
        const canonical = list.find((item) => item.id === canonicalMessageId);
        if (canonical) {
          canonical.status = normalizedMessage.status;
          if (normalizedMessage.modelId) {
            canonical.modelId = normalizedMessage.modelId;
          }
          if (normalizedMessage.thinkingLevel) {
            canonical.thinkingLevel = normalizedMessage.thinkingLevel;
          }
          if (normalizedMessage.durationMs !== undefined) {
            canonical.durationMs = (canonical.durationMs ?? 0) + normalizedMessage.durationMs;
          }
          mergeContinuationToolCalls(canonical, normalizedMessage);
        }
        return;
      }

      const index = list.findIndex((item) => item.id === normalizedMessage.id);
      if (index === -1) {
        list.push(normalizedMessage);
        state.windowBySession[sessionPath] = withIncrementedWindowCounts(state.windowBySession[sessionPath]);
        if (normalizedMessage.role === 'user') {
          state.windowBySession[sessionPath].hasUserMessages = true;
        }
        enforceLoadedWindowBudget(state, sessionPath);
        return;
      }

      const previousMessage = list[index];
      if (previousMessage) {
        mergeAssistantToolCallsPreservingResolvedState(normalizedMessage, previousMessage);
        // Preserve errorDetail set by onError if the replacement doesn't carry its own.
        if (normalizedMessage.status === 'error' && !normalizedMessage.errorDetail && previousMessage.errorDetail) {
          normalizedMessage.errorDetail = previousMessage.errorDetail;
        }
      }
      list[index] = normalizedMessage;
    },
    setMessageStatus(
      state,
      action: PayloadAction<{ sessionPath: string; messageId: string; status: ChatMessage['status'] }>,
    ) {
      const { sessionPath, messageId, status } = action.payload;
      const message = state.bySession[sessionPath]?.find((item) => item.id === messageId);
      if (message) {
        message.status = status;
      }
    },
    setMessageError(
      state,
      action: PayloadAction<{ sessionPath: string; errorDetail: string }>,
    ) {
      const { sessionPath, errorDetail } = action.payload;
      const list = state.bySession[sessionPath];
      if (!list) return;
      const reversed = [...list].reverse();
      const msg = reversed.find(
        (m) => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'error'),
      ) ?? reversed.find((m) => m.role === 'assistant');
      if (msg) {
        msg.status = 'error';
        msg.errorDetail = errorDetail;
      }
    },
    appendLocalUserMessage(
      state,
      action: PayloadAction<{
        sessionPath: string;
        id: string;
        text: string;
        userParts?: UserContentPart[];
      }>,
    ) {
      const { sessionPath, id, text, userParts } = action.payload;
      const list = (state.bySession[sessionPath] ??= []);
      list.push({
        id,
        role: 'user',
        createdAt: new Date().toISOString(),
        markdown: markdownFromUserParts(userParts, text),
        userParts,
        status: 'completed',
      });

      const nextWindow = withIncrementedWindowCounts(state.windowBySession[sessionPath]);
      nextWindow.hasUserMessages = true;
      state.windowBySession[sessionPath] = nextWindow;
      enforceLoadedWindowBudget(state, sessionPath);
    },
    removeMessage(
      state,
      action: PayloadAction<{ sessionPath: string; messageId: string }>,
    ) {
      const { sessionPath, messageId } = action.payload;
      const list = state.bySession[sessionPath];
      if (!list) {
        return;
      }

      const removedMessage = list.find((message) => message.id === messageId);
      state.bySession[sessionPath] = list.filter((message) => message.id !== messageId);
      const nextWindow = withDecrementedWindowCounts(state.windowBySession[sessionPath]);
      if (nextWindow) {
        const isFullyLoaded =
          !nextWindow.hasOlder
          && !nextWindow.hasNewer
          && nextWindow.loadedStart === 0
          && nextWindow.loadedEnd === nextWindow.totalCount;

        if (
          removedMessage?.role === 'user'
          && isFullyLoaded
          && !state.bySession[sessionPath].some((message) => message.role === 'user')
        ) {
          nextWindow.hasUserMessages = false;
        }

        state.windowBySession[sessionPath] = nextWindow;
      }
    },
  },
});

export const transcriptReducer = transcriptSlice.reducer;
export const transcriptActions = transcriptSlice.actions;
export type { TranscriptState } from './transcript-helpers';
