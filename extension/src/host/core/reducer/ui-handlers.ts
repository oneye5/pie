import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';
import { upsertTranscriptMessage } from './helpers.js';

export function handleCustomMessage(state: ArchState, event: Extract<Event, { kind: 'CustomMessage' }>): ReducerResult {
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

export function handleExtensionUIRequest(state: ArchState, event: Extract<Event, { kind: 'ExtensionUIRequest' }>): ReducerResult {
  const sessionPath = event.sessionPath;
  if (!sessionPath) {
    // Backward compat: skip if no session path.
    return { state, effects: [] };
  }
  return {
    state: produce(state, (draft) => {
      const sessionMap = draft.settings.pendingExtensionUIRequestsBySession[sessionPath] ?? {};
      sessionMap[event.request.id] = event.request;
      draft.settings.pendingExtensionUIRequestsBySession[sessionPath] = sessionMap;
    }),
    effects: [],
  };
}

export function handleError(state: ArchState, event: Extract<Event, { kind: 'Error' }>): ReducerResult {
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

export function handleNoticeShown(state: ArchState, event: Extract<Event, { kind: 'NoticeShown' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.settings.notice = event.notice;
    }),
    effects: [],
  };
}