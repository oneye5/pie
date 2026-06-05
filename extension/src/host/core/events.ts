/**
 * Phase 2 type spine — `Event` discriminated union.
 *
 * Events are inputs to the reducer. They include:
 *  - User intents wrapped as `{kind:'Command', cmd}` (Phase 4 will rewire the
 *    webview message handler to dispatch these instead of calling helpers).
 *  - Results of effects executed by `EffectRunner` (each `*Rpc` effect has a
 *    matching `*Result` event carrying the same `corrId`).
 *  - Backend events forwarded by the backend event parser (unified in Phase 5+).
 *
 * This file is the future replacement for ad-hoc helper calls scattered
 * across the host. Today, no code dispatches these events yet.
 */

import type { Command } from './commands';
import type {
  ChatMessage,
  ToolCall,
  ContextWindowUsage,
  SessionSummary,
  ExtensionUIRequestPayload,
  SessionOpenedPayload,
} from '../../shared/protocol';

/** Wraps a `Command` so it can flow through the same event channel. */
export interface CommandEvent {
  kind: 'Command';
  cmd: Command;
}

// ─── Effect result events ────────────────────────────────────────────────────

export interface SendResultEvent {
  kind: 'SendResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  /** Backend-assigned request ID, used to bind events to sessions. */
  requestId?: string;
  error?: string;
}

export interface EditResultEvent {
  kind: 'EditResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface InterruptResultEvent {
  kind: 'InterruptResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface TruncateResultEvent {
  kind: 'TruncateResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface OpenSessionResultEvent {
  kind: 'OpenSessionResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface CreateSessionResultEvent {
  kind: 'CreateSessionResult';
  corrId: string;
  ok: boolean;
  /** The session path the backend allocated, if ok. */
  sessionPath?: string;
  error?: string;
}

export interface PersistTabsResultEvent {
  kind: 'PersistTabsResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export type EffectResultEvent =
  | SendResultEvent
  | EditResultEvent
  | InterruptResultEvent
  | TruncateResultEvent
  | OpenSessionResultEvent
  | CreateSessionResultEvent
  | PersistTabsResultEvent;

// ─── Backend streaming events ─────────────────────────────────────────────────
// These wrap PI backend events so they flow through the reducer.

export interface MessageStartedEvent {
  kind: 'MessageStarted';
  sessionPath: string;
  messageId: string;
  requestId?: string;
  modelId?: string;
  thinkingLevel?: ChatMessage['thinkingLevel'];
}

export interface MessageDeltaEvent {
  kind: 'MessageDelta';
  sessionPath: string;
  messageId: string;
  delta: string;
}

export interface MessageThinkingEvent {
  kind: 'MessageThinking';
  sessionPath: string;
  messageId: string;
  thinking: string;
}

export interface MessageAbortedEvent {
  kind: 'MessageAborted';
  sessionPath: string;
  messageId?: string;
}

export interface ToolCallEvent {
  kind: 'ToolCall';
  sessionPath: string;
  messageId: string;
  toolCall: ToolCall;
}

export interface MessageFinishedEvent {
  kind: 'MessageFinished';
  sessionPath: string;
  message: ChatMessage;
}

/** Emitted when a session starts or stops streaming. */
export interface BusyChangedEvent {
  kind: 'BusyChanged';
  sessionPath: string;
  running: boolean;
}

/** Emitted when a session finishes streaming (complement to BusyChanged). */
export interface BusyCompletedEvent {
  kind: 'BusyCompleted';
  sessionPath: string;
}

/** Emitted when context window usage changes for a session. */
export interface ContextUsageChangedEvent {
  kind: 'ContextUsageChanged';
  sessionPath: string;
  contextUsage: ContextWindowUsage | null;
}

/** Emitted when the backend's session list changes. */
export interface SessionListChangedEvent {
  kind: 'SessionListChanged';
  sessionSummaries: SessionSummary[];
}

/** Emitted when the backend sends a custom message (e.g., pruning result). */
export interface CustomMessageEvent {
  kind: 'CustomMessage';
  sessionPath: string;
  message: ChatMessage;
}

/** Emitted when the backend requests an extension UI interaction. */
export interface ExtensionUIRequestEvent {
  kind: 'ExtensionUIRequest';
  sessionPath: string;
  request: ExtensionUIRequestPayload;
}

/** Emitted when the host wants to show (or clear) a user-facing notice. */
export interface NoticeShownEvent {
  kind: 'NoticeShown';
  notice: string | null;
}

/** Emitted when the backend reports an error. */
export interface ErrorEvent {
  kind: 'Error';
  sessionPath: string;
  error: string;
}

/** Emitted when a session is opened and its data is loaded. */
export interface SessionOpenedEvent {
  kind: 'SessionOpened';
  sessionPath: string;
  payload: SessionOpenedPayload;
}

/** Emitted by the host when a session tab is closed. */
export interface SessionClosedEvent {
  kind: 'SessionClosed';
  sessionPath: string;
}

/** Emitted when the host derives an optimistic session name from the first message text. */
export interface SessionNameDerivedEvent {
  kind: 'SessionNameDerived';
  sessionPath: string;
  name: string;
}

/** Emitted when an optimistic local user message is inserted into the transcript. */
export interface OptimisticMessageInsertedEvent {
  kind: 'OptimisticMessageInserted';
  sessionPath: string;
  localId: string;
  text: string;
  timestamp: number;
}

/** Emitted when an optimistic local user message is removed from the transcript. */
export interface OptimisticMessageRemovedEvent {
  kind: 'OptimisticMessageRemoved';
  sessionPath: string;
  localId: string;
}

/** Emitted when a file change entry is removed (e.g. on revert). */
export interface FileChangeRemovedEvent {
  kind: 'FileChangeRemoved';
  sessionPath: string;
  filePath: string;
}

export type BackendEvent =
  | MessageStartedEvent
  | MessageAbortedEvent
  | MessageDeltaEvent
  | MessageThinkingEvent
  | ToolCallEvent
  | MessageFinishedEvent
  | BusyChangedEvent
  | BusyCompletedEvent
  | ContextUsageChangedEvent
  | SessionListChangedEvent
  | CustomMessageEvent
  | ExtensionUIRequestEvent
  | ErrorEvent
  | SessionOpenedEvent
  | SessionClosedEvent;

export type Event = CommandEvent | EffectResultEvent | BackendEvent | NoticeShownEvent | SessionNameDerivedEvent | OptimisticMessageInsertedEvent | OptimisticMessageRemovedEvent | FileChangeRemovedEvent;