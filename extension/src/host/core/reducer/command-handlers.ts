import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import { mergePruningSettings, type ChatPrefs, type ComposerInput, type ModelSettings } from '../../../shared/protocol.js';
import type { ReducerResult } from './helpers.js';
import { addToArray, removeFromArray, removeSessionFromState, appendLocalUserMessage } from './helpers.js';
import { moveOpenTabPath, isPendingTabPath } from '../../../shared/tab-behavior.js';
import { modelSupportsInputKind } from '../model-capability.js';
import { applySetModelOptimistic } from './set-model-handlers.js';
import type { Command } from '../commands.js';

export function handleCommand(state: ArchState, cmd: Command): ReducerResult {
  switch (cmd.kind) {
    case 'Interrupt': {
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

    case 'Send': {
      // Insert optimistic user message + mark session busy immediately so the webview
      // shows an activity indicator right away (instead of waiting for the backend's
      // agent_start event which fires after the pruning prepass).
      const nextRunningPaths = addToArray(state.sessions.runningSessionPaths, cmd.sessionPath);
      const nextState = produce(state, (draft) => {
        appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts, new Date(cmd.timestamp).toISOString());
        draft.pending.ops[cmd.corrId] = {
          kind: 'send',
          sessionPath: cmd.sessionPath,
          localId: cmd.localId,
          previousSummary: cmd.previousSummary,
        };
        draft.sessions.runningSessionPaths = nextRunningPaths;
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

    case 'Edit': {
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

    case 'TruncateAfter': {
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

    case 'OpenSession': {
      return {
        state,
        effects: [{
          kind: 'OpenSession',
          corrId: cmd.corrId,
          sessionPath: cmd.sessionPath,
          selectionToken: cmd.selectionToken,
        }],
      };
    }

    case 'CreateSession': {
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

    case 'HydrateModel': {
      // No state change: emit a fire-and-forget effect. The runner calls the
      // service; the service's dispatched SetModel/AvailableModelsChanged
      // events apply the results, so no *Result event is produced here.
      return {
        state,
        effects: [{ kind: 'HydrateModel', corrId: cmd.corrId, sessionPath: cmd.sessionPath }],
      };
    }

    case 'SetModel': {
      const { sessionPath, modelSettings } = cmd;

      // Relocated guard (was service.requireOpenSessionPath): the reducer owns
      // the precondition so an invalid request can't leave an optimistic
      // modelSettings change un-reverted. The old path applied optimistically in
      // the reducer, then the service guard bailed without reverting — so a
      // setModel aimed at a closed/pending session silently flipped the global
      // default and never rolled back.
      const guardNotice = !sessionPath
        ? 'Cannot set model: missing session reference.'
        : isPendingTabPath(sessionPath)
          ? 'Cannot set model: the session is still opening.'
          : !state.sessions.openTabPaths.includes(sessionPath)
            ? 'Cannot set model: the selected session is no longer open.'
            : null;
      if (guardNotice) {
        return {
          state: { ...state, settings: { ...state.settings, notice: guardNotice } },
          effects: [],
        };
      }

      // Decide whether the switch would drop pending image inputs. This is a
      // pure read of ArchState (pending inputs + the requested model's input
      // capabilities), so the reducer owns the decision and gates the
      // optimistic apply on the user's modal confirmation. The user-facing
      // copy lives in the emitted effect, not in a service call.
      const pendingInputs = state.composer.pendingComposerInputsBySession[sessionPath] ?? [];
      const hasPendingImageInputs = pendingInputs.some((input) => input.kind === 'imageBlob');
      const requestedModelSupportsImages = modelSupportsInputKind(
        sessionPath,
        modelSettings.defaultModel,
        'image',
        () => state,
      );
      const shouldClearPendingImages = hasPendingImageInputs && requestedModelSupportsImages === false;

      if (shouldClearPendingImages) {
        // Stash the intent and ask the user via a modal Effect. No state changes
        // until confirmation, so an abort leaves everything untouched — fixes
        // the old bug where the optimistic apply survived a "Cancel".
        const next = produce(state, (draft) => {
          draft.pending.setModelByCorrId[cmd.corrId] = {
            sessionPath,
            modelSettings,
            snapshot: null,
          };
        });
        return {
          state: next,
          effects: [{
            kind: 'ShowModelSwitchConfirm',
            corrId: cmd.corrId,
            sessionPath,
            modelSettings,
            message:
              'Switching to this model will remove pending pasted images because it does not support image inputs.',
            confirmChoice: 'Switch Model',
          }],
        };
      }

      // No modal needed: apply optimistically (no image clear here — either
      // there are no pending images to lose, or the new model still supports
      // them) and emit the backend write.
      return {
        state: applySetModelOptimistic(state, cmd.corrId, sessionPath, modelSettings, false),
        effects: [{ kind: 'SetModelRpc', corrId: cmd.corrId, sessionPath, modelSettings }],
      };
    }

    case 'SetPrefs': {
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

    case 'SelectSession': {
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

    case 'CloseTab': {
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

    case 'OpenFileDiff': {
      return {
        state,
        effects: [
          {
            kind: 'FileDiff',
            corrId: cmd.corrId,
            sessionPath: cmd.sessionPath,
            filePath: cmd.filePath,
            status: cmd.status,
          },
        ],
      };
    }

    case 'RevertFile': {
      return {
        state,
        effects: [
          {
            kind: 'FileRevert',
            corrId: cmd.corrId,
            sessionPath: cmd.sessionPath,
            filePath: cmd.filePath,
          },
        ],
      };
    }

    case 'CloseSession': {
      const { state: removedState } = removeSessionFromState(state, cmd.sessionPath);
      return {
        state: removedState,
        effects: [{ kind: 'CloseSession', corrId: cmd.corrId, sessionPath: cmd.sessionPath }],
      };
    }

    case 'PersistTabs': {
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

    case 'AddComposerInput': {
      const input: ComposerInput = { ...cmd.input, id: `${cmd.corrId}:input` } as ComposerInput;
      const existing = state.composer.pendingComposerInputsBySession[cmd.sessionPath] ?? [];
      return {
        state: {
          ...state,
          composer: {
            ...state.composer,
            pendingComposerInputsBySession: {
              ...state.composer.pendingComposerInputsBySession,
              [cmd.sessionPath]: [...existing, input],
            },
          },
        },
        effects: [],
      };
    }

    case 'RemoveComposerInput': {
      const existing = state.composer.pendingComposerInputsBySession[cmd.sessionPath] ?? [];
      return {
        state: {
          ...state,
          composer: {
            ...state.composer,
            pendingComposerInputsBySession: {
              ...state.composer.pendingComposerInputsBySession,
              [cmd.sessionPath]: existing.filter((inp) => inp.id !== cmd.inputId),
            },
          },
        },
        effects: [],
      };
    }

    case 'SetComposerDraft': {
      return {
        state: produce(state, (draft) => {
          draft.composer.draftTextBySession[cmd.sessionPath] = cmd.text;
        }),
        effects: [],
      };
    }

    case 'SetEditingMessage': {
      return {
        state: produce(state, (draft) => {
          draft.transcript.editingMessageIdBySession[cmd.sessionPath] = cmd.messageId;
        }),
        effects: [],
      };
    }

    case 'SetOutcomeDialog': {
      return {
        state: produce(state, (draft) => {
          draft.settings.showOutcomeDialogBySession[cmd.sessionPath] = cmd.visible;
        }),
        effects: [],
      };
    }

    case 'DismissNotice': {
      return {
        state: produce(state, (draft) => {
          draft.settings.notice = null;
        }),
        effects: [],
      };
    }

    case 'RespondExtensionUI': {
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
          ...(cmd.approved ? [{ kind: 'PostImperative' as const, corrId: cmd.corrId, imperativeMessage: { type: 'extensionUiApproved', sessionPath: cmd.sessionPath } }] : []),
        ],
      };
    }

    case 'AddFilesystemPaths': {
      return {
        state,
        effects: [
          {
            kind: 'AddFilesystemPaths',
            corrId: cmd.corrId,
            sessionPath: cmd.sessionPath,
            paths: cmd.paths,
            source: cmd.source,
          },
        ],
      };
    }

    case 'LoadOlderTranscript': {
      // In-flight guard: at most one transcript paging request per session.
      // The reducer owns this flag (moved from the host-side Set on
      // SessionMessageActions); the matching LoadOlderTranscriptResult clears
      // it and SessionScopeCleared clears it on tab close. The flag is keyed
      // by the Command corrId so a stale result from a superseded request
      // (tab closed + reopened) cannot clear the current request's flag.
      if (state.transcript.pagingInFlightBySession[cmd.sessionPath]) {
        return { state, effects: [] };
      }
      return {
        state: {
          ...state,
          transcript: {
            ...state.transcript,
            pagingInFlightBySession: {
              ...state.transcript.pagingInFlightBySession,
              [cmd.sessionPath]: cmd.corrId,
            },
          },
        },
        effects: [
          {
            kind: 'LoadOlderTranscript',
            corrId: cmd.corrId,
            sessionPath: cmd.sessionPath,
          },
        ],
      };
    }

    case 'LoadNewerTranscript': {
      // In-flight guard — see LoadOlderTranscript.
      if (state.transcript.pagingInFlightBySession[cmd.sessionPath]) {
        return { state, effects: [] };
      }
      return {
        state: {
          ...state,
          transcript: {
            ...state.transcript,
            pagingInFlightBySession: {
              ...state.transcript.pagingInFlightBySession,
              [cmd.sessionPath]: cmd.corrId,
            },
          },
        },
        effects: [
          {
            kind: 'LoadNewerTranscript',
            corrId: cmd.corrId,
            sessionPath: cmd.sessionPath,
          },
        ],
      };
    }

    case 'JumpToLatestTranscript': {
      // In-flight guard — see LoadOlderTranscript.
      if (state.transcript.pagingInFlightBySession[cmd.sessionPath]) {
        return { state, effects: [] };
      }
      return {
        state: {
          ...state,
          transcript: {
            ...state.transcript,
            pagingInFlightBySession: {
              ...state.transcript.pagingInFlightBySession,
              [cmd.sessionPath]: cmd.corrId,
            },
          },
        },
        effects: [
          {
            kind: 'JumpToLatestTranscript',
            corrId: cmd.corrId,
            sessionPath: cmd.sessionPath,
          },
        ],
      };
    }

    case 'RecordOutcome': {
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

    case 'StartNewTask': {
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

    case 'ContinueTask': {
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

    case 'OpenFileInEditor': {
      return {
        state,
        effects: [
          {
            kind: 'OpenFileInEditor',
            corrId: cmd.corrId,
            sessionPath: cmd.sessionPath,
            filePath: cmd.filePath,
          },
        ],
      };
    }

    case 'OpenFile': {
      return {
        state,
        effects: [
          {
            kind: 'OpenFile',
            corrId: cmd.corrId,
            path: cmd.path,
          },
        ],
      };
    }

    case 'SetPruningSettings': {
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

    case 'DuplicateSession': {
      return {
        state,
        effects: [
          {
            kind: 'DuplicateSession',
            corrId: cmd.corrId,
            sessionPath: cmd.sessionPath,
          },
        ],
      };
    }

    case 'MoveSessionTab': {
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

    default: {
      // Exhaustiveness: the switch is total over `Command`. The `never`
      // assignment makes an unhandled Command variant a compile-time error.
      const _exhaustive: never = cmd;
      void _exhaustive;
      return {
        state,
        effects: [
          {
            kind: 'Log',
            corrId: '',
            level: 'error',
            message: `handleCommand: unhandled command kind (type system bypassed?): ${(cmd as { kind?: string }).kind}`,
          },
        ],
      };
    }
  }
}