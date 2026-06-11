import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { ChatPrefs, ComposerInput } from '../../../shared/protocol.js';
import type { ReducerResult } from './helpers.js';
import { addToArray, removeFromArray, removeSessionFromState, appendLocalUserMessage } from './helpers.js';
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
        appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts);
        draft.pending.ops[cmd.corrId] = {
          kind: 'send',
          sessionPath: cmd.sessionPath,
          localId: cmd.localId,
          previousSummary: cmd.previousSummary,
        };
        draft.sessions.runningSessionPaths = nextRunningPaths;
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
          },
        ],
      };
    }

    case 'Edit': {
      // Insert optimistic edit message + mark session busy immediately so the
      // webview shows an activity indicator right away.
      const nextRunningPaths = addToArray(state.sessions.runningSessionPaths, cmd.sessionPath);
      const nextState = produce(state, (draft) => {
        draft.transcript.editingMessageId = null;
        appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.text, undefined);
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
          },
        ],
      };
    }

    case 'SetModel': {
      return {
        state: {
          ...state,
          settings: {
            ...state.settings,
            modelSettings: cmd.modelSettings,
          },
        },
        effects: [],
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
      return {
        state: {
          ...state,
          settings: {
            ...state.settings,
            prefs: deepMerged,
          },
        },
        effects: [],
      };
    }

    case 'SelectSession': {
      return {
        state: {
          ...state,
          sessions: {
            ...state.sessions,
            activeSessionPath: cmd.sessionPath,
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

    case 'ReorderTabs': {
      return {
        state: {
          ...state,
          sessions: {
            ...state.sessions,
            openTabPaths: cmd.openTabPaths,
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

    case 'ExportAnalytics': {
      return {
        state,
        effects: [
          {
            kind: 'ExportRunAnalytics',
            corrId: cmd.corrId,
            sessionPath: cmd.sessionPath,
          },
        ],
      };
    }

    case 'CloseSession': {
      return removeSessionFromState(state, cmd.sessionPath);
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

    case 'SetEditingMessage': {
      return {
        state: produce(state, (draft) => {
          draft.transcript.editingMessageId = cmd.messageId;
        }),
        effects: [],
      };
    }

    case 'SetOutcomeDialog': {
      return {
        state: produce(state, (draft) => {
          draft.settings.showOutcomeDialog = cmd.visible;
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
          delete draft.settings.pendingExtensionUIRequestsBySession[cmd.sessionPath];
        }),
        effects: cmd.approved
          ? [{ kind: 'PostImperative' as const, corrId: cmd.corrId, imperativeMessage: { type: 'extensionUiApproved', sessionPath: cmd.sessionPath } }]
          : [],
      };
    }

    default:
      return { state, effects: [] };
  }
}