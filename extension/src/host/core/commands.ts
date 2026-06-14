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

import type { ComposerInput, ComposerInputDraft, SessionSummary, UserContentPart } from '../../shared/protocol';

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
}

/** Edit an existing message (truncates the transcript after it). */
export interface EditCommand extends CommandBase {
  kind: 'Edit';
  sessionPath: string;
  messageId: string;
  text: string;
  /** Pre-generated local ID for the optimistic replacement message. */
  localId: string;
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
  | SetModelCommand
  | SetPrefsCommand
  | SelectSessionCommand
  | CloseTabCommand
  | ReorderTabsCommand
  | OpenFileDiffCommand
  | RevertFileCommand
  | ExportAnalyticsCommand
  | CloseSessionCommand
  | SetEditingMessageCommand
  | SetOutcomeDialogCommand
  | DismissNoticeCommand
  | RespondExtensionUICommand;
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

export interface ReorderTabsCommand extends CommandBase {
  kind: 'ReorderTabs';
  openTabPaths: string[];
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

export interface ExportAnalyticsCommand extends CommandBase {
  kind: 'ExportAnalytics';
  sessionPath: string;
}

export interface CloseSessionCommand extends CommandBase {
  kind: 'CloseSession';
  sessionPath: string;
}
