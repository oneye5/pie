/**
 * Phase 2 type spine — `Effect` discriminated union.
 *
 * Effects are produced by the reducer and consumed exclusively by the
 * `EffectRunner`. They describe a side-effecting intent (an RPC call, a
 * persistence write, a log line); the reducer never performs them directly.
 * The runner translates each effect into the appropriate queue path:
 *
 * - Any `*Rpc` effect routes through the **double-wrap**
 *   `enqueueLifecycle(() => enqueueSessionOperation(sessionPath, do_rpc))` so
 *   it serializes correctly with legacy `send`/`edit` paths during the
 *   multi-phase migration (see plan §Phase 2 EffectRunner contract).
 * - Lifecycle effects (`OpenSession`, `CreateSession`) use `enqueueLifecycle`
 *   directly because the target session may not yet exist.
 * - `PersistTabs` and `Log` execute synchronously without queueing.
 *
 * Each effect's `corrId` is propagated back into the matching `*Result` event
 * so the reducer can reconcile optimistic state (Phase 4).
 */

import type { ComposerInput, ToolCall } from '../../shared/protocol';

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

// ─── Real side effects ────────────────────────────────────────────────────────

/** Post an imperative message to the webview. */
export interface PostImperativeEffect extends EffectBase {
  kind: 'PostImperative';
  imperativeMessage: { type: string; sessionPath?: string; text?: string; localId?: string };
}

// ─── FileOperation namespace ────────────────────────────────────────────────────

export interface FileDiffEffect extends EffectBase {
  kind: 'FileDiff';
  sessionPath: string;
  filePath: string;
  status: 'modified' | 'created' | 'deleted';
}

export interface FileRevertEffect extends EffectBase {
  kind: 'FileRevert';
  sessionPath: string;
  filePath: string;
}

// ─── Notification namespace ────────────────────────────────────────────────────

export interface FlashWindowEffect extends EffectBase {
  kind: 'FlashWindow';
  sessionPath: string;
}

export interface PlayCompletionSoundEffect extends EffectBase {
  kind: 'PlayCompletionSound';
  volume: number;
}

// ─── Analytics namespace ────────────────────────────────────────────────────────

export interface ExportRunAnalyticsEffect extends EffectBase {
  kind: 'ExportRunAnalytics';
  sessionPath: string;
}

// ─── Eviction namespace ─────────────────────────────────────────────────────────

export interface EvictTranscriptEffect extends EffectBase {
  kind: 'EvictTranscript';
  sessionPath: string;
  keepTailCount: number;
}

// ─── Derivation namespace ───────────────────────────────────────────────────────

export interface DeriveFileChangesEffect extends EffectBase {
  kind: 'DeriveFileChanges';
  sessionPath: string;
  messageId: string;
  toolCall: ToolCall;
}

export interface DeriveAvailableExtensionsEffect extends EffectBase {
  kind: 'DeriveAvailableExtensions';
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
  | PostImperativeEffect
  | FileDiffEffect
  | FileRevertEffect
  | FlashWindowEffect
  | PlayCompletionSoundEffect
  | ExportRunAnalyticsEffect
  | EvictTranscriptEffect
  | DeriveFileChangesEffect
  | DeriveAvailableExtensionsEffect;

// ─── Type guards ────────────────────────────────────────────────────────────────

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