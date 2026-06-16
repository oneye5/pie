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

import type { ComposerInput, ModelSettings, ChatPrefs } from '../../shared/protocol';

export interface EffectBase {
  corrId: string;
}

export interface SendRpcEffect extends EffectBase {
  kind: 'SendRpc';
  sessionPath: string;
  text: string;
  /** Composer inputs (file refs, images) sent alongside the text. */
  inputs: ComposerInput[];
  /** Pre-generated local ID for optimistic message reconciliation. */
  localId: string;
}

export interface EditRpcEffect extends EffectBase {
  kind: 'EditRpc';
  sessionPath: string;
  messageId: string;
  text: string;
  /** Pre-generated local ID for optimistic message reconciliation. */
  localId: string;
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

export interface SetModelRpcEffect extends EffectBase {
  kind: 'SetModelRpc';
  sessionPath: string;
  modelSettings: ModelSettings;
}

export interface SetPrefsRpcEffect extends EffectBase {
  kind: 'SetPrefsRpc';
  prefs: Partial<ChatPrefs>;
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

export interface ExtensionUiResponseRpcEffect extends EffectBase {
  kind: 'ExtensionUiResponseRpc';
  sessionPath: string;
  response: import('../../shared/protocol').ExtensionUIResponsePayload;
}

export interface AddFilesystemPathsEffect extends EffectBase {
  kind: 'AddFilesystemPaths';
  sessionPath: string | undefined;
  paths: string[];
  source: 'picker' | 'drop';
}

export interface LoadOlderTranscriptEffect extends EffectBase {
  kind: 'LoadOlderTranscript';
  sessionPath: string;
}

export interface LoadNewerTranscriptEffect extends EffectBase {
  kind: 'LoadNewerTranscript';
  sessionPath: string;
}

export interface JumpToLatestTranscriptEffect extends EffectBase {
  kind: 'JumpToLatestTranscript';
  sessionPath: string;
}

export interface RecordOutcomeEffect extends EffectBase {
  kind: 'RecordOutcome';
  sessionPath: string;
  outcome: import('../../shared/protocol').RunOutcome;
}

export interface StartNewTaskEffect extends EffectBase {
  kind: 'StartNewTask';
  sessionPath: string;
}

export interface ContinueTaskEffect extends EffectBase {
  kind: 'ContinueTask';
  sessionPath: string;
}

export interface OpenFileInEditorEffect extends EffectBase {
  kind: 'OpenFileInEditor';
  sessionPath: string;
  filePath: string;
}

export interface OpenFileEffect extends EffectBase {
  kind: 'OpenFile';
  path: string;
}

export interface SetPruningSettingsEffect extends EffectBase {
  kind: 'SetPruningSettings';
  settings: Partial<import('../../shared/protocol').PruningSettings>;
}

export interface CloseSessionEffect extends EffectBase {
  kind: 'CloseSession';
  sessionPath: string;
}

export interface DuplicateSessionEffect extends EffectBase {
  kind: 'DuplicateSession';
  sessionPath: string;
}

export interface MoveSessionTabEffect extends EffectBase {
  kind: 'MoveSessionTab';
  sessionPath: string | undefined;
  fromIndex: number;
  toIndex: number;
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
  | SetModelRpcEffect
  | SetPrefsRpcEffect
  | PostImperativeEffect
  | FileDiffEffect
  | FileRevertEffect






  | ExtensionUiResponseRpcEffect
  | AddFilesystemPathsEffect
  | LoadOlderTranscriptEffect
  | LoadNewerTranscriptEffect
  | JumpToLatestTranscriptEffect
  | RecordOutcomeEffect
  | StartNewTaskEffect
  | ContinueTaskEffect
  | OpenFileInEditorEffect
  | OpenFileEffect
  | SetPruningSettingsEffect
  | CloseSessionEffect
  | DuplicateSessionEffect
  | MoveSessionTabEffect;

// ─── Type guards ────────────────────────────────────────────────────────────────

/** True for any effect whose `kind` ends in `Rpc` and routes through the double-wrap. */
export function isRpcEffect(
  e: Effect,
): e is SendRpcEffect | EditRpcEffect | InterruptRpcEffect | TruncateRpcEffect | ExtensionUiResponseRpcEffect {
  return (
    e.kind === 'SendRpc' ||
    e.kind === 'EditRpc' ||
    e.kind === 'InterruptRpc' ||
    e.kind === 'TruncateRpc' ||
    e.kind === 'ExtensionUiResponseRpc'
  );
}

/** True for lifecycle effects routed through `enqueueLifecycle` directly. */
export function isLifecycleEffect(
  e: Effect,
): e is OpenSessionEffect | CreateSessionEffect {
  return e.kind === 'OpenSession' || e.kind === 'CreateSession';
}