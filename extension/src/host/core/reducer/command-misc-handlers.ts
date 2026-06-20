import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import { mergePruningSettings, type ChatPrefs } from '../../../shared/protocol.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';
import { addToArray, appendLocalUserMessage } from './helpers.js';
import { isPendingTabPath } from '../../../shared/tab-behavior.js';

export function handleInterrupt(state: ArchState, cmd: Extract<Command, { kind: 'Interrupt' }>): ReducerResult {
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        interruptInFlightBySession: {
          ...state.sessions.interruptInFlightBySession,
          [cmd.sessionPath]: true,
        },
      },
    },
    effects: [{ kind: 'InterruptRpc', corrId: cmd.corrId, sessionPath: cmd.sessionPath }],
  };
}

export function handleSend(state: ArchState, cmd: Extract<Command, { kind: 'Send' }>): ReducerResult {
  // If the target session is still a pending tab (backend `session.create`
  // in flight), queue the send into ArchState instead of emitting `SendRpc`.
  // The optimistic user message is still inserted immediately (the user sees
  // their message in the transcript), the draft is cleared, and the session
  // name is derived (via `SessionNameDerived` dispatched by `onSend` before
  // the Command). When `PendingPathReplaced` resolves the path, the reducer
  // emits a `DrainPendingSendQueue` effect; the runner re-dispatches each
  // entry as a `Send` Command with the resolved path, which goes through
  // the normal (non-pending) path below.
  if (isPendingTabPath(cmd.sessionPath)) {
    const nextState = produce(state, (draft) => {
      appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts, new Date(cmd.timestamp).toISOString());
      draft.fileChanges.autoExpandedBySession[cmd.sessionPath] = false;
      draft.pending.sendQueueBySession[cmd.sessionPath] = [
        ...(draft.pending.sendQueueBySession[cmd.sessionPath] ?? []),
        {
          corrId: cmd.corrId,
          text: cmd.text,
          inputs: cmd.inputs,
          composedText: cmd.composedText,
          localId: cmd.localId,
          userParts: cmd.userParts,
          // null — the name derivation already happened via SessionNameDerived;
          // by drain time the session has a real summary from session.opened.
          previousSummary: null,
          timestamp: cmd.timestamp,
        },
      ];
      delete draft.composer.draftTextBySession[cmd.sessionPath];
    });
    return { state: nextState, effects: [] };
  }

  // If the backend is not yet ready, queue the send into ArchState instead
  // of emitting `SendRpc`. The optimistic user message is inserted
  // immediately, the draft is cleared, and a `StartBackendReadyWatchdog`
  // effect is emitted (the runner starts a 30s timer; if the backend
  // doesn't become ready in time, the watchdog fires and the reducer drops
  // the queued messages). When `BackendReadyChanged{ready:true}` fires, the
  // reducer emits a `DrainBackendReadyQueue` effect; the runner re-dispatches
  // each entry as a `Send` Command, which goes through the normal path below.
  if (!state.settings.backendReady) {
    const nextState = produce(state, (draft) => {
      appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts, new Date(cmd.timestamp).toISOString());
      draft.fileChanges.autoExpandedBySession[cmd.sessionPath] = false;
      draft.pending.backendReadyQueueBySession[cmd.sessionPath] = [
        ...(draft.pending.backendReadyQueueBySession[cmd.sessionPath] ?? []),
        {
          sessionPath: cmd.sessionPath,
          corrId: cmd.corrId,
          text: cmd.text,
          inputs: cmd.inputs,
          composedText: cmd.composedText,
          localId: cmd.localId,
          userParts: cmd.userParts,
          previousSummary: null,
          timestamp: cmd.timestamp,
        },
      ];
      delete draft.composer.draftTextBySession[cmd.sessionPath];
    });
    return {
      state: nextState,
      effects: [{ kind: 'StartBackendReadyWatchdog', corrId: 'watchdog', timeoutMs: 30_000 }],
    };
  }

  // Normal path: insert optimistic user message + mark session busy
  // immediately so the webview shows an activity indicator right away
  // (instead of waiting for the backend's agent_start event which fires
  // after the pruning prepass).
  const nextRunningPaths = addToArray(state.sessions.runningSessionPaths, cmd.sessionPath);
  const nextState = produce(state, (draft) => {
    appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts, new Date(cmd.timestamp).toISOString());
    draft.pending.ops[cmd.corrId] = {
      kind: 'send',
      sessionPath: cmd.sessionPath,
      localId: cmd.localId,
      previousSummary: cmd.previousSummary,
      text: cmd.text,
    };
    draft.sessions.runningSessionPaths = nextRunningPaths;
    draft.fileChanges.autoExpandedBySession[cmd.sessionPath] = false;
    delete draft.composer.draftTextBySession[cmd.sessionPath];
  });

  return {
    state: nextState,
    effects: [
      {
        kind: 'SendRpc',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
        text: cmd.text,
        inputs: cmd.inputs,
        localId: cmd.localId,
      },
    ],
  };
}

export function handleEdit(state: ArchState, cmd: Extract<Command, { kind: 'Edit' }>): ReducerResult {
  // Insert optimistic edit message + mark session busy immediately so the
  // webview shows an activity indicator right away.
  const nextRunningPaths = addToArray(state.sessions.runningSessionPaths, cmd.sessionPath);
  const nextState = produce(state, (draft) => {
    draft.transcript.editingMessageIdBySession[cmd.sessionPath] = null;
    appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.text, undefined, new Date(cmd.timestamp).toISOString());
    draft.pending.ops[cmd.corrId] = {
      kind: 'edit',
      sessionPath: cmd.sessionPath,
      localId: cmd.localId,
      previousSummary: null,
    };
    draft.sessions.runningSessionPaths = nextRunningPaths;
  });

  return {
    state: nextState,
    effects: [
      {
        kind: 'EditRpc',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
        messageId: cmd.messageId,
        text: cmd.text,
        localId: cmd.localId,
      },
    ],
  };
}

export function handleTruncateAfter(state: ArchState, cmd: Extract<Command, { kind: 'TruncateAfter' }>): ReducerResult {
  return {
    state,
    effects: [{
      kind: 'TruncateRpc',
      corrId: cmd.corrId,
      sessionPath: cmd.sessionPath,
      messageId: cmd.messageId,
    }],
  };
}

export function handleSetOutcomeDialog(state: ArchState, cmd: Extract<Command, { kind: 'SetOutcomeDialog' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.settings.showOutcomeDialogBySession[cmd.sessionPath] = cmd.visible;
    }),
    effects: [],
  };
}

export function handleDismissNotice(state: ArchState, _cmd: Extract<Command, { kind: 'DismissNotice' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.settings.notice = null;
    }),
    effects: [],
  };
}

export function handleRespondExtensionUI(state: ArchState, cmd: Extract<Command, { kind: 'RespondExtensionUI' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      const sessionMap = draft.settings.pendingExtensionUIRequestsBySession[cmd.sessionPath];
      if (sessionMap) {
        delete sessionMap[cmd.requestId];
        if (Object.keys(sessionMap).length === 0) {
          delete draft.settings.pendingExtensionUIRequestsBySession[cmd.sessionPath];
        }
      }
    }),
    effects: [
      { kind: 'ExtensionUiResponseRpc', corrId: cmd.corrId, sessionPath: cmd.sessionPath, response: cmd.response },
    ],
  };
}

export function handleSetPrefs(state: ArchState, cmd: Extract<Command, { kind: 'SetPrefs' }>): ReducerResult {
  const current = state.settings.prefs;
  const deepMerged: ChatPrefs = {
    ...current,
    ...cmd.prefs,
    ...(cmd.prefs.extensionToggles && {
      extensionToggles: { ...current.extensionToggles, ...cmd.prefs.extensionToggles },
    }),
    ...(cmd.prefs.providerToggles && {
      providerToggles: { ...current.providerToggles, ...cmd.prefs.providerToggles },
    }),
  };
  // Phase 2 cutover: the unread-finished-sessions clear moved here from
  // service.setPrefs (the SetPrefsRpc effect handler). When the merged
  // prefs suppress completion notifications, clear unread finished sessions
  // in the same reducer transition. This is a pure state mutation — no
  // event is dispatched (the previous round-trip through an
  // UnreadFinishedSessionsChanged event is gone).
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        ...(deepMerged.suppressCompletionNotifications
          ? { unreadFinishedSessionPaths: [] }
          : {}),
      },
      settings: {
        ...state.settings,
        prefs: deepMerged,
      },
    },
    effects: [{ kind: 'SetPrefsRpc', corrId: cmd.corrId, prefs: cmd.prefs }],
  };
}

export function handleStartNewTask(state: ArchState, cmd: Extract<Command, { kind: 'StartNewTask' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'StartNewTask',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
      },
    ],
  };
}

export function handleContinueTask(state: ArchState, cmd: Extract<Command, { kind: 'ContinueTask' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'ContinueTask',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
      },
    ],
  };
}

export function handleRecordOutcome(state: ArchState, cmd: Extract<Command, { kind: 'RecordOutcome' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'RecordOutcome',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
        outcome: cmd.outcome,
      },
    ],
  };
}

export function handleSetPruningSettings(state: ArchState, cmd: Extract<Command, { kind: 'SetPruningSettings' }>): ReducerResult {
  // Option B: apply optimistically for instant UI. The service keeps its
  // catch+mirror+notice (graceful degradation when PI_CODING_AGENT_DIR is
  // absent), so SetPruningSettingsResult is always {ok:true} and no
  // snapshot/revert is needed. mergePruningSettings matches the disk-write
  // merge so optimistic state == persisted state.
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        pruningSettings: mergePruningSettings(state.settings.pruningSettings, cmd.settings),
      },
    },
    effects: [
      {
        kind: 'SetPruningSettings',
        corrId: cmd.corrId,
        settings: cmd.settings,
      },
    ],
  };
}
