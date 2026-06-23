import { produce } from 'immer';

import type { ArchState, PendingOp, SetModelPending } from '../arch-state.js';
import type { Effect } from '../effects.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';
import { addToArray, removeFromArray, upsertSessionSummary, removeSessionFromState } from './helpers.js';
import type { SessionSummary } from '../../../shared/protocol.js';
import { reorderOpenTabsPinnedFirst } from '../../../shared/tab-behavior.js';
import { resolveSessionOpenedTranscript } from '../session-opened-transcript.js';

function mergeSessionSummaryPreservingLocalName(
  existing: SessionSummary | undefined,
  incoming: SessionSummary,
): SessionSummary {
  if (!existing) {
    return incoming;
  }

  const keepExistingName = !existing.isPlaceholder && incoming.isPlaceholder === true;
  return {
    ...incoming,
    name: keepExistingName ? existing.name : incoming.name,
    isPlaceholder: keepExistingName ? false : incoming.isPlaceholder,
    modelId: incoming.modelId ?? existing.modelId,
    thinkingLevel: incoming.thinkingLevel ?? existing.thinkingLevel,
  };
}

export function handleSessionClosed(state: ArchState, event: Extract<Event, { kind: 'SessionClosed' }>): ReducerResult {
  return removeSessionFromState(state, event.sessionPath);
}

export function handleSessionListChanged(state: ArchState, event: Extract<Event, { kind: 'SessionListChanged' }>): ReducerResult {
  const mergedByPath = new Map<string, SessionSummary>();

  for (const incoming of event.sessionSummaries) {
    const existing =
      mergedByPath.get(incoming.path)
      ?? state.sessions.sessions.find((session) => session.path === incoming.path);
    mergedByPath.set(incoming.path, mergeSessionSummaryPreservingLocalName(existing, incoming));
  }

  for (const existing of state.sessions.sessions) {
    if (!mergedByPath.has(existing.path) && state.sessions.openTabPaths.includes(existing.path)) {
      mergedByPath.set(existing.path, existing);
    }
  }

  if (state.sessions.activeSessionPath) {
    const activeSession = state.sessions.sessions.find(
      (session) => session.path === state.sessions.activeSessionPath,
    );
    if (activeSession && !mergedByPath.has(activeSession.path)) {
      mergedByPath.set(activeSession.path, activeSession);
    }
  }

  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        sessions: [...mergedByPath.values()],
      },
    },
    effects: [],
  };
}

export function handleSessionOpened(state: ArchState, event: Extract<Event, { kind: 'SessionOpened' }>): ReducerResult {
  const { sessionPath, payload } = event;
  let next: ArchState = state;

  const localTranscript = state.transcript.bySession[sessionPath] ?? [];
  const {
    transcript: resolvedTranscript,
    transcriptWindow: resolvedWindow,
    aliases: resolvedAliases,
  } = resolveSessionOpenedTranscript({
    busy: payload.busy,
    incomingTranscript: payload.transcript,
    incomingTranscriptWindow: payload.transcriptWindow,
    localTranscript,
  });

  // Sessions: running state, backend ready, upsert summary
  const nextRunningSessionPaths = payload.busy
    ? addToArray(state.sessions.runningSessionPaths, sessionPath)
    : state.sessions.runningSessionPaths;

  // Any aliases discovered while merging must be stored so that later
  // backend events carrying the SDK-assigned message id resolve to the
  // streaming row the host kept.
  const nextMessageIdAlias = { ...state.pending.messageIdAlias };
  for (const { aliasId, canonicalId } of resolvedAliases) {
    nextMessageIdAlias[aliasId] = { canonicalId, sessionPath };
  }

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
        [sessionPath]: resolvedTranscript,
      },
      windowBySession: {
        ...next.transcript.windowBySession,
        [sessionPath]: resolvedWindow,
      },
      ...(payload.systemPrompts && {
        systemPromptsBySession: {
          ...next.transcript.systemPromptsBySession,
          [sessionPath]: payload.systemPrompts,
        },
      }),
    },
    pending: {
      ...next.pending,
      messageIdAlias: nextMessageIdAlias,
    },
  };

  return { state: next, effects: [] };
}

export function handleSessionNameDerived(state: ArchState, event: Extract<Event, { kind: 'SessionNameDerived' }>): ReducerResult {
  const nextState = produce(state, (draft) => {
    const s = draft.sessions.sessions.find(x => x.path === event.sessionPath);
    if (s) {
      s.name = event.name;
      s.isPlaceholder = false;
    }
  });
  return { state: nextState, effects: [] };
}

export function handleBusyChanged(state: ArchState, event: Extract<Event, { kind: 'BusyChanged' }>): ReducerResult {
  if (event.running) {
    return {
      state: {
        ...state,
        sessions: {
          ...state.sessions,
          runningSessionPaths: addToArray(state.sessions.runningSessionPaths, event.sessionPath),
          unreadFinishedSessionPaths: removeFromArray(
            state.sessions.unreadFinishedSessionPaths,
            event.sessionPath,
          ),
        },
      },
      effects: [],
    };
  }

  const wasRunning = state.sessions.runningSessionPaths.includes(event.sessionPath);

  if (!wasRunning) {
    return {
      state: {
        ...state,
        sessions: {
          ...state.sessions,
          runningSessionPaths: removeFromArray(state.sessions.runningSessionPaths, event.sessionPath),
        },
      },
      effects: [],
    };
  }

  const isActive = state.sessions.activeSessionPath === event.sessionPath;

  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        runningSessionPaths: removeFromArray(state.sessions.runningSessionPaths, event.sessionPath),
        ...(isActive
          ? {}
          : {
              unreadFinishedSessionPaths: addToArray(
                state.sessions.unreadFinishedSessionPaths,
                event.sessionPath,
              ),
            }),
      },
    },
    effects: [],
  };
}

export function handleBusyCompleted(state: ArchState, _event: Extract<Event, { kind: 'BusyCompleted' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleContextUsageChanged(state: ArchState, event: Extract<Event, { kind: 'ContextUsageChanged' }>): ReducerResult {
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

export function handleSessionMetadataChanged(state: ArchState, event: Extract<Event, { kind: 'SessionMetadataChanged' }>): ReducerResult {
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

export function handleRunningSessionsChanged(state: ArchState, event: Extract<Event, { kind: 'RunningSessionsChanged' }>): ReducerResult {
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

export function handleUnreadFinishedSessionsChanged(state: ArchState, event: Extract<Event, { kind: 'UnreadFinishedSessionsChanged' }>): ReducerResult {
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

export function handleSessionSummaryUpserted(state: ArchState, event: Extract<Event, { kind: 'SessionSummaryUpserted' }>): ReducerResult {
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

export function handleSessionSummariesReplaced(state: ArchState, event: Extract<Event, { kind: 'SessionSummariesReplaced' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      const mergedByPath = new Map<string, SessionSummary>();
      for (const item of event.summaries) {
        const existing = mergedByPath.get(item.path) ?? draft.sessions.sessions.find((s) => s.path === item.path);
        mergedByPath.set(item.path, mergeSessionSummaryPreservingLocalName(existing, item));
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

export function handleSessionScopeCleared(state: ArchState, event: Extract<Event, { kind: 'SessionScopeCleared' }>): ReducerResult {
  const sp = event.sessionPath;
  const { [sp]: _t, ...remainingTranscripts } = state.transcript.bySession;
  const { [sp]: _sp, ...remainingSystemPrompts } = state.transcript.systemPromptsBySession;
  const { [sp]: _w, ...remainingWindows } = state.transcript.windowBySession;
  const { [sp]: _pf, ...remainingPagingInFlight } = state.transcript.pagingInFlightBySession;
  const { [sp]: _ed, ...remainingEditing } = state.transcript.editingMessageIdBySession;
  const { [sp]: _m, ...remainingModels } = state.settings.availableModelsBySession;
  const { [sp]: _cu, ...remainingContext } = state.settings.contextUsageBySession;
  const { [sp]: _eui, ...remainingExtUI } = state.settings.pendingExtensionUIRequestsBySession;
  const { [sp]: _od, ...remainingOutcome } = state.settings.showOutcomeDialogBySession;
  const { [sp]: _ci, ...remainingComposer } = state.composer.pendingComposerInputsBySession;
  const { [sp]: _rs, ...remainingRunSummaries } = state.composer.activeRunSummaryBySession;
  const { [sp]: _fc, ...remainingFileChanges } = state.fileChanges.bySession;
  const { [sp]: _af, ...remainingAnalytics } = state.sessions.analyticsFactorsBySession;
  const { [sp]: _if, ...remainingInterrupts } = state.sessions.interruptInFlightBySession;
  const { [sp]: _psq, ...remainingPendingSendQueue } = state.pending.sendQueueBySession;
  const { [sp]: _brq, ...remainingBackendReadyQueue } = state.pending.backendReadyQueueBySession;
  const { [sp]: _ct, ...remainingTurns } = state.pending.currentTurnBySession;
  // If the closed session had backend-ready-queued sends and no other sessions
  // have entries, cancel the watchdog timer (the queue is now empty).
  const hadBackendReadyEntries = !!state.pending.backendReadyQueueBySession[sp]?.length;
  const backendReadyQueueNowEmpty = Object.keys(remainingBackendReadyQueue).length === 0;
  // Drop in-flight setModel lifecycles for the closed session (both the
  // modal-confirm phase and the RPC phase). A late ModelSwitchConfirmResult /
  // SetModelResult for these corrIds then no-ops instead of applying to — or
  // reverting into — a closed session. Mirrors the pagingInFlight clear above
  // (handoff pattern #8).
  const remainingSetModel: Record<string, SetModelPending> = {};
  for (const [corrId, entry] of Object.entries(state.pending.setModelByCorrId)) {
    if (entry.sessionPath !== sp) remainingSetModel[corrId] = entry;
  }

  // Drop in-flight send/edit ops for the closed session. Without this,
  // a pending.ops entry is orphaned if the SendResult/EditResult never
  // arrives (backend crash, dropped event). Mirrors removeSessionFromState.
  const remainingOps: Record<string, PendingOp> = {};
  for (const [corrId, op] of Object.entries(state.pending.ops)) {
    if (op.sessionPath !== sp) remainingOps[corrId] = op;
  }

  const remainingRequestIdToLocalId: Record<string, { sessionPath: string; localId: string }> = {};
  for (const [requestId, mapping] of Object.entries(state.pending.requestIdToLocalId)) {
    if (mapping.sessionPath !== sp) remainingRequestIdToLocalId[requestId] = mapping;
  }

  const remainingMessageIdAlias: Record<string, { canonicalId: string; sessionPath: string }> = {};
  for (const [messageId, alias] of Object.entries(state.pending.messageIdAlias)) {
    if (alias.sessionPath !== sp) remainingMessageIdAlias[messageId] = alias;
  }

  let nextSessions = state.sessions.sessions;
  let nextOpenTabPaths = state.sessions.openTabPaths;
  let nextPinnedPaths = state.sessions.pinnedTabPaths;
  let nextRunningPaths = state.sessions.runningSessionPaths;
  let nextUnreadPaths = state.sessions.unreadFinishedSessionPaths;
  let nextActivePath = state.sessions.activeSessionPath;

  if (event.removeSessionSummary) {
    nextSessions = nextSessions.filter((s) => s.path !== sp);
    nextOpenTabPaths = removeFromArray(nextOpenTabPaths, sp);
    nextPinnedPaths = removeFromArray(nextPinnedPaths, sp);
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
        editingMessageIdBySession: remainingEditing,
      },
      sessions: {
        ...state.sessions,
        sessions: nextSessions,
        openTabPaths: nextOpenTabPaths,
        pinnedTabPaths: nextPinnedPaths,
        runningSessionPaths: nextRunningPaths,
        unreadFinishedSessionPaths: nextUnreadPaths,
        activeSessionPath: nextActivePath,
        analyticsFactorsBySession: remainingAnalytics,
        interruptInFlightBySession: remainingInterrupts,
      },
      settings: {
        ...state.settings,
        availableModelsBySession: remainingModels,
        contextUsageBySession: remainingContext,
        pendingExtensionUIRequestsBySession: remainingExtUI,
        showOutcomeDialogBySession: remainingOutcome,
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
        requestIdToLocalId: remainingRequestIdToLocalId,
        messageIdAlias: remainingMessageIdAlias,
        setModelByCorrId: remainingSetModel,
        sendQueueBySession: remainingPendingSendQueue,
        backendReadyQueueBySession: remainingBackendReadyQueue,
        currentTurnBySession: remainingTurns,
      },
    },
    effects: (hadBackendReadyEntries && backendReadyQueueNowEmpty)
      ? [{ kind: 'CancelBackendReadyWatchdog', corrId: 'watchdog' } as Effect]
      : [],
  };
}

export function handlePendingPathReplaced(state: ArchState, event: Extract<Event, { kind: 'PendingPathReplaced' }>): ReducerResult {
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

    // Replace in pinnedTabPaths (dedupe). A pending tab can be pinned (it is
    // open), so when the pending path resolves to the real session path the
    // pinned entry must follow it — otherwise the pinned prefix invariant
    // breaks and the tab silently unpins on resolve.
    draft.sessions.pinnedTabPaths = [
      ...new Set(draft.sessions.pinnedTabPaths.map(
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

    // Move composer draft text. Mirrors the inputs / runSummary migration
    // above: the user's in-progress draft (posted under the pending path while
    // the backend was still creating the session) must follow the session to
    // its real path. Without this, the projected `draftText` for the resolved
    // session falls back to '' and the webview re-seeds the composer empty —
    // clobbering whatever the user typed during the loading window.
    if (Object.prototype.hasOwnProperty.call(draft.composer.draftTextBySession, oldPendingPath)) {
      draft.composer.draftTextBySession[newSessionPath] =
        draft.composer.draftTextBySession[oldPendingPath] ?? '';
      delete draft.composer.draftTextBySession[oldPendingPath];
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

export function handleAnalyticsFactorsChanged(state: ArchState, event: Extract<Event, { kind: 'AnalyticsFactorsChanged' }>): ReducerResult {
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

export function handleTabOpened(state: ArchState, event: Extract<Event, { kind: 'TabOpened' }>): ReducerResult {
  if (state.sessions.openTabPaths.includes(event.sessionPath)) {
    return { state, effects: [] };
  }
  const nextOpenTabPaths = event.insertAfter
    ? (() => {
        const afterIndex = state.sessions.openTabPaths.indexOf(event.insertAfter);
        if (afterIndex === -1) {
          return [...state.sessions.openTabPaths, event.sessionPath];
        }
        // A newly opened tab is unpinned, so it must never land inside the
        // pinned prefix. If `insertAfter` points at a pinned tab, place the
        // new tab at the start of the unpinned region instead (mirrors
        // handleDuplicateSession's clamp) to preserve the pinned-prefix invariant.
        const insertAt = Math.max(afterIndex + 1, state.sessions.pinnedTabPaths.length);
        return [
          ...state.sessions.openTabPaths.slice(0, insertAt),
          event.sessionPath,
          ...state.sessions.openTabPaths.slice(insertAt),
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

export function handleOpenTabsChanged(state: ArchState, event: Extract<Event, { kind: 'OpenTabsChanged' }>): ReducerResult {
  // Restore path: reorder openTabPaths so pinned tabs form the leading prefix
  // (browser semantics) and drop any pinned path no longer open. When
  // `pinnedTabPaths` is omitted, the existing pinned set is re-normalized
  // against the new openTabPaths (pruning dangling entries). Idempotent when
  // openTabPaths is already pinned-first with an empty pinned set.
  const incomingPinned = event.pinnedTabPaths ?? state.sessions.pinnedTabPaths;
  const { openTabPaths, pinnedTabPaths } = reorderOpenTabsPinnedFirst(event.openTabPaths, incomingPinned);
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths,
        pinnedTabPaths,
        unreadFinishedSessionPaths: state.sessions.unreadFinishedSessionPaths.filter((p) =>
          openTabPaths.includes(p),
        ),
      },
    },
    effects: [],
  };
}
