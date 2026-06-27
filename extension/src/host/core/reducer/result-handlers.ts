import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Effect } from '../effects.js';
import type { ReducerResult } from './helpers.js';
import { removeFromArray, removeMessage } from './helpers.js';
import type { Event, EffectResultEvent } from '../events.js';
import { applySetModelOptimistic, dropSetModelPending, revertSetModel } from './set-model-handlers.js';

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
    // Early-ack success: the prompt was queued. The rollback snapshot MOVES
    // to `pending.promoted` (it is NOT deleted) so a post-ack prepass failure
    // (`PreflightFailed`) can still roll back via `promoted[corrId]`. The
    // snapshot is dropped at the commit point (first `MessageStarted` for the
    // requestId) — see STATE_CONTRACT § Optimistic Reconciliation "Two failure
    // windows for send".
    const nextState = produce(state, (draft) => {
      draft.pending.ops = restOps;
      draft.pending.promoted[event.corrId] = {
        ...pending,
        ...(event.requestId ? { requestId: event.requestId } : {}),
      };
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
      imperativeMessage: { type: 'sendRejected', sessionPath: pending.sessionPath, text: pending.text ?? '', localId: pending.localId },
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

/**
 * Post-ack, pre-commit prepass failure (the `message.send` RPC succeeded but
 * the pruning prepass then failed). Reverts the promoted send via
 * `pending.promoted[corrId]`: removes the optimistic transcript entry, restores
 * the session summary, restores `pendingComposerInputsBySession` from the
 * promoted `inputs` snapshot, clears `requestIdToLocalId`, fires a
 * `sendRejected` imperative, and surfaces a plain-language error. A later
 * failure (after the commit point) is an in-turn error, never a rollback.
 *
 * `corrId` resolution: the backend prepass-failure bridge dispatches WITHOUT
 * `corrId` (the backend mints `requestId` but never sees the host corrId), so
 * the reducer scans `pending.promoted` for the matching `requestId`. Brief B's
 * send-timer dispatches WITH `corrId`. See STATE_CONTRACT § Optimistic
 * Reconciliation "Two failure windows for send".
 */
export function handlePreflightFailed(state: ArchState, event: Extract<Event, { kind: 'PreflightFailed' }>): ReducerResult {
  let corrId = event.corrId;
  let promoted = corrId ? state.pending.promoted[corrId] : undefined;
  if (!promoted) {
    for (const [cid, op] of Object.entries(state.pending.promoted)) {
      if (op.requestId === event.requestId) {
        corrId = cid;
        promoted = op;
        break;
      }
    }
  }
  // Stale/unknown: the send already committed (promoted dropped at the commit
  // point) or was never promoted — a later failure is an in-turn error, not a
  // rollback. No-op (the in-turn error path surfaces its own notice).
  if (!corrId || !promoted) return { state, effects: [] };

  const { [corrId]: _removed, ...restPromoted } = state.pending.promoted;
  const snapshot = promoted;

  // Fire sendRejected (send ops only) so the webview removes its optimistic
  // overlay entry and restores the draft text. Edits do NOT fire sendRejected
  // — matching the legacy pre-ack `EditResult{ok:false}` path (the inline
  // editor is already closed by the Edit command; restoring the edited text
  // to the composer draft would be a UX change Brief E owns). The `inputs`
  // payload on sendRejected is owned by Brief C (protocol field + webview
  // restore); the host-side composer-input restore below is this brief's
  // concern.
  const effects: Effect[] =
    snapshot.kind === 'send'
      ? [
          {
            kind: 'PostImperative',
            corrId,
            imperativeMessage: {
              type: 'sendRejected',
              sessionPath: snapshot.sessionPath,
              text: snapshot.text ?? '',
              localId: snapshot.localId,
            },
          },
        ]
      : [];

  const nextState = produce(state, (draft) => {
    draft.pending.promoted = restPromoted;
    // Remove optimistic user message from transcript
    removeMessage(draft, snapshot.sessionPath, snapshot.localId);
    // Clear the host-side optimistic running state set at Send time
    draft.sessions.runningSessionPaths = removeFromArray(
      draft.sessions.runningSessionPaths,
      snapshot.sessionPath,
    );
    // The send will never stream — drop its requestId→localId mapping
    if (event.requestId) {
      delete draft.pending.requestIdToLocalId[event.requestId];
    }
    // Restore composer inputs from the promoted snapshot so a retry can re-send
    // them (no data loss). Brief C wires the webview-side restore.
    if (snapshot.inputs && snapshot.inputs.length > 0) {
      draft.composer.pendingComposerInputsBySession[snapshot.sessionPath] = [...snapshot.inputs];
    }
    // Surface a plain-language error (Brief H refines the copy). Kind-aware so
    // an edit failure reads as an edit failure (matches the legacy wording).
    draft.settings.notice =
      snapshot.kind === 'edit'
        ? `Failed to edit message: ${event.error ?? 'the prompt was rejected before it began.'}`
        : `Failed to start this turn: ${event.error ?? 'the prompt was rejected before it began.'}`;
    // Restore session summary if the optimistic send had renamed it
    if (snapshot.previousSummary) {
      const idx = draft.sessions.sessions.findIndex((s) => s.path === snapshot.previousSummary!.path);
      if (idx >= 0) {
        draft.sessions.sessions[idx] = snapshot.previousSummary;
      } else {
        draft.sessions.sessions.push(snapshot.previousSummary);
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
    // Early-ack success (mirrors handleSendResult): the prompt was queued.
    // The rollback snapshot MOVES to `pending.promoted` (not deleted) so a
    // post-ack prepass failure (`PreflightFailed`) can still roll back the
    // edit. Dropped at the commit point (first `MessageStarted` for the
    // requestId). See STATE_CONTRACT § Optimistic Reconciliation "Two failure
    // windows for send" — edit follows the same phase-scoped shape.
    const nextState = produce(state, (draft) => {
      draft.pending.ops = restOps;
      draft.pending.promoted[event.corrId] = {
        ...pending,
        ...(event.requestId ? { requestId: event.requestId } : {}),
      };
    });
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

export function handleSetModelResult(state: ArchState, event: Extract<Event, { kind: 'SetModelResult' }>): ReducerResult {
  const pending = state.pending.setModelByCorrId[event.corrId];
  if (!pending) {
    // Stale result for an unknown/aborted setModel — nothing to reconcile.
    return { state, effects: [] };
  }
  if (event.ok) {
    // Success: the backend persisted the switch; drop the rollback snapshot.
    return { state: dropSetModelPending(state, event.corrId), effects: [] };
  }
  // Failure: revert the optimistic apply field-for-field + surface a notice.
  return { state: revertSetModel(state, event.corrId, event.error), effects: [] };
}

export function handleModelSwitchConfirmResult(
  state: ArchState,
  event: Extract<Event, { kind: 'ModelSwitchConfirmResult' }>,
): ReducerResult {
  const pending = state.pending.setModelByCorrId[event.corrId];
  if (!pending) {
    // Stale confirm for an unknown/aborted request — nothing to do.
    return { state, effects: [] };
  }
  if (!event.confirmed) {
    // User declined (or dismissed): drop the stashed intent, leave all state
    // untouched. No notice — the user explicitly cancelled.
    return { state: dropSetModelPending(state, event.corrId), effects: [] };
  }
  // Confirmed: apply optimistically, clearing the pending images that prompted
  // the modal (the modal only appears when the new model lacks image support),
  // then emit the backend write.
  return {
    state: applySetModelOptimistic(state, event.corrId, pending.sessionPath, pending.modelSettings, true),
    effects: [{ kind: 'SetModelRpc', corrId: event.corrId, sessionPath: pending.sessionPath, modelSettings: pending.modelSettings }],
  };
}

export function handleSetPrefsResult(state: ArchState, _event: Extract<Event, { kind: 'SetPrefsResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleEffectResult(state: ArchState, event: Exclude<EffectResultEvent, { kind: 'TruncateResult' } | { kind: 'OpenSessionResult' } | { kind: 'CreateSessionResult' } | { kind: 'DuplicateSessionResult' } | { kind: 'CloseSessionResult' } | { kind: 'PersistTabsResult' } | { kind: 'ModelSwitchConfirmResult' }>): ReducerResult {
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
    case 'LoadOlderTranscriptResult':
    case 'LoadNewerTranscriptResult':
    case 'JumpToLatestTranscriptResult': {
      // Clear the in-flight paging flag when this result is for the current
      // request (corrId matches). A stale result from a superseded request
      // (the tab was closed + reopened, or SessionScopeCleared reset the flag
      // and a new request took over) must NOT clear the current request's
      // flag — its own completion still needs to clear it. Log failures
      // regardless of whether the corrId is current.
      const effects: Effect[] = [];
      if (!event.ok) {
        effects.push({
          kind: 'Log',
          corrId: event.corrId,
          level: 'error',
          message: `${event.kind} failed`,
          data: { error: event.error },
        });
      }
      if (state.transcript.pagingInFlightBySession[event.sessionPath] === event.corrId) {
        const nextPagingInFlight = { ...state.transcript.pagingInFlightBySession };
        delete nextPagingInFlight[event.sessionPath];
        return {
          state: {
            ...state,
            transcript: {
              ...state.transcript,
              pagingInFlightBySession: nextPagingInFlight,
            },
          },
          effects,
        };
      }
      return { state, effects };
    }
    case 'RecordOutcomeResult':
    case 'StartNewTaskResult':
    case 'ContinueTaskResult':
    case 'OpenFileInEditorResult':
    case 'OpenFileResult':
    case 'SetPruningSettingsResult':
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
