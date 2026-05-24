/**
 * Phase 2 type spine — `Effect` discriminated union.
 *
 * Effects are produced by the reducer and consumed exclusively by the
 * `EffectRunner`. They describe a side-effecting intent (an RPC call, a
 * persistence write, a log line); the reducer never performs them directly.
 * The runner translates each effect into the appropriate queue path:
 *
 * - Any `*Rpc` effect routes through the **double-wrap**
 *   `enqueueLifecycle(() => enqueueSessionOperation(sessionPath, doRpc))` so
 *   it serializes correctly with legacy `send`/`edit` paths during the
 *   multi-phase migration (see plan §Phase 2 EffectRunner contract).
 * - Lifecycle effects (`OpenSession`, `CreateSession`) use `enqueueLifecycle`
 *   directly because the target session may not yet exist.
 * - `PersistTabs` and `Log` execute synchronously without queueing.
 *
 * Each effect's `corrId` is propagated back into the matching `*Result` event
 * so the reducer can reconcile optimistic state (Phase 4).
 */

import type { ChatMessage, ComposerInput, UserContentPart, SessionSummary, ToolCall } from '../../shared/protocol';

export interface EffectBase {
  corrId: string;
}

export interface SendRpcEffect extends EffectBase {
  kind: 'SendRpc';
  sessionPath: string;
  text: string;
  /** Composer inputs (file refs, images) sent alongside the text. */
  inputs: ComposerInput[];
}

export interface EditRpcEffect extends EffectBase {
  kind: 'EditRpc';
  sessionPath: string;
  messageId: string;
  text: string;
}

export interface InterruptRpcEffect extends EffectBase {
  kind: 'InterruptRpc';
  sessionPath: string;
}

export interface TruncateRpcEffect extends EffectBase {
  kind: 'TruncateRpc';
  sessionPath: string;
  messageId: string;
}

export interface OpenSessionEffect extends EffectBase {
  kind: 'OpenSession';
  sessionPath: string;
  selectionToken: string;
}

export interface CreateSessionEffect extends EffectBase {
  kind: 'CreateSession';
  selectionToken: string;
}

export interface PersistTabsEffect extends EffectBase {
  kind: 'PersistTabs';
  openTabPaths: string[];
  activeSessionPath: string | null;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEffect extends EffectBase {
  kind: 'Log';
  level: LogLevel;
  message: string;
  data?: unknown;
}

export type Effect =
  | SendRpcEffect
  | EditRpcEffect
  | InterruptRpcEffect
  | TruncateRpcEffect
  | OpenSessionEffect
  | CreateSessionEffect
  | PersistTabsEffect
  | LogEffect
  | InsertOptimisticMessageEffect
  | RemoveOptimisticMessageEffect
  | ClearComposerInputsEffect
  | SetNoticeEffect
  | PostImperativeEffect
  | SetSessionNameEffect
  | RestoreSessionSummaryEffect
  | AppendDeltaEffect
  | AppendThinkingEffect
  | UpsertToolCallEffect
  | UpsertMessageEffect
  | ScheduleRenderEffect
  | EnsureAssistantMessageEffect
  | SetMessageStatusEffect;

// ─── Synchronous imperative effects (Phase 4) ─────────────────────────────────
// These dispatch to the Redux store or webview synchronously. They are
// transitional: Phase 5+ will move transcript state into the reducer directly.

/** Insert an optimistic user message into the Redux transcript store. */
export interface InsertOptimisticMessageEffect extends EffectBase {
  kind: 'InsertOptimisticMessage';
  sessionPath: string;
  localId: string;
  text: string;
  userParts?: UserContentPart[];
}

/** Remove an optimistic user message (rollback on failure). */
export interface RemoveOptimisticMessageEffect extends EffectBase {
  kind: 'RemoveOptimisticMessage';
  sessionPath: string;
  localId: string;
}

/** Clear pending composer inputs for a session (after successful send). */
export interface ClearComposerInputsEffect extends EffectBase {
  kind: 'ClearComposerInputs';
  sessionPath: string;
}

/** Set or clear the UI notice banner. */
export interface SetNoticeEffect extends EffectBase {
  kind: 'SetNotice';
  message: string | null;
}

/** Post an imperative message to the webview. */
export interface PostImperativeEffect extends EffectBase {
  kind: 'PostImperative';
  imperativeMessage: { type: string; sessionPath?: string; text?: string };
}

/** Set a session's display name optimistically. */
export interface SetSessionNameEffect extends EffectBase {
  kind: 'SetSessionName';
  sessionPath: string;
  name: string;
  isPlaceholder: boolean;
}

/** Restore a session summary that was optimistically changed (rollback). */
export interface RestoreSessionSummaryEffect extends EffectBase {
  kind: 'RestoreSessionSummary';
  summary: SessionSummary;
}

// ─── Transcript mutation effects (Phase 5) ─────────────────────────────────────
// Produced by the reducer when handling backend streaming events. The
// effect-runner dispatches these to the Redux transcript store.

export interface AppendDeltaEffect extends EffectBase {
  kind: 'AppendDelta';
  sessionPath: string;
  messageId: string;
  delta: string;
}

export interface AppendThinkingEffect extends EffectBase {
  kind: 'AppendThinking';
  sessionPath: string;
  messageId: string;
  thinking: string;
}

export interface UpsertToolCallEffect extends EffectBase {
  kind: 'UpsertToolCall';
  sessionPath: string;
  messageId: string;
  toolCall: ToolCall;
}

export interface UpsertMessageEffect extends EffectBase {
  kind: 'UpsertMessage';
  sessionPath: string;
  message: ChatMessage;
  /** When set, the message is a continuation — merge into the canonical message. */
  canonicalMessageId?: string;
}

export interface ScheduleRenderEffect extends EffectBase {
  kind: 'ScheduleRender';
}

/** Ensure an assistant message exists in the transcript (alias-aware). */
export interface EnsureAssistantMessageEffect extends EffectBase {
  kind: 'EnsureAssistantMessage';
  sessionPath: string;
  messageId: string;
  /** Canonical message ID (resolved through alias map by the reducer). */
  canonicalMessageId: string;
  /** Whether this message is an alias (continuation of an existing turn). */
  isAlias: boolean;
  requestId?: string;
  modelId?: string;
  thinkingLevel?: ChatMessage['thinkingLevel'];
}

/** Set a message's status (e.g., on abort). */
export interface SetMessageStatusEffect extends EffectBase {
  kind: 'SetMessageStatus';
  sessionPath: string;
  messageId: string;
  status: 'completed' | 'interrupted' | 'streaming';
}

export type SyncEffect =
  | InsertOptimisticMessageEffect
  | RemoveOptimisticMessageEffect
  | ClearComposerInputsEffect
  | SetNoticeEffect
  | PostImperativeEffect
  | SetSessionNameEffect
  | RestoreSessionSummaryEffect
  | AppendDeltaEffect
  | AppendThinkingEffect
  | UpsertToolCallEffect
  | UpsertMessageEffect
  | ScheduleRenderEffect
  | EnsureAssistantMessageEffect
  | SetMessageStatusEffect;

/** True for synchronous imperative effects handled inline by the runner. */
export function isSyncEffect(e: Effect): e is SyncEffect {
  return (
    e.kind === 'InsertOptimisticMessage' ||
    e.kind === 'RemoveOptimisticMessage' ||
    e.kind === 'ClearComposerInputs' ||
    e.kind === 'SetNotice' ||
    e.kind === 'PostImperative' ||
    e.kind === 'SetSessionName' ||
    e.kind === 'RestoreSessionSummary' ||
    e.kind === 'AppendDelta' ||
    e.kind === 'AppendThinking' ||
    e.kind === 'UpsertToolCall' ||
    e.kind === 'UpsertMessage' ||
    e.kind === 'ScheduleRender' ||
    e.kind === 'EnsureAssistantMessage' ||
    e.kind === 'SetMessageStatus'
  );
}

/** True for any effect whose `kind` ends in `Rpc` and routes through the double-wrap. */
export function isRpcEffect(
  e: Effect,
): e is SendRpcEffect | EditRpcEffect | InterruptRpcEffect | TruncateRpcEffect {
  return (
    e.kind === 'SendRpc' ||
    e.kind === 'EditRpc' ||
    e.kind === 'InterruptRpc' ||
    e.kind === 'TruncateRpc'
  );
}

/** True for lifecycle effects routed through `enqueueLifecycle` directly. */
export function isLifecycleEffect(
  e: Effect,
): e is OpenSessionEffect | CreateSessionEffect {
  return e.kind === 'OpenSession' || e.kind === 'CreateSession';
}
