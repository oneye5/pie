/**
 * Phase 2 type spine — `Event` discriminated union.
 *
 * Events are inputs to the reducer. They include:
 *  - User intents wrapped as `{kind:'Command', cmd}` (Phase 4 will rewire the
 *    webview message handler to dispatch these instead of calling helpers).
 *  - Results of effects executed by `EffectRunner` (each `*Rpc` effect has a
 *    matching `*Result` event carrying the same `corrId`).
 *  - Backend events forwarded by `SessionEventDispatcher` (will be unified in
 *    a later phase).
 *
 * This file is the future replacement for ad-hoc helper calls scattered
 * across the host. Today, no code dispatches these events yet.
 */

import type { Command } from './commands';

/** Wraps a `Command` so it can flow through the same event channel. */
export interface CommandEvent {
  kind: 'Command';
  cmd: Command;
}

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

import type { ChatMessage, ToolCall } from '../../shared/protocol';

export interface MessageStartedEvent {
  kind: 'MessageStarted';
  sessionPath: string;
  messageId: string;
  requestId?: string;
  modelId?: string;
  thinkingLevel?: ChatMessage['thinkingLevel'];
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

export type BackendEvent =
  | MessageStartedEvent
  | MessageAbortedEvent
  | MessageDeltaEvent
  | MessageThinkingEvent
  | ToolCallEvent
  | MessageFinishedEvent;

export type Event = CommandEvent | EffectResultEvent | BackendEvent;
