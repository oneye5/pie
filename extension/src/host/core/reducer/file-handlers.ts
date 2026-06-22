import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';

export function handleFileChangesUpdated(
  state: ArchState,
  event: Extract<Event, { kind: 'FileChangesUpdated' }>,
): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.fileChanges.bySession[event.sessionPath] = event.fileChanges;
    }),
    effects: [],
  };
}
