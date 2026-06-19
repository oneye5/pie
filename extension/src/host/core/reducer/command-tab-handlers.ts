import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';
import { removeFromArray } from './helpers.js';
import { pinTab, unpinTab } from '../../../shared/tab-behavior.js';

export function handleCloseTab(state: ArchState, cmd: Extract<Command, { kind: 'CloseTab' }>): ReducerResult {
  // Closing a tab also unpins it — a pinned tab cannot outlive its open tab
  // (the pinned ⊆ openTabPaths invariant). No PersistTabs effect here: the
  // CloseTab Command is only dispatched directly by handleSelectionFailure
  // (which emits its own PersistTabs) — normal close flows through the
  // CloseSession Command, whose handler emits PersistTabs.
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths: removeFromArray(state.sessions.openTabPaths, cmd.sessionPath),
        pinnedTabPaths: removeFromArray(state.sessions.pinnedTabPaths, cmd.sessionPath),
        unreadFinishedSessionPaths: removeFromArray(
          state.sessions.unreadFinishedSessionPaths,
          cmd.sessionPath,
        ),
      },
    },
    effects: [],
  };
}

export function handlePersistTabs(state: ArchState, cmd: Extract<Command, { kind: 'PersistTabs' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'PersistTabs',
        corrId: cmd.corrId,
        openTabPaths: cmd.openTabPaths,
        activeSessionPath: cmd.activeSessionPath,
        pinnedTabPaths: cmd.pinnedTabPaths,
      },
    ],
  };
}

/** Toggle a tab's pinned state (browser-style). The reducer owns the reorder
 *  that keeps pinned tabs as the leading prefix of `openTabPaths` and emits a
 *  PersistTabs effect so the runner writes globalState. No backend RPC. */
export function handleTogglePinTab(state: ArchState, cmd: Extract<Command, { kind: 'TogglePinTab' }>): ReducerResult {
  const { sessionPath } = cmd;
  const { openTabPaths, pinnedTabPaths } = state.sessions;
  // Only open, real tabs can be pinned. A pending placeholder or a tab that
  // is no longer open is a no-op (defensive — the webview only offers the
  // action on open tabs).
  if (!openTabPaths.includes(sessionPath)) {
    return { state, effects: [] };
  }
  const isPinned = pinnedTabPaths.includes(sessionPath);
  const next = isPinned
    ? unpinTab(openTabPaths, pinnedTabPaths, sessionPath)
    : pinTab(openTabPaths, pinnedTabPaths, sessionPath);
  const nextState = {
    ...state,
    sessions: {
      ...state.sessions,
      openTabPaths: next.openTabPaths,
      pinnedTabPaths: next.pinnedTabPaths,
    },
  };
  return {
    state: nextState,
    effects: [
      {
        kind: 'PersistTabs',
        corrId: cmd.corrId,
        openTabPaths: next.openTabPaths,
        activeSessionPath: state.sessions.activeSessionPath,
        pinnedTabPaths: next.pinnedTabPaths,
      },
    ],
  };
}
