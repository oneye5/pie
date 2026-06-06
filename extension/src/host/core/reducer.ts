/**
 * Top-level reducer: `(state, event) → {state, effects}`.
 *
 * The reducer is **pure**: no I/O, no globals, no mutation of input.
 * Effects are queued descriptively; the `EffectRunner` executes them and
 * dispatches result events back.
 *
 * Transcript mutations use Immer's `produce` so that mutation-style helpers
 * (appendAssistantTextPart, upsertAssistantToolCall, etc.) can operate on
 * the draft directly. Simple field updates continue using spread-operator
 * patterns.
 *
 * **State-shape rule (binding):** keyed collections in `ArchState` MUST use
 * `Record<string, T>` — never `Map`/`Set`. RTK + Immer reject mutating those
 * built-ins without an explicit `enableMapSet()` opt-in; treat that opt-in as
 * a deliberate decision, not a default.
 */

import { createInitialArchState } from './arch-state.js';
import type { ArchState } from './arch-state.js';
import type { Event } from './events.js';

// Re-export for downstream consumers that import from './reducer'
export type { ArchState, PendingOp, CurrentTurn } from './arch-state.js';
export { createInitialArchState } from './arch-state.js';

/** Reducer result using the real Effect type from effects.ts. */
export type ReducerResult = import('./reducer/helpers.js').ReducerResult;

/** Pre-created initial state for convenience. */
const initialArchState: ArchState = createInitialArchState();
export { initialArchState };

// Handler modules
import { handleCommand } from './reducer/command-handlers.js';
import { handleEffectResult } from './reducer/result-handlers.js';
import { handleStreamingEvent } from './reducer/streaming-handlers.js';
import {
  handleSessionClosed,
  handleSessionListChanged,
  handleSessionOpened,
  handleSessionNameDerived,
  handleBusyChanged,
  handleBusyCompleted,
  handleContextUsageChanged,
} from './reducer/session-handlers.js';
import {
  handleCustomMessage,
  handleExtensionUIRequest,
  handleError,
  handleNoticeShown,
} from './reducer/ui-handlers.js';
import {
  handleOptimisticMessageInserted,
  handleOptimisticMessageRemoved,
  handleFileChangeRemoved,
} from './reducer/optimistic-handlers.js';
import {
  handleTruncateResult,
  handleCreateSessionResult,
  handleOpenSessionResult,
  handlePersistTabsResult,
} from './reducer/misc-handlers.js';

/**
 * Reducer: routes events to per-kind handlers.
 */
export function reducer(state: ArchState, event: Event): ReducerResult {
  switch (event.kind) {
    case 'Command': {
      return handleCommand(state, event.cmd);
    }

    // ─── Effect result events ─────────────────────────────────────────

    case 'InterruptResult':
    case 'SendResult':
    case 'EditResult': {
      return handleEffectResult(state, event);
    }

    // ─── Backend streaming events ─────────────────────────────────────────

    case 'MessageStarted':
    case 'MessageAborted':
    case 'MessageDelta':
    case 'MessageThinking':
    case 'ToolCall':
    case 'MessageFinished': {
      return handleStreamingEvent(state, event);
    }

    // ─── Session lifecycle events ─────────────────────────────────────────

    case 'SessionClosed': {
      return handleSessionClosed(state, event);
    }

    case 'SessionNameDerived': {
      return handleSessionNameDerived(state, event);
    }

    case 'SessionOpened': {
      // Kept inline for now (matches handleSessionOpened in session-handlers)
      return handleSessionOpened(state, event);
    }

    case 'BusyChanged': {
      return handleBusyChanged(state, event);
    }

    case 'BusyCompleted': {
      return handleBusyCompleted(state, event);
    }

    case 'ContextUsageChanged': {
      return handleContextUsageChanged(state, event);
    }

    case 'SessionListChanged': {
      return handleSessionListChanged(state, event);
    }

    // ─── UI events ─────────────────────────────────────────────────────────

    case 'CustomMessage': {
      return handleCustomMessage(state, event);
    }

    case 'ExtensionUIRequest': {
      return handleExtensionUIRequest(state, event);
    }

    case 'Error': {
      return handleError(state, event);
    }

    case 'NoticeShown': {
      return handleNoticeShown(state, event);
    }

    // ─── Optimistic UI events ──────────────────────────────────────────────

    case 'OptimisticMessageInserted': {
      return handleOptimisticMessageInserted(state, event);
    }

    case 'OptimisticMessageRemoved': {
      return handleOptimisticMessageRemoved(state, event);
    }

    case 'FileChangeRemoved': {
      return handleFileChangeRemoved(state, event);
    }

    // ─── Result stubs ──────────────────────────────────────────────────────

    case 'TruncateResult': {
      return handleTruncateResult(state, event);
    }

    case 'CreateSessionResult': {
      return handleCreateSessionResult(state, event);
    }

    case 'OpenSessionResult': {
      return handleOpenSessionResult(state, event);
    }

    case 'PersistTabsResult': {
      return handlePersistTabsResult(state, event);
    }

    default:
      return { state, effects: [] };
  }
}