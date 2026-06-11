import type { ArchState, PendingOp } from '../arch-state.js';
import type { ChatMessage, SessionSummary, UserContentPart } from '../../../shared/protocol.js';
import { markdownFromUserParts } from '../transcript-helpers.js';
import {
  buildFullTranscriptWindow,
  cullTranscriptWindowAroundActiveTurn,
  withIncrementedWindowCounts,
  withDecrementedWindowCounts,
} from '../transcript-window.js';
import { TRANSCRIPT_WINDOW_BUDGETS } from '../../../shared/transcript-window.js';
import type { Effect } from '../effects.js';

// Re-export from arch-state for downstream consumers
export type { ArchState, PendingOp, CurrentTurn } from '../arch-state.js';
export { createInitialArchState } from '../arch-state.js';
import { createInitialArchState } from '../arch-state.js';

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
export function resolveAlias(state: ArchState, id: string): string {
  return state.pending.messageIdAlias[id] ?? id;
}

/** Upsert a ChatMessage in a session's transcript array. */
export function upsertTranscriptMessage(messages: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx >= 0) {
    const copy = [...messages];
    copy[idx] = message;
    return copy;
  }
  return [...messages, message];
}

/** Upsert a session summary in the sessions array. */
export function upsertSessionSummary(
  list: readonly SessionSummary[],
  summary: SessionSummary,
): SessionSummary[] {
  const idx = list.findIndex((s) => s.path === summary.path);
  if (idx >= 0) {
    const copy = [...list];
    copy[idx] = summary;
    return copy;
  }
  return [...list, summary];
}

/** Filter a string array, removing one element. */
export function removeFromArray(arr: readonly string[], value: string): string[] {
  return arr.filter((p) => p !== value);
}

/** Add to an array if not already present. */
export function addToArray(arr: readonly string[], value: string): string[] {
  return arr.includes(value) ? [...arr] : [...arr, value];
}

/** Remove all per-session state for a given sessionPath. */
export function removeSessionFromState(state: ArchState, sessionPath: string): ReducerResult {
  const sp = sessionPath;
  const { [sp]: _t, ...remainingTranscripts } = state.transcript.bySession;
  const { [sp]: _sp, ...remainingSystemPrompts } = state.transcript.systemPromptsBySession;
  const { [sp]: _w, ...remainingWindows } = state.transcript.windowBySession;
  const { [sp]: _i, ...remainingInterrupts } = state.sessions.interruptInFlightBySession;
  const { [sp]: _a, ...remainingAnalytics } = state.sessions.analyticsFactorsBySession;
  const { [sp]: _ct, ...remainingTurns } = state.pending.currentTurnBySession;
  const { [sp]: _m, ...remainingModels } = state.settings.availableModelsBySession;
  const { [sp]: _cu, ...remainingContext } = state.settings.contextUsageBySession;
  const { [sp]: _eui, ...remainingExtUI } = state.settings.pendingExtensionUIRequestsBySession;
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
        pendingExtensionUIRequestsBySession: remainingExtUI,
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

// ─── Immer-based transcript mutation helpers ─────────────────────────────────

/** Ensure a session window exists, creating a default if missing. */
export function ensureSessionWindow(draft: ArchState, sessionPath: string) {
  if (!draft.transcript.windowBySession[sessionPath]) {
    draft.transcript.windowBySession[sessionPath] = buildFullTranscriptWindow(
      draft.transcript.bySession[sessionPath] ?? [],
    );
  }
  return draft.transcript.windowBySession[sessionPath];
}

/** Enforce the loaded-window budget by culling old messages if needed. */
export function enforceLoadedWindowBudget(draft: ArchState, sessionPath: string) {
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
export function appendLocalUserMessage(
  draft: ArchState,
  sessionPath: string,
  id: string,
  text: string,
  userParts: UserContentPart[] | undefined,
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
export function removeMessage(draft: ArchState, sessionPath: string, messageId: string) {
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