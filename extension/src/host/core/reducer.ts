/**
 * Top-level reducer: `(state, event) → {state, effects}`.
 *
 * The reducer is **pure**: no I/O, no globals, no mutation of input.
 * Effects are queued descriptively; the `EffectRunner` executes them and
 * dispatches result events back.
 *
 * Transcript mutations use Immer's `produce` so that mutation-style helpers
 * (appendAssistantTextPart, upsertAssistantToolCall, etc.) can operate on
 * the draft directly. Simple field updates continue using spread-operator
 * patterns.
 *
 * **State-shape rule (binding):** keyed collections in `ArchState` MUST use
 * `Record<string, T>` — never `Map`/`Set`. RTK + Immer reject mutating those
 * built-ins without an explicit `enableMapSet()` opt-in; treat that opt-in as
 * a deliberate decision, not a default.
 */

import { produce } from 'immer';

import {
  createInitialArchState,
  type ArchState,
  type PendingOp,
  type CurrentTurn,
} from './arch-state';
import type { Effect } from './effects';
import type { Event } from './events';
import type { ChatMessage, ChatPrefs, ComposerInput } from '../../shared/protocol';
import {
  appendAssistantTextPart,
  appendContinuationSeparator,
  upsertAssistantToolCall,
  withAssistantParts,
  mergeAssistantToolCallsPreservingResolvedState,
  mergeContinuationToolCalls,
  markdownFromUserParts,
} from '../store/transcript-helpers';
import {
  buildFullTranscriptWindow,
  normalizeTranscriptWindow,
  cullTranscriptWindowAroundActiveTurn,
  withIncrementedWindowCounts,
  withDecrementedWindowCounts,
} from '../session-service/transcript-window';
import { TRANSCRIPT_WINDOW_BUDGETS } from '../../shared/transcript-window';

// Re-export for downstream consumers that import from './reducer'
export type { ArchState, PendingOp, CurrentTurn };
export { createInitialArchState } from './arch-state';

/** Reducer result using the real Effect type from effects.ts. */
export interface ReducerResult {
  state: ArchState;
  effects: Effect[];
}

/** Pre-created initial state for convenience. */
const initialArchState: ArchState = createInitialArchState();
export { initialArchState };

// ─── Internal helpers ──────────────────────────────────────────────────────────

/** Resolve a possibly-aliased message ID to its canonical form. */
function resolveAlias(state: ArchState, id: string): string {
  return state.pending.messageIdAlias[id] ?? id;
}

/** Upsert a ChatMessage in a session's transcript array. */
function upsertTranscriptMessage(messages: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx >= 0) {
    const copy = [...messages];
    copy[idx] = message;
    return copy;
  }
  return [...messages, message];
}

/** Upsert a session summary in the sessions array. */
function upsertSessionSummary(
  list: readonly import('../../shared/protocol').SessionSummary[],
  summary: import('../../shared/protocol').SessionSummary,
): import('../../shared/protocol').SessionSummary[] {
  const idx = list.findIndex((s) => s.path === summary.path);
  if (idx >= 0) {
    const copy = [...list];
    copy[idx] = summary;
    return copy;
  }
  return [...list, summary];
}

/** Filter a string array, removing one element. */
function removeFromArray(arr: readonly string[], value: string): string[] {
  return arr.filter((p) => p !== value);
}

/** Add to an array if not already present. */
function addToArray(arr: readonly string[], value: string): string[] {
  return arr.includes(value) ? [...arr] : [...arr, value];
}

// ─── Immer-based transcript mutation helpers ─────────────────────────────────

/** Ensure a session window exists, creating a default if missing. */
function ensureSessionWindow(draft: ArchState, sessionPath: string) {
  if (!draft.transcript.windowBySession[sessionPath]) {
    draft.transcript.windowBySession[sessionPath] = buildFullTranscriptWindow(
      draft.transcript.bySession[sessionPath] ?? [],
    );
  }
  return draft.transcript.windowBySession[sessionPath];
}

/** Enforce the loaded-window budget by culling old messages if needed. */
function enforceLoadedWindowBudget(draft: ArchState, sessionPath: string) {
  const transcript = draft.transcript.bySession[sessionPath];
  if (!transcript || transcript.length === 0) return;

  const transcriptWindow = ensureSessionWindow(draft, sessionPath);
  const activeTurnMessageId = transcript[transcript.length - 1]?.id;
  const culled = cullTranscriptWindowAroundActiveTurn({
    transcript,
    transcriptWindow,
    activeTurnMessageId,
    maxLoadedCount: TRANSCRIPT_WINDOW_BUDGETS.maxLoadedCount,
  });

  draft.transcript.bySession[sessionPath] = culled.transcript;
  draft.transcript.windowBySession[sessionPath] = culled.transcriptWindow;
}

/** Append an optimistic local user message to the transcript (Immer draft). */
function appendLocalUserMessage(
  draft: ArchState,
  sessionPath: string,
  id: string,
  text: string,
  userParts: import('../../shared/protocol').UserContentPart[] | undefined,
) {
  const list = draft.transcript.bySession[sessionPath] ?? [];
  list.push({
    id,
    role: 'user',
    createdAt: new Date().toISOString(),
    markdown: markdownFromUserParts(userParts, text),
    userParts,
    status: 'completed',
  });
  draft.transcript.bySession[sessionPath] = list;

  const nextWindow = withIncrementedWindowCounts(draft.transcript.windowBySession[sessionPath]);
  nextWindow.hasUserMessages = true;
  draft.transcript.windowBySession[sessionPath] = nextWindow;
  enforceLoadedWindowBudget(draft, sessionPath);
}

/** Remove a message from the transcript by ID (Immer draft). */
function removeMessage(draft: ArchState, sessionPath: string, messageId: string) {
  const list = draft.transcript.bySession[sessionPath];
  if (!list) return;

  const removedMessage = list.find((m: ChatMessage) => m.id === messageId);
  draft.transcript.bySession[sessionPath] = list.filter((m: ChatMessage) => m.id !== messageId);

  const nextWindow = withDecrementedWindowCounts(draft.transcript.windowBySession[sessionPath]);
  if (nextWindow) {
    const isFullyLoaded =
      !nextWindow.hasOlder
      && !nextWindow.hasNewer
      && nextWindow.loadedStart === 0
      && nextWindow.loadedEnd === nextWindow.totalCount;

    if (
      removedMessage?.role === 'user'
      && isFullyLoaded
      && !draft.transcript.bySession[sessionPath].some((m: ChatMessage) => m.role === 'user')
    ) {
      nextWindow.hasUserMessages = false;
    }

    draft.transcript.windowBySession[sessionPath] = nextWindow;
  }
}

/**
 * Reducer: routes events to per-kind handlers.
 */
export function reducer(state: ArchState, event: Event): ReducerResult {
  switch (event.kind) {
    case 'Command': {
      const { cmd } = event;
      switch (cmd.kind) {
        case 'Interrupt': {
          return {
            state: {
              ...state,
              sessions: {
                ...state.sessions,
                interruptInFlightBySession: {
                  ...state.sessions.interruptInFlightBySession,
                  [cmd.sessionPath]: true,
                },
              },
            },
            effects: [{ kind: 'InterruptRpc', corrId: cmd.corrId, sessionPath: cmd.sessionPath }],
          };
        }

        case 'Send': {
          // Insert optimistic user message directly into transcript state + record pending op
          const nextState = produce(state, (draft) => {
            appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts);
            draft.pending.ops[cmd.corrId] = {
              kind: 'send',
              sessionPath: cmd.sessionPath,
              localId: cmd.localId,
              previousSummary: cmd.previousSummary,
            };
          });

          return {
            state: nextState,
            effects: [
              {
                kind: 'SendRpc',
                corrId: cmd.corrId,
                sessionPath: cmd.sessionPath,
                text: cmd.text,
                inputs: cmd.inputs,
              },
            ],
          };
        }

        case 'Edit': {
          // Insert optimistic edit message directly into transcript state + record pending op
          const nextState = produce(state, (draft) => {
            appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.text, undefined);
            draft.pending.ops[cmd.corrId] = {
              kind: 'edit',
              sessionPath: cmd.sessionPath,
              localId: cmd.localId,
              previousSummary: null,
            };
          });

          return {
            state: nextState,
            effects: [
              {
                kind: 'EditRpc',
                corrId: cmd.corrId,
                sessionPath: cmd.sessionPath,
                messageId: cmd.messageId,
                text: cmd.text,
              },
            ],
          };
        }

        case 'SetModel': {
          return {
            state: {
              ...state,
              settings: {
                ...state.settings,
                modelSettings: cmd.modelSettings,
              },
            },
            effects: [],
          };
        }

        case 'SetPrefs': {
          const current = state.settings.prefs;
          const deepMerged: ChatPrefs = {
            ...current,
            ...cmd.prefs,
            ...(cmd.prefs.extensionToggles && {
              extensionToggles: { ...current.extensionToggles, ...cmd.prefs.extensionToggles },
            }),
            ...(cmd.prefs.providerToggles && {
              providerToggles: { ...current.providerToggles, ...cmd.prefs.providerToggles },
            }),
          };
          return {
            state: {
              ...state,
              settings: {
                ...state.settings,
                prefs: deepMerged,
              },
            },
            effects: [],
          };
        }

        case 'SelectSession': {
          return {
            state: {
              ...state,
              sessions: {
                ...state.sessions,
                activeSessionPath: cmd.sessionPath,
                unreadFinishedSessionPaths: removeFromArray(
                  state.sessions.unreadFinishedSessionPaths,
                  cmd.sessionPath,
                ),
              },
            },
            effects: [],
          };
        }

        case 'CloseTab': {
          return {
            state: {
              ...state,
              sessions: {
                ...state.sessions,
                openTabPaths: removeFromArray(state.sessions.openTabPaths, cmd.sessionPath),
                unreadFinishedSessionPaths: removeFromArray(
                  state.sessions.unreadFinishedSessionPaths,
                  cmd.sessionPath,
                ),
              },
            },
            effects: [],
          };
        }

        case 'ReorderTabs': {
          return {
            state: {
              ...state,
              sessions: {
                ...state.sessions,
                openTabPaths: cmd.openTabPaths,
              },
            },
            effects: [],
          };
        }

        case 'OpenFileDiff': {
          return {
            state,
            effects: [
              {
                kind: 'FileDiff',
                corrId: cmd.corrId,
                sessionPath: cmd.sessionPath,
                filePath: cmd.filePath,
                status: cmd.status,
              },
            ],
          };
        }

        case 'RevertFile': {
          return {
            state,
            effects: [
              {
                kind: 'FileRevert',
                corrId: cmd.corrId,
                sessionPath: cmd.sessionPath,
                filePath: cmd.filePath,
              },
            ],
          };
        }

        case 'ExportAnalytics': {
          return {
            state,
            effects: [
              {
                kind: 'ExportRunAnalytics',
                corrId: cmd.corrId,
                sessionPath: cmd.sessionPath,
              },
            ],
          };
        }

        case 'CloseSession': {
          const sp = cmd.sessionPath;
          const { [sp]: _t, ...remainingTranscripts } = state.transcript.bySession;
          const { [sp]: _sp, ...remainingSystemPrompts } = state.transcript.systemPromptsBySession;
          const { [sp]: _w, ...remainingWindows } = state.transcript.windowBySession;
          const { [sp]: _i, ...remainingInterrupts } = state.sessions.interruptInFlightBySession;
          const { [sp]: _a, ...remainingAnalytics } = state.sessions.analyticsFactorsBySession;
          const { [sp]: _ct, ...remainingTurns } = state.pending.currentTurnBySession;
          const { [sp]: _m, ...remainingModels } = state.settings.availableModelsBySession;
          const { [sp]: _cu, ...remainingContext } = state.settings.contextUsageBySession;
          const { [sp]: _ci, ...remainingComposer } = state.composer.pendingComposerInputsBySession;
          const { [sp]: _rs, ...remainingRunSummaries } = state.composer.activeRunSummaryBySession;
          const { [sp]: _fc, ...remainingFileChanges } = state.fileChanges.bySession;

          const remainingOps: Record<string, PendingOp> = {};
          for (const [corrId, op] of Object.entries(state.pending.ops)) {
            if (op.sessionPath !== sp) remainingOps[corrId] = op;
          }

          return {
            state: {
              ...state,
              transcript: {
                ...state.transcript,
                bySession: remainingTranscripts,
                systemPromptsBySession: remainingSystemPrompts,
                windowBySession: remainingWindows,
              },
              sessions: {
                ...state.sessions,
                interruptInFlightBySession: remainingInterrupts,
                analyticsFactorsBySession: remainingAnalytics,
                runningSessionPaths: removeFromArray(state.sessions.runningSessionPaths, sp),
                unreadFinishedSessionPaths: removeFromArray(state.sessions.unreadFinishedSessionPaths, sp),
                openTabPaths: removeFromArray(state.sessions.openTabPaths, sp),
                activeSessionPath: state.sessions.activeSessionPath === sp ? null : state.sessions.activeSessionPath,
              },
              settings: {
                ...state.settings,
                availableModelsBySession: remainingModels,
                contextUsageBySession: remainingContext,
              },
              composer: {
                ...state.composer,
                pendingComposerInputsBySession: remainingComposer,
                activeRunSummaryBySession: remainingRunSummaries,
              },
              fileChanges: {
                ...state.fileChanges,
                bySession: remainingFileChanges,
              },
              pending: {
                ...state.pending,
                ops: remainingOps,
                currentTurnBySession: remainingTurns,
              },
            },
            effects: [],
          };
        }

        case 'PersistTabs': {
          return {
            state,
            effects: [
              {
                kind: 'PersistTabs',
                corrId: cmd.corrId,
                openTabPaths: cmd.openTabPaths,
                activeSessionPath: cmd.activeSessionPath,
              },
            ],
          };
        }

        case 'AddComposerInput': {
          const input: ComposerInput = { ...cmd.input, id: `${cmd.corrId}:input` } as ComposerInput;
          const existing = state.composer.pendingComposerInputsBySession[cmd.sessionPath] ?? [];
          return {
            state: {
              ...state,
              composer: {
                ...state.composer,
                pendingComposerInputsBySession: {
                  ...state.composer.pendingComposerInputsBySession,
                  [cmd.sessionPath]: [...existing, input],
                },
              },
            },
            effects: [],
          };
        }

        case 'RemoveComposerInput': {
          const existing = state.composer.pendingComposerInputsBySession[cmd.sessionPath] ?? [];
          return {
            state: {
              ...state,
              composer: {
                ...state.composer,
                pendingComposerInputsBySession: {
                  ...state.composer.pendingComposerInputsBySession,
                  [cmd.sessionPath]: existing.filter((inp) => inp.id !== cmd.inputId),
                },
              },
            },
            effects: [],
          };
        }

        default:
          return { state, effects: [] };
      }
    }

    case 'InterruptResult': {
      let nextState = state;
      const effects: Effect[] = [];

      if (!event.ok) {
        effects.push({
          kind: 'Log',
          corrId: event.corrId,
          level: 'error',
          message: `Interrupt failed for session ${event.sessionPath}`,
          data: { error: event.error },
        });
      }

      // Directly update running state and clear interrupt flag
      nextState = produce(nextState, (draft) => {
        draft.sessions.interruptInFlightBySession[event.sessionPath] = false;
        if (event.ok) {
          draft.sessions.runningSessionPaths = draft.sessions.runningSessionPaths.filter(
            (p: string) => p !== event.sessionPath,
          );
        }
      });

      return { state: nextState, effects };
    }

    case 'SendResult': {
      const pending = state.pending.ops[event.corrId];
      if (!pending) return { state, effects: [] };

      const { [event.corrId]: _removed, ...restOps } = state.pending.ops;

      if (event.ok) {
        // Success: clear composer inputs directly + remove pending op
        const nextState = produce(state, (draft) => {
          draft.pending.ops = restOps;
          delete draft.composer.pendingComposerInputsBySession[pending.sessionPath];
        });
        return { state: nextState, effects: [] };
      }

      // Failure: rollback optimistic message, notify user, restore session name
      const effects: Effect[] = [
        {
          kind: 'PostImperative',
          corrId: event.corrId,
          imperativeMessage: { type: 'sendRejected', sessionPath: pending.sessionPath, localId: pending.localId },
        },
      ];

      const nextState = produce(state, (draft) => {
        draft.pending.ops = restOps;
        // Remove optimistic message from transcript
        removeMessage(draft, pending.sessionPath, pending.localId);
        // Set notice
        draft.settings.notice = `Failed to send message: ${event.error ?? 'unknown error'}`;
        // Restore session summary if we had one
        if (pending.previousSummary) {
          const idx = draft.sessions.sessions.findIndex((s) => s.path === pending.previousSummary!.path);
          if (idx >= 0) {
            draft.sessions.sessions[idx] = pending.previousSummary;
          } else {
            draft.sessions.sessions.push(pending.previousSummary);
          }
        }
      });

      return { state: nextState, effects };
    }

    case 'EditResult': {
      const pending = state.pending.ops[event.corrId];
      if (!pending) return { state, effects: [] };

      const { [event.corrId]: _removed, ...restOps } = state.pending.ops;

      if (event.ok) {
        const nextState = {
          ...state,
          pending: { ...state.pending, ops: restOps },
        };
        return { state: nextState, effects: [] };
      }

      // Failure: rollback the optimistic edit message + notify user
      const effects: Effect[] = [];

      const nextState = produce(state, (draft) => {
        draft.pending.ops = restOps;
        removeMessage(draft, pending.sessionPath, pending.localId);
        draft.settings.notice = `Failed to edit message: ${event.error ?? 'unknown error'}`;
      });

      return { state: nextState, effects };
    }

    // ─── Backend streaming events ─────────────────────────────────────────

    case 'MessageStarted': {
      const { sessionPath, messageId, requestId, modelId, thinkingLevel } = event;
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
              createdAt: new Date().toISOString(),
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

    case 'MessageAborted': {
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

    case 'MessageDelta': {
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

    case 'MessageThinking': {
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

    case 'ToolCall': {
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

    case 'MessageFinished': {
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

    case 'SessionClosed': {
      const sp = event.sessionPath;
      const { [sp]: _droppedTranscript, ...remainingTranscripts } = state.transcript.bySession;
      const { [sp]: _droppedSystemPrompts, ...remainingSystemPrompts } = state.transcript.systemPromptsBySession;
      const { [sp]: _droppedWindow, ...remainingWindows } = state.transcript.windowBySession;
      const { [sp]: _droppedInterrupt, ...remainingInterrupts } = state.sessions.interruptInFlightBySession;
      const { [sp]: _droppedAnalytics, ...remainingAnalytics } = state.sessions.analyticsFactorsBySession;
      const { [sp]: _droppedTurn, ...remainingTurns } = state.pending.currentTurnBySession;
      const { [sp]: _droppedModels, ...remainingModels } = state.settings.availableModelsBySession;
      const { [sp]: _droppedContext, ...remainingContext } = state.settings.contextUsageBySession;
      const { [sp]: _droppedComposer, ...remainingComposer } = state.composer.pendingComposerInputsBySession;
      const { [sp]: _droppedRunSummaries, ...remainingRunSummaries } = state.composer.activeRunSummaryBySession;
      const { [sp]: _droppedFileChanges, ...remainingFileChanges } = state.fileChanges.bySession;

      const remainingOps: Record<string, PendingOp> = {};
      for (const [corrId, op] of Object.entries(state.pending.ops)) {
        if (op.sessionPath !== sp) remainingOps[corrId] = op;
      }

      return {
        state: {
          ...state,
          transcript: {
            ...state.transcript,
            bySession: remainingTranscripts,
            systemPromptsBySession: remainingSystemPrompts,
            windowBySession: remainingWindows,
          },
          sessions: {
            ...state.sessions,
            interruptInFlightBySession: remainingInterrupts,
            analyticsFactorsBySession: remainingAnalytics,
            runningSessionPaths: removeFromArray(state.sessions.runningSessionPaths, sp),
            unreadFinishedSessionPaths: removeFromArray(state.sessions.unreadFinishedSessionPaths, sp),
            openTabPaths: removeFromArray(state.sessions.openTabPaths, sp),
            activeSessionPath: state.sessions.activeSessionPath === sp ? null : state.sessions.activeSessionPath,
          },
          settings: {
            ...state.settings,
            availableModelsBySession: remainingModels,
            contextUsageBySession: remainingContext,
          },
          composer: {
            ...state.composer,
            pendingComposerInputsBySession: remainingComposer,
            activeRunSummaryBySession: remainingRunSummaries,
          },
          fileChanges: {
            ...state.fileChanges,
            bySession: remainingFileChanges,
          },
          pending: {
            ...state.pending,
            ops: remainingOps,
            currentTurnBySession: remainingTurns,
          },
        },
        effects: [],
      };
    }

    case 'BusyChanged': {
      if (event.running) {
        return {
          state: {
            ...state,
            sessions: {
              ...state.sessions,
              runningSessionPaths: addToArray(state.sessions.runningSessionPaths, event.sessionPath),
            },
          },
          effects: [],
        };
      }
      return {
        state: {
          ...state,
          sessions: {
            ...state.sessions,
            runningSessionPaths: removeFromArray(state.sessions.runningSessionPaths, event.sessionPath),
            unreadFinishedSessionPaths: addToArray(
              state.sessions.unreadFinishedSessionPaths,
              event.sessionPath,
            ),
          },
        },
        effects: [],
      };
    }

    case 'BusyCompleted': {
      return { state, effects: [] };
    }

    case 'ContextUsageChanged': {
      return {
        state: {
          ...state,
          settings: {
            ...state.settings,
            contextUsageBySession: {
              ...state.settings.contextUsageBySession,
              [event.sessionPath]: event.contextUsage,
            },
          },
        },
        effects: [],
      };
    }

    case 'SessionListChanged': {
      return {
        state: {
          ...state,
          sessions: {
            ...state.sessions,
            sessions: event.sessionSummaries,
          },
        },
        effects: [],
      };
    }

    case 'CustomMessage': {
      const existing = state.transcript.bySession[event.sessionPath] ?? [];
      return {
        state: {
          ...state,
          transcript: {
            ...state.transcript,
            bySession: {
              ...state.transcript.bySession,
              [event.sessionPath]: upsertTranscriptMessage(existing, event.message),
            },
          },
        },
        effects: [],
      };
    }

    case 'ExtensionUIRequest': {
      return {
        state: {
          ...state,
          settings: {
            ...state.settings,
            pendingExtensionUIRequest: event.request,
          },
        },
        effects: [],
      };
    }

    case 'Error': {
      return {
        state: {
          ...state,
          settings: {
            ...state.settings,
            notice: event.error,
          },
        },
        effects: [],
      };
    }

    case 'SessionOpened': {
      const { sessionPath, payload } = event;
      let next: ArchState = state;

      // Sessions: running state, backend ready, upsert summary
      const nextRunningSessionPaths = payload.busy
        ? addToArray(state.sessions.runningSessionPaths, sessionPath)
        : state.sessions.runningSessionPaths;

      next = {
        ...next,
        sessions: {
          ...next.sessions,
          runningSessionPaths: nextRunningSessionPaths,
          sessions: upsertSessionSummary(next.sessions.sessions, payload.session),
          ...(payload.analyticsFactors && {
            analyticsFactorsBySession: {
              ...next.sessions.analyticsFactorsBySession,
              [sessionPath]: payload.analyticsFactors,
            },
          }),
        },
        settings: {
          ...next.settings,
          backendReady: true,
          ...(payload.availableModels && {
            availableModelsBySession: {
              ...next.settings.availableModelsBySession,
              [sessionPath]: payload.availableModels,
            },
          }),
          ...(payload.modelSettings && {
            modelSettings: payload.modelSettings,
          }),
          ...(payload.contextUsage !== undefined && {
            contextUsageBySession: {
              ...next.settings.contextUsageBySession,
              [sessionPath]: payload.contextUsage,
            },
          }),
        },
        transcript: {
          ...next.transcript,
          bySession: {
            ...next.transcript.bySession,
            [sessionPath]: payload.transcript,
          },
          windowBySession: {
            ...next.transcript.windowBySession,
            [sessionPath]: payload.transcriptWindow,
          },
          ...(payload.systemPrompts && {
            systemPromptsBySession: {
              ...next.transcript.systemPromptsBySession,
              [sessionPath]: payload.systemPrompts,
            },
          }),
        },
      };

      return { state: next, effects: [] };
    }

    case 'TruncateResult': {
      return { state, effects: [] };
    }

    case 'CreateSessionResult': {
      return { state, effects: [] };
    }

    case 'OpenSessionResult': {
      return { state, effects: [] };
    }

    case 'PersistTabsResult': {
      return { state, effects: [] };
    }

    default:
      return { state, effects: [] };
  }
}