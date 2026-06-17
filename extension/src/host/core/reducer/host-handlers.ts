import { produce } from 'immer';

import type { ArchState, SetModelPending } from '../arch-state.js';
import type {
  BackendReadyChangedEvent,
  PruningSettingsChangedEvent,
  WorkspaceCwdChangedEvent,
  TranscriptPageLoadedEvent,
  FileChangesUpdatedEvent,
  ActiveRunSummaryChangedEvent,
  SessionMetadataChangedEvent,
  AvailableModelsChangedEvent,
  PendingExtensionUIRequestsClearedEvent,
  AnalyticsFactorsChangedEvent,
  AvailableExtensionsChangedEvent,
  AssistantMessageErrorStampedEvent,
  ComposerInputsReplacedEvent,
  PendingPathReplacedEvent,
  TranscriptTrimmedEvent,
  RunningSessionsChangedEvent,
  UnreadFinishedSessionsChangedEvent,
  SessionSummaryUpsertedEvent,
  SessionSummariesReplacedEvent,
  SessionScopeClearedEvent,
  TabOpenedEvent,
  OpenTabsChangedEvent,
} from '../events.js';
import type { ReducerResult } from './helpers.js';
import { removeFromArray } from './helpers.js';
import type { SessionSummary } from '../../../shared/protocol.js';

function mergeSessionSummary(
  existing: SessionSummary | undefined,
  incoming: SessionSummary,
): SessionSummary {
  if (!existing) return incoming;
  const keepExistingName = !existing.isPlaceholder && incoming.isPlaceholder === true;
  return {
    ...incoming,
    name: keepExistingName ? existing.name : incoming.name,
    isPlaceholder: keepExistingName ? false : incoming.isPlaceholder,
    modelId: incoming.modelId ?? existing.modelId,
    thinkingLevel: incoming.thinkingLevel ?? existing.thinkingLevel,
  };
}

export function handleBackendReadyChanged(
  state: ArchState,
  event: BackendReadyChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        backendReady: event.ready,
      },
    },
    effects: [],
  };
}

export function handlePruningSettingsChanged(
  state: ArchState,
  event: PruningSettingsChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        pruningSettings: event.pruningSettings,
      },
    },
    effects: [],
  };
}

export function handleWorkspaceCwdChanged(
  state: ArchState,
  event: WorkspaceCwdChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        workspaceCwd: event.workspaceCwd,
      },
    },
    effects: [],
  };
}

export function handleTranscriptPageLoaded(
  state: ArchState,
  event: TranscriptPageLoadedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      transcript: {
        ...state.transcript,
        bySession: {
          ...state.transcript.bySession,
          [event.sessionPath]: event.transcript,
        },
        windowBySession: {
          ...state.transcript.windowBySession,
          [event.sessionPath]: event.transcriptWindow,
        },
      },
    },
    effects: [],
  };
}

export function handleFileChangesUpdated(
  state: ArchState,
  event: FileChangesUpdatedEvent,
): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.fileChanges.bySession[event.sessionPath] = event.fileChanges;
    }),
    effects: [],
  };
}

export function handleActiveRunSummaryChanged(
  state: ArchState,
  event: ActiveRunSummaryChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      composer: {
        ...state.composer,
        activeRunSummaryBySession: {
          ...state.composer.activeRunSummaryBySession,
          [event.sessionPath]: event.summary,
        },
      },
    },
    effects: [],
  };
}

export function handleSessionMetadataChanged(
  state: ArchState,
  event: SessionMetadataChangedEvent,
): ReducerResult {
  const nextSessions = state.sessions.sessions.map((s) => {
    if (s.path !== event.sessionPath) return s;
    return {
      ...s,
      ...(event.modelId !== undefined && { modelId: event.modelId }),
      ...(event.thinkingLevel !== undefined && { thinkingLevel: event.thinkingLevel }),
    };
  });
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        sessions: nextSessions,
      },
    },
    effects: [],
  };
}

export function handleAvailableModelsChanged(
  state: ArchState,
  event: AvailableModelsChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        availableModelsBySession: {
          ...state.settings.availableModelsBySession,
          [event.sessionPath]: event.models,
        },
      },
    },
    effects: [],
  };
}

export function handlePendingExtensionUIRequestsCleared(
  state: ArchState,
  event: PendingExtensionUIRequestsClearedEvent,
): ReducerResult {
  const { [event.sessionPath]: _removed, ...remaining } = state.settings.pendingExtensionUIRequestsBySession;
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        pendingExtensionUIRequestsBySession: remaining,
      },
    },
    effects: [],
  };
}

export function handleAnalyticsFactorsChanged(
  state: ArchState,
  event: AnalyticsFactorsChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        analyticsFactorsBySession: {
          ...state.sessions.analyticsFactorsBySession,
          [event.sessionPath]: event.factors,
        },
      },
    },
    effects: [],
  };
}

export function handleAvailableExtensionsChanged(
  state: ArchState,
  event: AvailableExtensionsChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        availableExtensions: event.extensions,
      },
    },
    effects: [],
  };
}

export function handleAssistantMessageErrorStamped(
  state: ArchState,
  event: AssistantMessageErrorStampedEvent,
): ReducerResult {
  return {
    state: produce(state, (draft) => {
      const list = draft.transcript.bySession[event.sessionPath];
      if (!list) return;
      const reversed = [...list].reverse();
      const msg = reversed.find(
        (m) => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'error'),
      ) ?? reversed.find((m) => m.role === 'assistant');
      if (msg) {
        msg.status = 'error';
        msg.errorDetail = event.errorMessage;
      }
    }),
    effects: [],
  };
}

export function handleComposerInputsReplaced(
  state: ArchState,
  event: ComposerInputsReplacedEvent,
): ReducerResult {
  const next = { ...state.composer.pendingComposerInputsBySession };
  if (event.inputs === null || event.inputs.length === 0) {
    delete next[event.sessionPath];
  } else {
    next[event.sessionPath] = event.inputs;
  }
  return {
    state: {
      ...state,
      composer: {
        ...state.composer,
        pendingComposerInputsBySession: next,
      },
    },
    effects: [],
  };
}

export function handlePendingPathReplaced(
  state: ArchState,
  event: PendingPathReplacedEvent,
): ReducerResult {
  const { oldPendingPath, newSessionPath } = event;
  // Read the queued sends BEFORE the produce draft (we need them for the
  // effect; the draft will clear the key).
  const queuedSends = state.pending.sendQueueBySession[oldPendingPath] ?? [];

  const nextState = produce(state, (draft) => {
    // Replace in openTabPaths
    draft.sessions.openTabPaths = draft.sessions.openTabPaths.map(
      (p: string) => (p === oldPendingPath ? newSessionPath : p),
    );

    // Replace in unreadFinishedSessionPaths (dedupe)
    draft.sessions.unreadFinishedSessionPaths = [
      ...new Set(draft.sessions.unreadFinishedSessionPaths.map(
        (p: string) => (p === oldPendingPath ? newSessionPath : p),
      )),
    ];

    // Move composer inputs
    const oldInputs = draft.composer.pendingComposerInputsBySession[oldPendingPath];
    if (oldInputs) {
      const existingInputs = draft.composer.pendingComposerInputsBySession[newSessionPath] ?? [];
      draft.composer.pendingComposerInputsBySession[newSessionPath] = [...existingInputs, ...oldInputs];
      delete draft.composer.pendingComposerInputsBySession[oldPendingPath];
    }

    // Move activeRunSummary
    if (Object.prototype.hasOwnProperty.call(draft.composer.activeRunSummaryBySession, oldPendingPath)) {
      draft.composer.activeRunSummaryBySession[newSessionPath] =
        draft.composer.activeRunSummaryBySession[oldPendingPath] ?? null;
      delete draft.composer.activeRunSummaryBySession[oldPendingPath];
    }

    // Move analyticsFactors
    if (Object.prototype.hasOwnProperty.call(draft.sessions.analyticsFactorsBySession, oldPendingPath)) {
      draft.sessions.analyticsFactorsBySession[newSessionPath] =
        draft.sessions.analyticsFactorsBySession[oldPendingPath] ?? null;
      delete draft.sessions.analyticsFactorsBySession[oldPendingPath];
    }

    // Clear the pending send queue for the old path — the entries are emitted
    // as a DrainPendingSendQueue effect below; the runner re-dispatches them as
    // Send Commands with the resolved path.
    delete draft.pending.sendQueueBySession[oldPendingPath];
  });

  // Emit a DrainPendingSendQueue effect iff there are queued sends. The runner
  // executes this asynchronously (via void (async () => ...)()), so the
  // re-dispatched Send Commands land AFTER the synchronous SessionScopeCleared
  // + SessionOpened + SelectSession events that follow PendingPathReplaced in
  // the handlePendingPathReplacement flow — preserving the clear-then-reinsert
  // ordering of the old drainPendingSendQueue callback.
  const effects = queuedSends.length > 0
    ? [{ kind: 'DrainPendingSendQueue' as const, corrId: `drain:${oldPendingPath}`, resolvedSessionPath: newSessionPath, entries: queuedSends }]
    : [];

  return { state: nextState, effects };
}

export function handleTranscriptTrimmed(
  state: ArchState,
  event: TranscriptTrimmedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      transcript: {
        ...state.transcript,
        bySession: {
          ...state.transcript.bySession,
          [event.sessionPath]: event.transcript,
        },
        windowBySession: {
          ...state.transcript.windowBySession,
          [event.sessionPath]: event.transcriptWindow,
        },
      },
    },
    effects: [],
  };
}

export function handleRunningSessionsChanged(
  state: ArchState,
  event: RunningSessionsChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        runningSessionPaths: event.sessionPaths,
      },
    },
    effects: [],
  };
}

export function handleUnreadFinishedSessionsChanged(
  state: ArchState,
  event: UnreadFinishedSessionsChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        unreadFinishedSessionPaths: event.sessionPaths,
      },
    },
    effects: [],
  };
}

export function handleSessionSummaryUpserted(
  state: ArchState,
  event: SessionSummaryUpsertedEvent,
): ReducerResult {
  const nextSessions = [...state.sessions.sessions];
  const idx = nextSessions.findIndex((s) => s.path === event.summary.path);
  if (idx === -1) {
    nextSessions.unshift(event.summary);
  } else {
    const existing = nextSessions[idx];
    const keepExistingName = !existing.isPlaceholder && event.summary.isPlaceholder === true;
    nextSessions[idx] = {
      ...event.summary,
      name: keepExistingName ? existing.name : event.summary.name,
      isPlaceholder: keepExistingName ? false : event.summary.isPlaceholder,
      modelId: event.summary.modelId ?? existing.modelId,
      thinkingLevel: event.summary.thinkingLevel ?? existing.thinkingLevel,
    };
  }
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        sessions: nextSessions,
      },
    },
    effects: [],
  };
}

export function handleSessionSummariesReplaced(
  state: ArchState,
  event: SessionSummariesReplacedEvent,
): ReducerResult {
  return {
    state: produce(state, (draft) => {
      const mergedByPath = new Map<string, SessionSummary>();
      for (const item of event.summaries) {
        const existing = mergedByPath.get(item.path) ?? draft.sessions.sessions.find((s) => s.path === item.path);
        mergedByPath.set(item.path, mergeSessionSummary(existing, item));
      }
      for (const s of draft.sessions.sessions) {
        if (!mergedByPath.has(s.path) && draft.sessions.openTabPaths.includes(s.path)) {
          mergedByPath.set(s.path, s);
        }
      }
      const activeSession = draft.sessions.activeSessionPath
        ? draft.sessions.sessions.find((session) => session.path === draft.sessions.activeSessionPath)
        : undefined;
      draft.sessions.sessions = [...mergedByPath.values()];
      if (activeSession && !mergedByPath.has(activeSession.path) && draft.sessions.openTabPaths.includes(activeSession.path)) {
        draft.sessions.sessions.push(activeSession);
      }
    }),
    effects: [],
  };
}

export function handleSessionScopeCleared(
  state: ArchState,
  event: SessionScopeClearedEvent,
): ReducerResult {
  const sp = event.sessionPath;
  const { [sp]: _t, ...remainingTranscripts } = state.transcript.bySession;
  const { [sp]: _sp, ...remainingSystemPrompts } = state.transcript.systemPromptsBySession;
  const { [sp]: _w, ...remainingWindows } = state.transcript.windowBySession;
  const { [sp]: _pf, ...remainingPagingInFlight } = state.transcript.pagingInFlightBySession;
  const { [sp]: _m, ...remainingModels } = state.settings.availableModelsBySession;
  const { [sp]: _cu, ...remainingContext } = state.settings.contextUsageBySession;
  const { [sp]: _eui, ...remainingExtUI } = state.settings.pendingExtensionUIRequestsBySession;
  const { [sp]: _ci, ...remainingComposer } = state.composer.pendingComposerInputsBySession;
  const { [sp]: _rs, ...remainingRunSummaries } = state.composer.activeRunSummaryBySession;
  const { [sp]: _fc, ...remainingFileChanges } = state.fileChanges.bySession;
  const { [sp]: _af, ...remainingAnalytics } = state.sessions.analyticsFactorsBySession;
  const { [sp]: _psq, ...remainingPendingSendQueue } = state.pending.sendQueueBySession;
  // Drop in-flight setModel lifecycles for the closed session (both the
  // modal-confirm phase and the RPC phase). A late ModelSwitchConfirmResult /
  // SetModelResult for these corrIds then no-ops instead of applying to — or
  // reverting into — a closed session. Mirrors the pagingInFlight clear above
  // (handoff pattern #8).
  const remainingSetModel: Record<string, SetModelPending> = {};
  for (const [corrId, entry] of Object.entries(state.pending.setModelByCorrId)) {
    if (entry.sessionPath !== sp) remainingSetModel[corrId] = entry;
  }

  let nextSessions = state.sessions.sessions;
  let nextOpenTabPaths = state.sessions.openTabPaths;
  let nextRunningPaths = state.sessions.runningSessionPaths;
  let nextUnreadPaths = state.sessions.unreadFinishedSessionPaths;
  let nextActivePath = state.sessions.activeSessionPath;

  if (event.removeSessionSummary) {
    nextSessions = nextSessions.filter((s) => s.path !== sp);
    nextOpenTabPaths = removeFromArray(nextOpenTabPaths, sp);
    nextRunningPaths = removeFromArray(nextRunningPaths, sp);
    nextUnreadPaths = removeFromArray(nextUnreadPaths, sp);
    if (nextActivePath === sp) {
      nextActivePath = null;
    }
  }

  return {
    state: {
      ...state,
      transcript: {
        ...state.transcript,
        bySession: remainingTranscripts,
        systemPromptsBySession: remainingSystemPrompts,
        windowBySession: remainingWindows,
        pagingInFlightBySession: remainingPagingInFlight,
      },
      sessions: {
        ...state.sessions,
        sessions: nextSessions,
        openTabPaths: nextOpenTabPaths,
        runningSessionPaths: nextRunningPaths,
        unreadFinishedSessionPaths: nextUnreadPaths,
        activeSessionPath: nextActivePath,
        analyticsFactorsBySession: remainingAnalytics,
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
        setModelByCorrId: remainingSetModel,
        sendQueueBySession: remainingPendingSendQueue,
      },
    },
    effects: [],
  };
}

export function handleTabOpened(
  state: ArchState,
  event: TabOpenedEvent,
): ReducerResult {
  if (state.sessions.openTabPaths.includes(event.sessionPath)) {
    return { state, effects: [] };
  }
  const nextOpenTabPaths = event.insertAfter
    ? (() => {
        const afterIndex = state.sessions.openTabPaths.indexOf(event.insertAfter);
        if (afterIndex === -1) {
          return [...state.sessions.openTabPaths, event.sessionPath];
        }
        return [
          ...state.sessions.openTabPaths.slice(0, afterIndex + 1),
          event.sessionPath,
          ...state.sessions.openTabPaths.slice(afterIndex + 1),
        ];
      })()
    : [...state.sessions.openTabPaths, event.sessionPath];
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths: nextOpenTabPaths,
      },
    },
    effects: [],
  };
}

export function handleOpenTabsChanged(
  state: ArchState,
  event: OpenTabsChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths: event.openTabPaths,
        unreadFinishedSessionPaths: state.sessions.unreadFinishedSessionPaths.filter((p) =>
          event.openTabPaths.includes(p),
        ),
      },
    },
    effects: [],
  };
}
