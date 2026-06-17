import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Effect } from '../effects.js';
import type { ReducerResult } from './helpers.js';
import { removeFromArray, removeMessage } from './helpers.js';
import type { Event, EffectResultEvent } from '../events.js';

export function handleInterruptResult(state: ArchState, event: Extract<Event, { kind: 'InterruptResult' }>): ReducerResult {
  let nextState = state;
  const effects: Effect[] = [];

  if (!event.ok) {
    effects.push({
      kind: 'Log',
      corrId: event.corrId,
      level: 'error',
      message: `Interrupt failed for session ${event.sessionPath}`,
      data: { error: event.error },
    });
  }

  // Directly update running state and clear interrupt flag
  nextState = produce(nextState, (draft) => {
    draft.sessions.interruptInFlightBySession[event.sessionPath] = false;
    if (event.ok) {
      draft.sessions.runningSessionPaths = draft.sessions.runningSessionPaths.filter(
        (p: string) => p !== event.sessionPath,
      );
    }
  });

  return { state: nextState, effects };
}

export function handleSendResult(state: ArchState, event: Extract<Event, { kind: 'SendResult' }>): ReducerResult {
  const pending = state.pending.ops[event.corrId];
  if (!pending) return { state, effects: [] };

  const { [event.corrId]: _removed, ...restOps } = state.pending.ops;

  if (event.ok) {
    // Success: clear composer inputs directly + remove pending op
    // Also record requestId→localId mapping for optimistic ID finalization.
    const nextState = produce(state, (draft) => {
      draft.pending.ops = restOps;
      delete draft.composer.pendingComposerInputsBySession[pending.sessionPath];
      if (event.requestId) {
        draft.pending.requestIdToLocalId[event.requestId] = {
          sessionPath: pending.sessionPath,
          localId: pending.localId,
        };
      }
    });
    return { state: nextState, effects: [] };
  }

  // Failure: rollback optimistic message, notify user, restore session name
  // Also clear the busy state we set optimistically in the Send command handler.
  const effects: Effect[] = [
    {
      kind: 'PostImperative',
      corrId: event.corrId,
      imperativeMessage: { type: 'sendRejected', sessionPath: pending.sessionPath, localId: pending.localId },
    },
  ];

  const nextState = produce(state, (draft) => {
    draft.pending.ops = restOps;
    // Remove optimistic message from transcript
    removeMessage(draft, pending.sessionPath, pending.localId);
    // Clear busy state set optimistically at send time
    draft.sessions.runningSessionPaths = removeFromArray(
      draft.sessions.runningSessionPaths,
      pending.sessionPath,
    );
    // Set notice
    draft.settings.notice = `Failed to send message: ${event.error ?? 'unknown error'}`;
    // Restore session summary if we had one
    if (pending.previousSummary) {
      const idx = draft.sessions.sessions.findIndex((s) => s.path === pending.previousSummary!.path);
      if (idx >= 0) {
        draft.sessions.sessions[idx] = pending.previousSummary;
      } else {
        draft.sessions.sessions.push(pending.previousSummary);
      }
    }
  });

  return { state: nextState, effects };
}

export function handleEditResult(state: ArchState, event: Extract<Event, { kind: 'EditResult' }>): ReducerResult {
  const pending = state.pending.ops[event.corrId];
  if (!pending) return { state, effects: [] };

  const { [event.corrId]: _removed, ...restOps } = state.pending.ops;

  if (event.ok) {
    const nextState = {
      ...state,
      pending: { ...state.pending, ops: restOps },
    };
    return { state: nextState, effects: [] };
  }

  // Failure: rollback the optimistic edit message + notify user
  // Also clear the busy state we set optimistically in the Edit command handler.
  const effects: Effect[] = [];

  const nextState = produce(state, (draft) => {
    draft.pending.ops = restOps;
    removeMessage(draft, pending.sessionPath, pending.localId);
    draft.sessions.runningSessionPaths = removeFromArray(
      draft.sessions.runningSessionPaths,
      pending.sessionPath,
    );
    draft.settings.notice = `Failed to edit message: ${event.error ?? 'unknown error'}`;
  });

  return { state: nextState, effects };
}

export function handleSetModelResult(state: ArchState, _event: Extract<Event, { kind: 'SetModelResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleSetPrefsResult(state: ArchState, _event: Extract<Event, { kind: 'SetPrefsResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleEffectResult(state: ArchState, event: Exclude<EffectResultEvent, { kind: 'TruncateResult' } | { kind: 'OpenSessionResult' } | { kind: 'CreateSessionResult' } | { kind: 'PersistTabsResult' }>): ReducerResult {
  switch (event.kind) {
    case 'InterruptResult':
      return handleInterruptResult(state, event);
    case 'SendResult':
      return handleSendResult(state, event);
    case 'EditResult':
      return handleEditResult(state, event);
    case 'FileDiffResult':
      return { state, effects: [] };
    case 'FileRevertResult':
      return { state, effects: [] };
    case 'SetModelResult':
      return handleSetModelResult(state, event);
    case 'SetPrefsResult':
      return handleSetPrefsResult(state, event);
    case 'AddFilesystemPathsResult':
    case 'LoadOlderTranscriptResult':
    case 'LoadNewerTranscriptResult':
    case 'JumpToLatestTranscriptResult':
    case 'RecordOutcomeResult':
    case 'StartNewTaskResult':
    case 'ContinueTaskResult':
    case 'OpenFileInEditorResult':
    case 'OpenFileResult':
    case 'SetPruningSettingsResult':
    case 'CloseSessionResult':
    case 'DuplicateSessionResult':
    case 'ExtensionUiResponseResult': {
      if (!event.ok) {
        return {
          state,
          effects: [
            {
              kind: 'Log',
              corrId: event.corrId,
              level: 'error',
              message: `${event.kind} failed`,
              data: { error: event.error },
            },
          ],
        };
      }
      return { state, effects: [] };
    }
    default: {
      // Exhaustiveness: the switch is total over the result kinds routed here.
      // TruncateResult/OpenSessionResult/CreateSessionResult/PersistTabsResult
      // are handled by dedicated handlers in misc-handlers.ts, so they are
      // excluded from this function's param type — and from this switch.
      const _exhaustive: never = event;
      void _exhaustive;
      return {
        state,
        effects: [
          {
            kind: 'Log',
            corrId: '',
            level: 'error',
            message: `handleEffectResult: unhandled result kind (type system bypassed?): ${(event as { kind?: string }).kind}`,
          },
        ],
      };
    }
  }
}
