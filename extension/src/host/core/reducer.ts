/**
 * Top-level reducer: `(state, event) → {state, effects}`.
 *
 * The reducer is **pure**: no I/O, no globals, no mutation of input.
 * Effects are queued descriptively; the `EffectRunner` executes them and
 * dispatches result events back.
 *
 * Phase 3 adds the first real handler: `Interrupt`. Legacy Redux slices
 * continue to own all other state until later phases migrate them.
 *
 * **State-shape rule (binding):** keyed collections in `ArchState` MUST use
 * `Record<string, T>` — never `Map`/`Set`. RTK + Immer reject mutating those
 * built-ins without an explicit `enableMapSet()` opt-in; treat that opt-in as
 * a deliberate decision, not a default.
 */

import type { Event } from './events';
import type { Effect } from './effects';
import type { ChatMessage, SessionSummary, UserContentPart } from '../../shared/protocol';

/** Per-session state tracked by the new architecture. */
export interface SessionArchState {
  interruptInFlight: boolean;
}

/** Tracks the first message of the active streaming turn per session. */
export interface CurrentTurn {
  requestId: string;
  firstMessageId: string;
}

/** Tracks an in-flight optimistic send or edit for rollback on failure. */
export interface PendingOp {
  kind: 'send' | 'edit';
  sessionPath: string;
  /** The local transcript entry ID inserted optimistically. */
  localId: string;
  /** Session summary snapshot before optimistic name change (null = no change). */
  previousSummary: SessionSummary | null;
}

/**
 * Top-level arch state. Slots are intentionally `Record<string, ...>` rather
 * than `Map<...>` to remain compatible with RTK/Immer middleware.
 */
export interface ArchState {
  /** Optimistic pending operations keyed by `corrId`. */
  pending: Record<string, PendingOp>;
  /** Per-session arch state keyed by session path. */
  sessions: Record<string, SessionArchState>;
  /** Maps aliased message IDs to canonical IDs (for multi-turn continuations). */
  messageIdAlias: Record<string, string>;
  /** Tracks the first message of the current streaming turn per session. */
  currentTurnBySession: Record<string, CurrentTurn>;
}

export const initialArchState: ArchState = {
  pending: {},
  sessions: {},
  messageIdAlias: {},
  currentTurnBySession: {},
};

export interface ReducerResult {
  state: ArchState;
  effects: Effect[];
}

function getSession(state: ArchState, sessionPath: string): SessionArchState {
  return state.sessions[sessionPath] ?? { interruptInFlight: false };
}

function resolveAlias(state: ArchState, messageId: string): string {
  return state.messageIdAlias[messageId] ?? messageId;
}

/**
 * Reducer: routes events to per-kind handlers.
 * Handles: Interrupt, Send, Edit commands and their result events.
 */
export function reducer(state: ArchState, event: Event): ReducerResult {
  switch (event.kind) {
    case 'Command': {
      const { cmd } = event;
      switch (cmd.kind) {
        case 'Interrupt': {
          const session = getSession(state, cmd.sessionPath);
          return {
            state: {
              ...state,
              sessions: {
                ...state.sessions,
                [cmd.sessionPath]: { ...session, interruptInFlight: true },
              },
            },
            effects: [{ kind: 'InterruptRpc', corrId: cmd.corrId, sessionPath: cmd.sessionPath }],
          };
        }

        case 'Send': {
          const effects: Effect[] = [
            {
              kind: 'InsertOptimisticMessage',
              corrId: cmd.corrId,
              sessionPath: cmd.sessionPath,
              localId: cmd.localId,
              text: cmd.composedText,
              userParts: cmd.userParts,
            },
            {
              kind: 'SendRpc',
              corrId: cmd.corrId,
              sessionPath: cmd.sessionPath,
              text: cmd.text,
              inputs: cmd.inputs,
            },
          ];
          return {
            state: {
              ...state,
              pending: {
                ...state.pending,
                [cmd.corrId]: {
                  kind: 'send',
                  sessionPath: cmd.sessionPath,
                  localId: cmd.localId,
                  previousSummary: cmd.previousSummary,
                },
              },
            },
            effects,
          };
        }

        case 'Edit': {
          const effects: Effect[] = [
            {
              kind: 'InsertOptimisticMessage',
              corrId: cmd.corrId,
              sessionPath: cmd.sessionPath,
              localId: cmd.localId,
              text: cmd.text,
            },
            {
              kind: 'EditRpc',
              corrId: cmd.corrId,
              sessionPath: cmd.sessionPath,
              messageId: cmd.messageId,
              text: cmd.text,
            },
          ];
          return {
            state: {
              ...state,
              pending: {
                ...state.pending,
                [cmd.corrId]: {
                  kind: 'edit',
                  sessionPath: cmd.sessionPath,
                  localId: cmd.localId,
                  previousSummary: null,
                },
              },
            },
            effects,
          };
        }

        default:
          return { state, effects: [] };
      }
    }

    case 'InterruptResult': {
      const session = getSession(state, event.sessionPath);
      const effects: Effect[] = [];
      if (!event.ok) {
        effects.push({
          kind: 'Log',
          corrId: event.corrId,
          level: 'error',
          message: `Interrupt failed for session ${event.sessionPath}`,
          data: { error: event.error },
        });
      } else {
        // Watchdog: backend acked the interrupt. Clear `running` immediately so
        // the composer returns to Send mode even if `busy.changed { busy: false }`
        // never arrives (malformed line, dropped event, premature stream death,
        // etc.). If the backend later emits busy=true again, the running flag
        // will re-bump from the live event stream — this is purely escape-valve.
        effects.push({
          kind: 'SetSessionRunning',
          corrId: event.corrId,
          sessionPath: event.sessionPath,
          running: false,
        });
      }
      return {
        state: {
          ...state,
          sessions: {
            ...state.sessions,
            [event.sessionPath]: { ...session, interruptInFlight: false },
          },
        },
        effects,
      };
    }

    case 'SendResult': {
      const pending = state.pending[event.corrId];
      if (!pending) return { state, effects: [] };

      const { [event.corrId]: _removed, ...rest } = state.pending;
      const nextState: ArchState = { ...state, pending: rest };

      if (event.ok) {
        return {
          state: nextState,
          effects: [{ kind: 'ClearComposerInputs', corrId: event.corrId, sessionPath: pending.sessionPath }],
        };
      }

      // Failure: rollback optimistic message + session name + notify user.
      const effects: Effect[] = [
        { kind: 'RemoveOptimisticMessage', corrId: event.corrId, sessionPath: pending.sessionPath, localId: pending.localId },
        { kind: 'PostImperative', corrId: event.corrId, imperativeMessage: { type: 'sendRejected', sessionPath: pending.sessionPath, localId: pending.localId } },
        { kind: 'SetNotice', corrId: event.corrId, message: `Failed to send message: ${event.error ?? 'unknown error'}` },
      ];
      if (pending.previousSummary) {
        effects.push({ kind: 'RestoreSessionSummary', corrId: event.corrId, summary: pending.previousSummary });
      }
      return { state: nextState, effects };
    }

    case 'EditResult': {
      const pending = state.pending[event.corrId];
      if (!pending) return { state, effects: [] };

      const { [event.corrId]: _removed, ...rest } = state.pending;
      const nextState: ArchState = { ...state, pending: rest };

      if (event.ok) {
        return { state: nextState, effects: [] };
      }

      // Failure: rollback the optimistic edit message + notify user.
      const effects: Effect[] = [
        { kind: 'RemoveOptimisticMessage', corrId: event.corrId, sessionPath: pending.sessionPath, localId: pending.localId },
        { kind: 'SetNotice', corrId: event.corrId, message: `Failed to edit message: ${event.error ?? 'unknown error'}` },
      ];
      return { state: nextState, effects };
    }

    // ─── Backend streaming events ─────────────────────────────────────────
    // These produce sync effects that dispatch to the Redux transcript store.
    // The reducer resolves message ID aliases before emitting effects so
    // downstream consumers always receive canonical IDs.

    case 'MessageStarted': {
      const { sessionPath, messageId, requestId, modelId, thinkingLevel } = event;
      const corrId = `started:${sessionPath}:${messageId}`;
      const currentTurn = state.currentTurnBySession[sessionPath];

      // If requestId matches the current turn, this is a continuation — alias it.
      if (requestId && currentTurn && currentTurn.requestId === requestId) {
        const nextState: ArchState = {
          ...state,
          messageIdAlias: { ...state.messageIdAlias, [messageId]: currentTurn.firstMessageId },
        };
        return {
          state: nextState,
          effects: [
            {
              kind: 'EnsureAssistantMessage', corrId, sessionPath, messageId,
              canonicalMessageId: currentTurn.firstMessageId,
              isAlias: true, requestId, modelId, thinkingLevel,
            },
            { kind: 'ScheduleRender', corrId },
          ],
        };
      }

      // New turn — update currentTurnBySession.
      const nextState: ArchState = requestId
        ? {
          ...state,
          currentTurnBySession: {
            ...state.currentTurnBySession,
            [sessionPath]: { requestId, firstMessageId: messageId },
          },
        }
        : state;

      return {
        state: nextState,
        effects: [
          {
            kind: 'EnsureAssistantMessage', corrId, sessionPath, messageId,
            canonicalMessageId: messageId,
            isAlias: false, requestId, modelId, thinkingLevel,
          },
          { kind: 'ScheduleRender', corrId },
        ],
      };
    }

    case 'MessageAborted': {
      const { sessionPath, messageId } = event;
      const corrId = `aborted:${sessionPath}:${messageId ?? 'unknown'}`;
      if (!messageId) {
        return { state, effects: [{ kind: 'ScheduleRender', corrId }] };
      }
      const canonicalId = resolveAlias(state, messageId);
      return {
        state,
        effects: [
          { kind: 'SetMessageStatus', corrId, sessionPath, messageId: canonicalId, status: 'interrupted' },
          { kind: 'ScheduleRender', corrId },
        ],
      };
    }

    case 'MessageDelta': {
      const messageId = resolveAlias(state, event.messageId);
      const corrId = `delta:${event.sessionPath}:${messageId}`;
      return {
        state,
        effects: [
          { kind: 'AppendDelta', corrId, sessionPath: event.sessionPath, messageId, delta: event.delta },
          { kind: 'ScheduleRender', corrId },
        ],
      };
    }

    case 'MessageThinking': {
      const messageId = resolveAlias(state, event.messageId);
      const corrId = `thinking:${event.sessionPath}:${messageId}`;
      return {
        state,
        effects: [
          { kind: 'AppendThinking', corrId, sessionPath: event.sessionPath, messageId, thinking: event.thinking },
          { kind: 'ScheduleRender', corrId },
        ],
      };
    }

    case 'ToolCall': {
      const messageId = resolveAlias(state, event.messageId);
      const corrId = `tool:${event.sessionPath}:${event.toolCall.id}`;
      return {
        state,
        effects: [
          { kind: 'UpsertToolCall', corrId, sessionPath: event.sessionPath, messageId, toolCall: event.toolCall },
          { kind: 'ScheduleRender', corrId },
        ],
      };
    }

    case 'MessageFinished': {
      const messageId = resolveAlias(state, event.message.id);
      const corrId = `finished:${event.sessionPath}:${messageId}`;
      const isAlias = messageId !== event.message.id;
      return {
        state,
        effects: [
          {
            kind: 'UpsertMessage', corrId, sessionPath: event.sessionPath,
            message: event.message,
            ...(isAlias ? { canonicalMessageId: messageId } : {}),
          },
          { kind: 'ScheduleRender', corrId },
        ],
      };
    }

    case 'SessionClosed': {
      // Drop all per-session bookkeeping so a re-opened session at the same
      // path (or a different session that recycles a corrId) cannot pick up
      // ghosts from the closed one (B4).
      const { [event.sessionPath]: _droppedSession, ...remainingSessions } = state.sessions;
      const { [event.sessionPath]: _droppedTurn, ...remainingTurns } = state.currentTurnBySession;

      const remainingPending: Record<string, PendingOp> = {};
      for (const [corrId, op] of Object.entries(state.pending)) {
        if (op.sessionPath !== event.sessionPath) remainingPending[corrId] = op;
      }

      // Alias map is keyed by messageId, not sessionPath, so we can't filter
      // it precisely here without tracking ownership. Leave it — alias entries
      // are bounded by message IDs which won't collide across sessions in
      // practice. If they do, the canonical lookup just resolves to an unused
      // message ID. (Documented limitation; revisit if it surfaces.)

      return {
        state: {
          ...state,
          sessions: remainingSessions,
          currentTurnBySession: remainingTurns,
          pending: remainingPending,
        },
        effects: [],
      };
    }

    default:
      return { state, effects: [] };
  }
}
