import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';

export function handleFileChangesUpdated(
  state: ArchState,
  event: Extract<Event, { kind: 'FileChangesUpdated' }>,
): ReducerResult {
  const shouldAutoOpen =
    event.fileChanges.length > 0 &&
    state.settings.prefs.autoOpenFileChangesRail &&
    state.fileChanges.autoExpandedBySession[event.sessionPath] !== true;

  return {
    state: produce(state, (draft) => {
      draft.fileChanges.bySession[event.sessionPath] = event.fileChanges;
      if (shouldAutoOpen) {
        draft.fileChanges.expandedBySession[event.sessionPath] = true;
        draft.fileChanges.autoExpandedBySession[event.sessionPath] = true;
      }
    }),
    effects: [],
  };
}
