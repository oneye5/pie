import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';
import { addToArray, removeFromArray, upsertSessionSummary, removeSessionFromState } from './helpers.js';

export function handleSessionClosed(state: ArchState, event: Extract<Event, { kind: 'SessionClosed' }>): ReducerResult {
  return removeSessionFromState(state, event.sessionPath);
}

export function handleSessionListChanged(state: ArchState, event: Extract<Event, { kind: 'SessionListChanged' }>): ReducerResult {
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