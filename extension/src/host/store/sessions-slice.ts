import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { SessionSummary } from '../../shared/protocol';
import { moveOpenTabPath } from '../../shared/tab-behavior';

interface SessionsState {
  sessions: SessionSummary[];
  openTabPaths: string[];
  runningSessionPaths: string[];
  unreadFinishedSessionPaths: string[];
  activeSessionPath: string | null;
  workspaceCwd: string | null;
}

function removeSessionsMatching(
  state: SessionsState,
  predicate: (session: SessionSummary) => boolean,
): void {
  const removedPaths = new Set(
    state.sessions.filter((session) => predicate(session)).map((session) => session.path),
  );
  if (removedPaths.size === 0) {
    return;
  }

  state.sessions = state.sessions.filter((session) => !removedPaths.has(session.path));
  state.openTabPaths = state.openTabPaths.filter((path) => !removedPaths.has(path));
  state.runningSessionPaths = state.runningSessionPaths.filter((path) => !removedPaths.has(path));
  state.unreadFinishedSessionPaths = state.unreadFinishedSessionPaths.filter((path) => !removedPaths.has(path));
  if (state.activeSessionPath && removedPaths.has(state.activeSessionPath)) {
    state.activeSessionPath = null;
  }
}

/**
 * Merge an existing summary with an incoming one. We preserve a real local name
 * over a backend-emitted placeholder so that "New Session" doesn't clobber a
 * user-meaningful tab label after a list refresh.
 */
function mergeSessionSummary(
  existing: SessionSummary | undefined,
  incoming: SessionSummary,
): SessionSummary {
  if (!existing) return incoming;
  const keepExistingName =
    !existing.isPlaceholder &&
    incoming.isPlaceholder === true;
  return {
    ...incoming,
    name: keepExistingName ? existing.name : incoming.name,
    isPlaceholder: keepExistingName ? false : incoming.isPlaceholder,
    modelId: incoming.modelId ?? existing.modelId,
    thinkingLevel: incoming.thinkingLevel ?? existing.thinkingLevel,
  };
}

const sessionsSlice = createSlice({
  name: 'sessions',
  initialState: {
    sessions: [],
    openTabPaths: [],
    runningSessionPaths: [],
    unreadFinishedSessionPaths: [],
    activeSessionPath: null,
    workspaceCwd: null,
  } as SessionsState,
  reducers: {
    setWorkspaceCwd(state, action: PayloadAction<string | null>) {
      state.workspaceCwd = action.payload;
    },
    setOpenTabPaths(state, action: PayloadAction<string[]>) {
      state.openTabPaths = action.payload;
      state.unreadFinishedSessionPaths = state.unreadFinishedSessionPaths
        .filter((path) => action.payload.includes(path));
    },
    ensureOpenTab(state, action: PayloadAction<string>) {
      if (!state.openTabPaths.includes(action.payload)) {
        state.openTabPaths = [...state.openTabPaths, action.payload];
      }
    },
    removeOpenTab(state, action: PayloadAction<string>) {
      state.openTabPaths = state.openTabPaths.filter((p) => p !== action.payload);
      state.unreadFinishedSessionPaths = state.unreadFinishedSessionPaths
        .filter((path) => path !== action.payload);
    },
    replaceOpenTabPath(
      state,
      action: PayloadAction<{ oldPath: string; newPath: string }>,
    ) {
      const { oldPath, newPath } = action.payload;
      state.openTabPaths = state.openTabPaths.map((p) => (p === oldPath ? newPath : p));
      state.unreadFinishedSessionPaths = [
        ...new Set(state.unreadFinishedSessionPaths
          .map((path) => (path === oldPath ? newPath : path))),
      ];
    },
    moveOpenTab(
      state,
      action: PayloadAction<{ sessionPath?: string; fromIndex: number; toIndex: number }>,
    ) {
      state.openTabPaths = moveOpenTabPath(state.openTabPaths, action.payload);
    },
    insertOpenTabAfter(
      state,
      action: PayloadAction<{ afterPath: string; newPath: string }>,
    ) {
      const { afterPath, newPath } = action.payload;
      const index = state.openTabPaths.indexOf(afterPath);
      if (index === -1) {
        // Fallback: append at the end.
        state.openTabPaths = [...state.openTabPaths, newPath];
      } else {
        state.openTabPaths = [
          ...state.openTabPaths.slice(0, index + 1),
          newPath,
          ...state.openTabPaths.slice(index + 1),
        ];
      }
    },
    upsertSession(state, action: PayloadAction<SessionSummary>) {
      const incoming = action.payload;
      const idx = state.sessions.findIndex((s) => s.path === incoming.path);
      const existing = idx === -1 ? undefined : state.sessions[idx];
      const merged = mergeSessionSummary(existing, incoming);
      if (idx === -1) {
        state.sessions = [merged, ...state.sessions];
      } else {
        state.sessions[idx] = merged;
      }
    },
    setSessionSummary(state, action: PayloadAction<SessionSummary>) {
      const incoming = action.payload;
      state.sessions = [
        incoming,
        ...state.sessions.filter((session) => session.path !== incoming.path),
      ];
    },
    replaceSessionSummaries(state, action: PayloadAction<SessionSummary[]>) {
      const mergedByPath = new Map<string, SessionSummary>();
      for (const incoming of action.payload) {
        const existing = mergedByPath.get(incoming.path) ?? state.sessions.find((s) => s.path === incoming.path);
        mergedByPath.set(incoming.path, mergeSessionSummary(existing, incoming));
      }
      // Keep open-tab sessions not in the incoming list.
      for (const s of state.sessions) {
        if (!mergedByPath.has(s.path) && state.openTabPaths.includes(s.path)) {
          mergedByPath.set(s.path, s);
        }
      }
      // Keep the active session if it's not in the list.
      const activeSession = state.activeSessionPath
        ? state.sessions.find((session) => session.path === state.activeSessionPath)
        : undefined;
      if (activeSession && !mergedByPath.has(activeSession.path)) {
        mergedByPath.set(activeSession.path, activeSession);
      }
      state.sessions = [...mergedByPath.values()];
    },
    removePendingSessions(state) {
      removeSessionsMatching(state, (session) => session.path.startsWith('__pending__:'));
    },
    removeSession(state, action: PayloadAction<string>) {
      removeSessionsMatching(state, (session) => session.path === action.payload);
    },
    setSessionRunning(state, action: PayloadAction<{ sessionPath: string; running: boolean }>) {
      const { sessionPath, running } = action.payload;
      const set = new Set(state.runningSessionPaths);
      if (running) {
        set.add(sessionPath);
        state.unreadFinishedSessionPaths = state.unreadFinishedSessionPaths
          .filter((path) => path !== sessionPath);
      } else {
        set.delete(sessionPath);
      }
      state.runningSessionPaths = [...set];
    },
    markSessionFinishedUnread(state, action: PayloadAction<string>) {
      if (!state.unreadFinishedSessionPaths.includes(action.payload)) {
        state.unreadFinishedSessionPaths = [...state.unreadFinishedSessionPaths, action.payload];
      }
    },
    clearUnreadFinishedSessions(state) {
      state.unreadFinishedSessionPaths = [];
    },
    clearRunningPaths(state) {
      state.runningSessionPaths = [];
    },
    setActiveSessionPath(state, action: PayloadAction<string | null>) {
      state.activeSessionPath = action.payload;
      if (action.payload) {
        state.unreadFinishedSessionPaths = state.unreadFinishedSessionPaths
          .filter((path) => path !== action.payload);
      }
    },
    setActiveSession(state, action: PayloadAction<SessionSummary | null>) {
      state.activeSessionPath = action.payload?.path ?? null;
      if (action.payload?.path) {
        state.unreadFinishedSessionPaths = state.unreadFinishedSessionPaths
          .filter((path) => path !== action.payload?.path);
      }
    },
    clearActiveSession(state) {
      state.activeSessionPath = null;
    },
  },
});

export const sessionsReducer = sessionsSlice.reducer;
export const sessionsActions = sessionsSlice.actions;
