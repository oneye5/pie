import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';
import { removeFromArray } from './helpers.js';

export function handleCloseTab(state: ArchState, cmd: Extract<Command, { kind: 'CloseTab' }>): ReducerResult {
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

export function handlePersistTabs(state: ArchState, cmd: Extract<Command, { kind: 'PersistTabs' }>): ReducerResult {
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
