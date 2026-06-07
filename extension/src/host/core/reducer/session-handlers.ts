import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';
import { addToArray, removeFromArray, upsertSessionSummary, removeSessionFromState } from './helpers.js';
import type { SessionSummary } from '../../../shared/protocol.js';

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
