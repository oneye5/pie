import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Effect } from '../effects.js';
import type { ReducerResult } from './helpers.js';
import { removeMessage } from './helpers.js';
import type { Event } from '../events.js';

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
    const nextState = produce(state, (draft) => {
      draft.pending.ops = restOps;
      delete draft.composer.pendingComposerInputsBySession[pending.sessionPath];
    });
    return { state: nextState, effects: [] };
  }

  // Failure: rollback optimistic message, notify user, restore session name
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
  const effects: Effect[] = [];

  const nextState = produce(state, (draft) => {
    draft.pending.ops = restOps;
    removeMessage(draft, pending.sessionPath, pending.localId);
    draft.settings.notice = `Failed to edit message: ${event.error ?? 'unknown error'}`;
  });

  return { state: nextState, effects };
}

export function handleEffectResult(state: ArchState, event: Event): ReducerResult {
  switch (event.kind) {
    case 'InterruptResult':
      return handleInterruptResult(state, event);
    case 'SendResult':
      return handleSendResult(state, event);
    case 'EditResult':
      return handleEditResult(state, event);
    default:
      return { state, effects: [] };
  }
}