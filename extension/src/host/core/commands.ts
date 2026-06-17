/**
 * Phase 2 type spine — `Command` discriminated union.
 *
 * Commands are intents originating from the webview (user actions) or other
 * inputs that the host must process. Each command carries a `corrId` for
 * optimistic-update reconciliation (Phase 4) and, where applicable, an
 * explicit `sessionPath` (the Phase 1 session-routing invariant — no implicit
 * "viewed session" fallback). This file is the future replacement for the
 * action-shaped variants of `WebviewToHostMessage`; today, no code consumes
 * these types yet.
 */

import type { ComposerInput, ComposerInputDraft, SessionSummary, UserContentPart, ExtensionUIResponsePayload } from '../../shared/protocol';

import type { ModelSettings, ChatPrefs } from '../../shared/protocol';

/** Common fields on every command. */
export interface CommandBase {
  corrId: string;
}

/** Send a new user message. */
export interface SendCommand extends CommandBase {
  kind: 'Send';
  sessionPath: string;
  /** Raw user text (sent to backend). */
  text: string;
  /** Materialized composer inputs to send with the message. */
  inputs: ComposerInput[];
  /** Composed text (text + input annotations) for the optimistic transcript entry. */
  composedText: string;
  /** Pre-generated local ID for the optimistic message. */
  localId: string;
  /** User content parts for rich rendering of the optimistic message. */
  userParts?: UserContentPart[];
  /** Snapshot of the session summary before optimistic name change (null if no change). */
  previousSummary: SessionSummary | null;
  /** Explicit timestamp for deterministic optimistic message ordering. */
  timestamp: number;
}

/** Edit an existing message (truncates the transcript after it). */
export interface EditCommand extends CommandBase {
  kind: 'Edit';
  sessionPath: string;
  messageId: string;
  text: string;
  /** Pre-generated local ID for the optimistic replacement message. */
  localId: string;
  /** Explicit timestamp for deterministic optimistic message ordering. */
  timestamp: number;
}

/** Interrupt the in-flight assistant turn for a session. */
export interface InterruptCommand extends CommandBase {
  kind: 'Interrupt';
  sessionPath: string;
}

/** Truncate the transcript after a given message. */
export interface TruncateAfterCommand extends CommandBase {
  kind: 'TruncateAfter';
  sessionPath: string;
  messageId: string;
}

/** Open an existing session (becomes active). */
export interface OpenSessionCommand extends CommandBase {
  kind: 'OpenSession';
  sessionPath: string;
  /** Token issued by the lifecycle queue to detect stale selections. */
  selectionToken: string;
}

/** Create a brand-new session and open it. */
export interface CreateSessionCommand extends CommandBase {
  kind: 'CreateSession';
  /** Token issued by the lifecycle queue to detect stale selections. */
  selectionToken: string;
}

/** Persist the tab order / active tab to globalState. */
export interface PersistTabsCommand extends CommandBase {
  kind: 'PersistTabs';
  openTabPaths: string[];
  activeSessionPath: string | null;
}

/** Add a composer input draft (file attachment) to a session. */
export interface AddComposerInputCommand extends CommandBase {
  kind: 'AddComposerInput';
  sessionPath: string;
  input: ComposerInputDraft;
}

/** Remove a composer input draft from a session. */
export interface RemoveComposerInputCommand extends CommandBase {
  kind: 'RemoveComposerInput';
  sessionPath: string;
  inputId: string;
}

export interface SetComposerDraftCommand extends CommandBase {
  kind: 'SetComposerDraft';
  sessionPath: string;
  text: string;
}

export interface SetEditingMessageCommand extends CommandBase {
  kind: 'SetEditingMessage';
  sessionPath: string;
  messageId: string | null;
}

export interface SetOutcomeDialogCommand extends CommandBase {
  kind: 'SetOutcomeDialog';
  sessionPath: string;
  visible: boolean;
}

export interface DismissNoticeCommand extends CommandBase {
  kind: 'DismissNotice';
}

export interface RespondExtensionUICommand extends CommandBase {
  kind: 'RespondExtensionUI';
  sessionPath: string;
  /** The specific request being responded to. */
  requestId: string;
  approved: boolean;
  response: ExtensionUIResponsePayload;
}

export interface AddFilesystemPathsCommand extends CommandBase {
  kind: 'AddFilesystemPaths';
  sessionPath: string | undefined;
  paths: string[];
  source: 'picker' | 'drop';
}

export interface LoadOlderTranscriptCommand extends CommandBase {
  kind: 'LoadOlderTranscript';
  sessionPath: string;
}

export interface LoadNewerTranscriptCommand extends CommandBase {
  kind: 'LoadNewerTranscript';
  sessionPath: string;
}

export interface JumpToLatestTranscriptCommand extends CommandBase {
  kind: 'JumpToLatestTranscript';
  sessionPath: string;
}

export interface RecordOutcomeCommand extends CommandBase {
  kind: 'RecordOutcome';
  sessionPath: string;
  outcome: import('../../shared/protocol').RunOutcome;
}

export interface StartNewTaskCommand extends CommandBase {
  kind: 'StartNewTask';
  sessionPath: string;
}

export interface ContinueTaskCommand extends CommandBase {
  kind: 'ContinueTask';
  sessionPath: string;
}

export interface OpenFileInEditorCommand extends CommandBase {
  kind: 'OpenFileInEditor';
  sessionPath: string;
  filePath: string;
}

export interface OpenFileCommand extends CommandBase {
  kind: 'OpenFile';
  path: string;
}

export interface SetPruningSettingsCommand extends CommandBase {
  kind: 'SetPruningSettings';
  settings: Partial<import('../../shared/protocol').PruningSettings>;
}

export type Command =
  | SendCommand
  | EditCommand
  | InterruptCommand
  | TruncateAfterCommand
  | OpenSessionCommand
  | CreateSessionCommand
  | PersistTabsCommand
  | AddComposerInputCommand
  | RemoveComposerInputCommand
  | SetComposerDraftCommand
  | SetModelCommand
  | SetPrefsCommand
  | SelectSessionCommand
  | CloseTabCommand
  | OpenFileDiffCommand
  | RevertFileCommand
  | CloseSessionCommand
  | SetEditingMessageCommand
  | SetOutcomeDialogCommand
  | DismissNoticeCommand
  | RespondExtensionUICommand
  | AddFilesystemPathsCommand
  | LoadOlderTranscriptCommand
  | LoadNewerTranscriptCommand
  | JumpToLatestTranscriptCommand
  | RecordOutcomeCommand
  | StartNewTaskCommand
  | ContinueTaskCommand
  | OpenFileInEditorCommand
  | OpenFileCommand
  | SetPruningSettingsCommand
  | DuplicateSessionCommand
  | MoveSessionTabCommand;
export interface SetModelCommand extends CommandBase {
  kind: 'SetModel';
  sessionPath: string;
  modelSettings: ModelSettings;
}

export interface SetPrefsCommand extends CommandBase {
  kind: 'SetPrefs';
  prefs: Partial<ChatPrefs>;
}

export interface SelectSessionCommand extends CommandBase {
  kind: 'SelectSession';
  sessionPath: string;
}

export interface CloseTabCommand extends CommandBase {
  kind: 'CloseTab';
  sessionPath: string;
}

export interface OpenFileDiffCommand extends CommandBase {
  kind: 'OpenFileDiff';
  sessionPath: string;
  filePath: string;
  status: 'modified' | 'created' | 'deleted';
}

export interface RevertFileCommand extends CommandBase {
  kind: 'RevertFile';
  sessionPath: string;
  filePath: string;
}

export interface CloseSessionCommand extends CommandBase {
  kind: 'CloseSession';
  sessionPath: string;
}

export interface DuplicateSessionCommand extends CommandBase {
  kind: 'DuplicateSession';
  sessionPath: string;
}

export interface MoveSessionTabCommand extends CommandBase {
  kind: 'MoveSessionTab';
  sessionPath: string | undefined;
  fromIndex: number;
  toIndex: number;
}
