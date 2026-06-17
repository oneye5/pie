/**
 * `Event` discriminated union — the sole input to the pure reducer.
 *
 * Events include:
 *  - User intents wrapped as `{kind:'Command', cmd}` (posted by the webview
 *    message bridge and other host entry points).
 *  - Results of effects executed by `EffectRunner` (each side-effecting effect
 *    has a matching `*Result` event carrying the same `corrId`).
 *  - Backend events forwarded by the backend event parser.
 *
 * The reducer switch in `core/reducer.ts` is total over this union: a missing
 * handler is a compile-time error (see the `never` default), not a silent
 * no-op. See `docs/STATE_CONTRACT.md` for the invariants.
 */

import type { Command } from './commands';
import type {
  ChatMessage,
  ToolCall,
  ContextWindowUsage,
  SessionSummary,
  ExtensionUIRequestPayload,
  SessionOpenedPayload,
  PruningSettings,
  FileChangeEntry,
  ActiveRunSummary,
  SessionAnalyticsFactors,
  ExtensionInfo,
  ModelInfo,
  ComposerInput,
  TranscriptWindow,
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

export interface ExtensionUiResponseResultEvent {
  kind: 'ExtensionUiResponseResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface SetModelResultEvent {
  kind: 'SetModelResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface SetPrefsResultEvent {
  kind: 'SetPrefsResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface FileDiffResultEvent {
  kind: 'FileDiffResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface FileRevertResultEvent {
  kind: 'FileRevertResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface AddFilesystemPathsResultEvent {
  kind: 'AddFilesystemPathsResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface LoadOlderTranscriptResultEvent {
  kind: 'LoadOlderTranscriptResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface LoadNewerTranscriptResultEvent {
  kind: 'LoadNewerTranscriptResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface JumpToLatestTranscriptResultEvent {
  kind: 'JumpToLatestTranscriptResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface RecordOutcomeResultEvent {
  kind: 'RecordOutcomeResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface StartNewTaskResultEvent {
  kind: 'StartNewTaskResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface ContinueTaskResultEvent {
  kind: 'ContinueTaskResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface OpenFileInEditorResultEvent {
  kind: 'OpenFileInEditorResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface OpenFileResultEvent {
  kind: 'OpenFileResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface SetPruningSettingsResultEvent {
  kind: 'SetPruningSettingsResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface CloseSessionResultEvent {
  kind: 'CloseSessionResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface DuplicateSessionResultEvent {
  kind: 'DuplicateSessionResult';
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
  | PersistTabsResultEvent
  | ExtensionUiResponseResultEvent
  | SetModelResultEvent
  | SetPrefsResultEvent
  | FileDiffResultEvent
  | FileRevertResultEvent
  | AddFilesystemPathsResultEvent
  | LoadOlderTranscriptResultEvent
  | LoadNewerTranscriptResultEvent
  | JumpToLatestTranscriptResultEvent
  | RecordOutcomeResultEvent
  | StartNewTaskResultEvent
  | ContinueTaskResultEvent
  | OpenFileInEditorResultEvent
  | OpenFileResultEvent
  | SetPruningSettingsResultEvent
  | CloseSessionResultEvent
  | DuplicateSessionResultEvent;

// ─── Backend streaming events ─────────────────────────────────────────────────
// These wrap PI backend events so they flow through the reducer.

export interface MessageStartedEvent {
  kind: 'MessageStarted';
  sessionPath: string;
  messageId: string;
  requestId?: string;
  modelId?: string;
  thinkingLevel?: ChatMessage['thinkingLevel'];
  timestamp: number;
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

/** Emitted when the backend ready state changes. */
export interface BackendReadyChangedEvent {
  kind: 'BackendReadyChanged';
  ready: boolean;
}

/** Emitted when pruning settings change. */
export interface PruningSettingsChangedEvent {
  kind: 'PruningSettingsChanged';
  pruningSettings: PruningSettings;
}

/** Emitted when the workspace cwd changes. */
export interface WorkspaceCwdChangedEvent {
  kind: 'WorkspaceCwdChanged';
  workspaceCwd: string;
}

/** Emitted when a transcript page is loaded (older/newer/latest). */
export interface TranscriptPageLoadedEvent {
  kind: 'TranscriptPageLoaded';
  sessionPath: string;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
}

/** Emitted when file changes are updated for a session. */
export interface FileChangesUpdatedEvent {
  kind: 'FileChangesUpdated';
  sessionPath: string;
  fileChanges: FileChangeEntry[];
}

/** Emitted when the active run summary for a session changes. */
export interface ActiveRunSummaryChangedEvent {
  kind: 'ActiveRunSummaryChanged';
  sessionPath: string;
  summary: ActiveRunSummary | null;
}

/** Emitted when session metadata (modelId/thinkingLevel) changes. */
export interface SessionMetadataChangedEvent {
  kind: 'SessionMetadataChanged';
  sessionPath: string;
  modelId?: string;
  thinkingLevel?: ChatMessage['thinkingLevel'];
}

/** Emitted when available models for a session change. */
export interface AvailableModelsChangedEvent {
  kind: 'AvailableModelsChanged';
  sessionPath: string;
  models: ModelInfo[];
}

/** Emitted when pending extension UI requests for a session are cleared. */
export interface PendingExtensionUIRequestsClearedEvent {
  kind: 'PendingExtensionUIRequestsCleared';
  sessionPath: string;
}

/** Emitted when analytics factors for a session change. */
export interface AnalyticsFactorsChangedEvent {
  kind: 'AnalyticsFactorsChanged';
  sessionPath: string;
  factors: SessionAnalyticsFactors | null;
}

/** Emitted when available extensions change. */
export interface AvailableExtensionsChangedEvent {
  kind: 'AvailableExtensionsChanged';
  extensions: ExtensionInfo[];
}

/** Emitted when the last assistant message in a transcript should be marked as error. */
export interface AssistantMessageErrorStampedEvent {
  kind: 'AssistantMessageErrorStamped';
  sessionPath: string;
  errorMessage: string;
}

/** Emitted when composer inputs for a session are replaced wholesale. */
export interface ComposerInputsReplacedEvent {
  kind: 'ComposerInputsReplaced';
  sessionPath: string;
  inputs: ComposerInput[] | null;
}

/** Emitted when a pending path is replaced with a real session path. */
export interface PendingPathReplacedEvent {
  kind: 'PendingPathReplaced';
  oldPendingPath: string;
  newSessionPath: string;
}

/** Emitted when a session's transcript is trimmed (eviction). */
export interface TranscriptTrimmedEvent {
  kind: 'TranscriptTrimmed';
  sessionPath: string;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
}

/** Emitted when running session paths are set wholesale. */
export interface RunningSessionsChangedEvent {
  kind: 'RunningSessionsChanged';
  sessionPaths: string[];
}

/** Emitted when unread finished session paths are set wholesale. */
export interface UnreadFinishedSessionsChangedEvent {
  kind: 'UnreadFinishedSessionsChanged';
  sessionPaths: string[];
}

/** Emitted when session summaries are replaced (startup restore). */
export interface SessionSummariesReplacedEvent {
  kind: 'SessionSummariesReplaced';
  summaries: SessionSummary[];
}

/** Emitted when session scope is cleared. */
export interface SessionScopeClearedEvent {
  kind: 'SessionScopeCleared';
  sessionPath: string;
  removeSessionSummary: boolean;
}

/** Emitted when a tab is opened (added to openTabPaths). */
export interface TabOpenedEvent {
  kind: 'TabOpened';
  sessionPath: string;
  insertAfter?: string;
}

/** Emitted when openTabPaths is replaced wholesale (e.g. startup restore). */
export interface OpenTabsChangedEvent {
  kind: 'OpenTabsChanged';
  openTabPaths: string[];
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

/** Emitted when a session summary is upserted (used for placeholder creation). */
export interface SessionSummaryUpsertedEvent {
  kind: 'SessionSummaryUpserted';
  summary: SessionSummary;
}

export type HostEvent =
  | NoticeShownEvent
  | SessionNameDerivedEvent
  | OptimisticMessageInsertedEvent
  | OptimisticMessageRemovedEvent
  | FileChangeRemovedEvent
  | BackendReadyChangedEvent
  | PruningSettingsChangedEvent
  | WorkspaceCwdChangedEvent
  | TranscriptPageLoadedEvent
  | FileChangesUpdatedEvent
  | ActiveRunSummaryChangedEvent
  | SessionMetadataChangedEvent
  | AvailableModelsChangedEvent
  | PendingExtensionUIRequestsClearedEvent
  | AnalyticsFactorsChangedEvent
  | AvailableExtensionsChangedEvent
  | AssistantMessageErrorStampedEvent
  | ComposerInputsReplacedEvent
  | PendingPathReplacedEvent
  | TranscriptTrimmedEvent
  | RunningSessionsChangedEvent
  | UnreadFinishedSessionsChangedEvent
  | SessionSummaryUpsertedEvent
  | SessionSummariesReplacedEvent
  | SessionScopeClearedEvent
  | TabOpenedEvent
  | OpenTabsChangedEvent;

export type Event = CommandEvent | EffectResultEvent | BackendEvent | HostEvent;