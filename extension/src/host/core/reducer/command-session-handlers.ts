import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';
import { removeFromArray } from './helpers.js';
import { getNextVisibleTabPathOnClose, moveOpenTabPath } from '../../../shared/tab-behavior.js';
import { handleSessionScopeCleared } from './session-handlers.js';

export function handleOpenSession(state: ArchState, cmd: Extract<Command, { kind: 'OpenSession' }>): ReducerResult {
  const { sessionPath, placeholderSummary, selectionToken } = cmd;
  // Optimistic tab setup — was imperative dispatchArch calls in the service
  // (SessionSummaryUpserted placeholder + TabOpened + SelectSession +
  // saveOpenTabs). The reducer now owns these purely; the runner only does
  // the backend session.open RPC + the host-local selection machinery.
  // Mirrors CreateSession, but deliberately does NOT touch
  // runningSessionPaths or the active-run summary: opening an existing tab
  // must not stop an in-flight run or drop its summary (the opened session
  // may be running — a brand-new session cannot, which is why CreateSession
  // filters the pending path out of running + clears its run summary).
  const sessions = state.sessions.sessions;
  const alreadySummarized = sessions.some((s) => s.path === sessionPath);
  const nextSessions = alreadySummarized || !placeholderSummary
    ? sessions
    : [placeholderSummary, ...sessions];
  const nextOpenTabPaths = state.sessions.openTabPaths.includes(sessionPath)
    ? state.sessions.openTabPaths
    : [...state.sessions.openTabPaths, sessionPath];
  const nextState = {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: nextSessions,
      openTabPaths: nextOpenTabPaths,
      activeSessionPath: sessionPath,
      unreadFinishedSessionPaths: state.sessions.unreadFinishedSessionPaths.filter((p) => p !== sessionPath),
    },
  };
  return {
    state: nextState,
    effects: [
      { kind: 'PersistTabs', corrId: cmd.corrId, openTabPaths: nextOpenTabPaths, activeSessionPath: sessionPath },
      { kind: 'OpenSession', corrId: cmd.corrId, sessionPath, selectionToken },
    ],
  };
}

export function handleCreateSession(state: ArchState, cmd: Extract<Command, { kind: 'CreateSession' }>): ReducerResult {
  const { sessionPath, cwd, placeholderSummary, selectionToken } = cmd;
  // Optimistic tab setup — was imperative dispatchArch calls in the
  // service (SessionSummaryUpserted + TabOpened + SelectSession +
  // RunningSessionsChanged + ActiveRunSummaryChanged(null) + saveOpenTabs).
  // The reducer now owns these transitions purely; the runner only does the
  // backend session.create RPC + the host-local selection machinery.
  //
  // Semantics mirror the event handlers: placeholder summary is unshifted
  // (handleSessionSummaryUpserted), the tab is appended if not already open
  // (handleTabOpened), the session is selected (SelectSession), it's ensured
  // not running, and its active-run summary is cleared. PersistTabs replaces
  // the old saveOpenTabs() call.
  const sessions = state.sessions.sessions;
  const alreadySummarized = sessions.some((s) => s.path === sessionPath);
  const nextSessions = alreadySummarized
    ? sessions
    : [placeholderSummary, ...sessions];
  const nextOpenTabPaths = state.sessions.openTabPaths.includes(sessionPath)
    ? state.sessions.openTabPaths
    : [...state.sessions.openTabPaths, sessionPath];
  const nextRunningPaths = state.sessions.runningSessionPaths.filter((p) => p !== sessionPath);
  const nextState = {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: nextSessions,
      openTabPaths: nextOpenTabPaths,
      activeSessionPath: sessionPath,
      runningSessionPaths: nextRunningPaths,
      unreadFinishedSessionPaths: state.sessions.unreadFinishedSessionPaths.filter((p) => p !== sessionPath),
    },
    composer: {
      ...state.composer,
      activeRunSummaryBySession: {
        ...state.composer.activeRunSummaryBySession,
        [sessionPath]: null,
      },
    },
  };
  return {
    state: nextState,
    effects: [
      { kind: 'PersistTabs', corrId: cmd.corrId, openTabPaths: nextOpenTabPaths, activeSessionPath: sessionPath },
      { kind: 'CreateSession', corrId: cmd.corrId, sessionPath, cwd, selectionToken },
    ],
  };
}

export function handleSelectSession(state: ArchState, cmd: Extract<Command, { kind: 'SelectSession' }>): ReducerResult {
  const sessionPath = cmd.sessionPath || null;
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        activeSessionPath: sessionPath,
        unreadFinishedSessionPaths: removeFromArray(
          state.sessions.unreadFinishedSessionPaths,
          cmd.sessionPath,
        ),
      },
    },
    effects: [],
  };
}

export function handleCloseSession(state: ArchState, cmd: Extract<Command, { kind: 'CloseSession' }>): ReducerResult {
  const { sessionPath } = cmd;
  // The reducer owns the tab-close + per-session map clearing +
  // select-next-tab; the runner owns the host-side cleanup
  // (clearSelectionRequestsForPath, onSessionClosed, clearSessionScope,
  // evict) + the recursive openSession(nextPath) when nextPath is not yet
  // summarized. Mirrors the create/open/duplicate pattern but with a key
  // difference: there is NO backend RPC for close — the Effect is a
  // host-side cleanup descriptor, not a backend-RPC descriptor.
  //
  // DIFFERENCE from the pre-migration code: the old CloseSession handler
  // called `removeSessionFromState` (full eviction: removed the summary,
  // runningPaths, nulled activeSessionPath) BEFORE the runner's fat
  // `service.closeSession()` could read the original activeSessionPath,
  // so the next-tab selection was silently skipped (latent double-
  // execution bug). The new handler computes nextPath FIRST (from the
  // pre-close state), does the close + select-next, and passes nextPath
  // to the runner via the Effect.
  //
  // Unlike create/duplicate (which target a NEW pending path → clear
  // runningSessionPaths + activeRunSummaryBySession for the pending path),
  // closeSession REMOVES a tab → mirror SessionScopeCleared{removeSession-
  // Summary:false} (clear per-session maps but keep the summary for
  // reopening, do NOT touch runningSessionPaths — the session may still be
  // running in the backend even if its tab is closed).
  const nextPath = getNextVisibleTabPathOnClose({
    closingPath: sessionPath,
    openTabPaths: state.sessions.openTabPaths,
    sessions: state.sessions.sessions,
    workspaceCwd: state.sessions.workspaceCwd,
    activeSessionPath: state.sessions.activeSessionPath,
  });
  // Clear per-session keyed maps (like SessionScopeCleared{false}).
  // The summary is NOT removed — the session persists for reopening.
  const scoped = handleSessionScopeCleared(state, { kind: 'SessionScopeCleared', sessionPath, removeSessionSummary: false });
  // Remove from openTabPaths + unreadFinished (like CloseTab).
  const nextOpenTabPaths = removeFromArray(scoped.state.sessions.openTabPaths, sessionPath);
  const nextUnreadPaths = removeFromArray(scoped.state.sessions.unreadFinishedSessionPaths, sessionPath);
  // If the closed session was active, select the next tab (or null).
  const wasActive = state.sessions.activeSessionPath === sessionPath;
  const nextActivePath = wasActive ? (nextPath ?? null) : scoped.state.sessions.activeSessionPath;
  const nextState = {
    ...scoped.state,
    sessions: {
      ...scoped.state.sessions,
      openTabPaths: nextOpenTabPaths,
      unreadFinishedSessionPaths: nextUnreadPaths,
      activeSessionPath: nextActivePath,
    },
  };
  return {
    state: nextState,
    effects: [
      { kind: 'PersistTabs', corrId: cmd.corrId, openTabPaths: nextOpenTabPaths, activeSessionPath: nextActivePath },
      { kind: 'CloseSession', corrId: cmd.corrId, sessionPath, nextPath },
    ],
  };
}

export function handleDuplicateSession(state: ArchState, cmd: Extract<Command, { kind: 'DuplicateSession' }>): ReducerResult {
  const { sessionPath, sourceSessionPath, placeholderSummary, selectionToken } = cmd;
  // Optimistic tab setup — was imperative dispatchArch calls in the
  // service (SessionSummaryUpserted + TabOpened(insertAfter=source) +
  // SelectSession + RunningSessionsChanged + ActiveRunSummaryChanged(null)
  // + saveOpenTabs). The reducer now owns these transitions purely; the
  // runner only does the backend session.duplicate RPC + the host-local
  // selection machinery.
  //
  // Mirrors CreateSession (a brand-new pending session cannot be running,
  // so clear the running marker + active-run summary for the pending path —
  // NOT OpenSession, which deliberately omits those because the opened
  // session may be running). DIFFERENCE from CreateSession: the copy tab is
  // inserted ADJACENT to the source (insertAfter semantics, matching
  // handleTabOpened) rather than appended at the end, so the duplicate
  // appears next to its source in the tab bar.
  const sessions = state.sessions.sessions;
  const alreadySummarized = sessions.some((s) => s.path === sessionPath);
  const nextSessions = alreadySummarized
    ? sessions
    : [placeholderSummary, ...sessions];
  // Open the tab adjacent to the source (insertAfter), mirroring
  // handleTabOpened: if the source is open, splice right after it; else
  // append at end.
  const nextOpenTabPaths = state.sessions.openTabPaths.includes(sessionPath)
    ? state.sessions.openTabPaths
    : (() => {
      const afterIndex = state.sessions.openTabPaths.indexOf(sourceSessionPath);
      if (afterIndex === -1) {
        return [...state.sessions.openTabPaths, sessionPath];
      }
      return [
        ...state.sessions.openTabPaths.slice(0, afterIndex + 1),
        sessionPath,
        ...state.sessions.openTabPaths.slice(afterIndex + 1),
      ];
    })();
  const nextRunningPaths = state.sessions.runningSessionPaths.filter((p) => p !== sessionPath);
  const nextState = {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: nextSessions,
      openTabPaths: nextOpenTabPaths,
      activeSessionPath: sessionPath,
      runningSessionPaths: nextRunningPaths,
      unreadFinishedSessionPaths: state.sessions.unreadFinishedSessionPaths.filter((p) => p !== sessionPath),
    },
    composer: {
      ...state.composer,
      activeRunSummaryBySession: {
        ...state.composer.activeRunSummaryBySession,
        [sessionPath]: null,
      },
    },
  };
  return {
    state: nextState,
    effects: [
      { kind: 'PersistTabs', corrId: cmd.corrId, openTabPaths: nextOpenTabPaths, activeSessionPath: sessionPath },
      { kind: 'DuplicateSession', corrId: cmd.corrId, sessionPath, sourceSessionPath, selectionToken },
    ],
  };
}

export function handleMoveSessionTab(state: ArchState, cmd: Extract<Command, { kind: 'MoveSessionTab' }>): ReducerResult {
  // Phase 2 send/edit-style cutover: the reducer owns the reorder. The
  // pure shared helper computes the new openTabPaths, state is updated, and
  // a PersistTabs effect is emitted so the runner writes globalState. The
  // legacy MoveSessionTab Effect / service.moveSessionTab / ReorderTabs
  // round-trip is gone.
  const newOrder = moveOpenTabPath(state.sessions.openTabPaths, {
    sessionPath: cmd.sessionPath,
    fromIndex: cmd.fromIndex,
    toIndex: cmd.toIndex,
  });
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths: newOrder,
      },
    },
    effects: [
      {
        kind: 'PersistTabs',
        corrId: cmd.corrId,
        openTabPaths: newOrder,
        activeSessionPath: state.sessions.activeSessionPath,
      },
    ],
  };
}
