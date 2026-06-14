import type { PatchOp } from './core.js';
import type { ThinkingLevel, ModelSettings, ModelInfo, ContextWindowUsage } from './models.js';
import type { ComposerInput, ComposerInputDraft, ChatMessage } from './messages.js';
import type { SessionSummary, TranscriptWindow, SystemPromptEntry, FileChangeEntry } from './sessions.js';
import type { ExtensionInfo, PruningResult, PruningSettings, PruningCatalog, ChatPrefs, ActiveRunSummary, RunOutcome } from './settings.js';

/** Base fields shared by all extension UI request variants. */
export interface ExtensionUIRequestBase {
  id: string;
  sessionPath: string;
  extensionId?: string;
  /** When set, links this request to a subagent tool call in the parent session. */
  subagentCallId?: string;
}

/** A pending extension UI request (backend → host → webview). */
export type ExtensionUIRequestPayload =
  | (ExtensionUIRequestBase & { method: 'confirm'; title: string; message: string })
  | (ExtensionUIRequestBase & { method: 'select'; title: string; options: string[] })
  | (ExtensionUIRequestBase & { method: 'input'; title: string; placeholder?: string })
  | (ExtensionUIRequestBase & { method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error' });

/** Response from the webview (webview → host → backend). */
export interface ExtensionUIResponsePayload {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface StateAppliedPayload {
  revision: number;
  backendReady: boolean;
  transcriptLoaded: boolean;
  openTabCount: number;
  transcriptCount: number;
  systemPromptCount: number;
  domTranscriptLoaderPresent: boolean;
  domTabsConnectingPresent: boolean;
}

/** The full view state sent from the extension host to the webview. */
export interface ViewState {
  sessions: SessionSummary[];
  openTabPaths: string[];
  runningSessionPaths: string[];
  unreadFinishedSessionPaths: string[];
  activeSession: SessionSummary | null;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  /** True once the active session's initial transcript snapshot has been received. */
  transcriptLoaded: boolean;
  /** Host-owned pending inputs for the active session. */
  pendingComposerInputs: ComposerInput[];
  /** Most recent run summary for the active session, including recently completed runs. */
  activeRunSummary: ActiveRunSummary | null;
  /** Per-session run summaries used for tab affordances and context menus. */
  runSummariesBySession: Record<string, ActiveRunSummary | null>;
  busy: boolean;
  notice: string | null;
  /** True once the backend process has started and emitted `backend.ready`. */
  backendReady: boolean;
  workspaceCwd: string | null;
  systemPrompts: SystemPromptEntry[];
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
  contextUsage: ContextWindowUsage | null;
  prefs: ChatPrefs;
  /** Extensions discovered from the backend (tools + hooks). */
  availableExtensions: ExtensionInfo[];
  /** File changes tracked from tool calls in the active session. */
  fileChanges: FileChangeEntry[];
  /** Pruning result extracted from transcript (skill-pruner extension). */
  pruningResult: PruningResult | null;
  /** Current pruning configuration from settings.json. */
  pruningSettings: PruningSettings;
  /** Active pruning choices surfaced to the composer/settings UI. */
  pruningCatalog: PruningCatalog;
  /** Message ID currently being edited, or null. */
  editingMessageId: string | null;
  /** Whether the run-outcome dialog is open. */
  showOutcomeDialog: boolean;
  /** Pending extension UI requests keyed by session path, then by request ID. */
  pendingExtensionUIRequestsBySession: Record<string, Record<string, ExtensionUIRequestPayload>>;
  /** First pending extension UI request for the active session, or null (for bottom-bar prompt). */
  pendingExtensionUIRequest: ExtensionUIRequestPayload | null;
}

// ─── Host ↔ webview envelopes ────────────────────────────────────────────────

/**
 * Envelope sent from the extension host to the webview. Both messages carry
 * `hostInstanceId` so the webview can detect a host-side counter reset (e.g.
 * the view is re-resolved) and rebase its `lastRevision` rather than entering
 * a perpetual gap-detection loop.
 */
export type HostToWebviewMessage =
  | {
      type: 'state';
      protocolVersion: number;
      hostInstanceId: string;
      revision: number;
      state: ViewState;
    }
  | {
      /**
       * Patch envelope carries `sessionPath` at the envelope level (not per-op):
       * all ops in a single envelope address the same session. The webview routes
       * the envelope to that session's mirror.
       */
      type: 'patch';
      protocolVersion: number;
      sessionPath: string;
      hostInstanceId: string;
      revision: number;
      op: PatchOp;
    }
  | {
      type: 'sendRejected';
      sessionPath: string;
      text: string;
      /** Local ID of the rejected optimistic message, so the webview can
       * remove it from its local overlay. */
      localId?: string;
    }
  | {
      type: 'playCompletionSound';
      volume: number;
    };

/** Messages the webview can send back to the host. */
export type WebviewToHostMessage =
  | { type: 'ready'; assetVersion?: string }
  | { type: 'refreshState'; assetVersion?: string }
  | {
      /**
       * Request a state snapshot. When `sessionPath` is provided the host MAY
       * respond with a snapshot scoped to that session; when omitted the host
       * responds with a global snapshot (all sessions + global state). Today the
       * host always responds with a global snapshot; the optional field is wired
       * through so per-session snapshot recovery can land without a protocol bump.
       */
      type: 'requestSnapshot';
      assetVersion?: string;
      sessionPath?: string;
    }
  | { type: 'openFilePicker' }
  | { type: 'openFile'; path: string }
  | { type: 'addComposerInput'; sessionPath: string; input: ComposerInputDraft }
  | { type: 'removeComposerInput'; sessionPath: string; inputId: string }
  | {
      type: 'send';
      sessionPath: string;
      text: string;
      /** Optional local ID generated by the webview for optimistic display.
       * When provided, the host uses this as the optimistic message id,
       * allowing the webview to correlate its local preview with the
       * host-confirmed message. */
      localId?: string;
    }
  | { type: 'editMessage'; sessionPath: string; messageId: string; text: string }
  | { type: 'interrupt'; sessionPath: string }
  | { type: 'newSession' }
  | { type: 'openSession'; sessionPath: string }
  | { type: 'closeSession'; sessionPath: string }
  | { type: 'duplicateSession'; sessionPath: string }
  | { type: 'moveSessionTab'; sessionPath?: string; fromIndex: number; toIndex: number }
  | { type: 'loadOlderTranscript'; sessionPath?: string }
  | { type: 'loadNewerTranscript'; sessionPath?: string }
  | { type: 'jumpToLatestTranscript'; sessionPath?: string }
  | { type: 'recordOutcome'; sessionPath: string; outcome: RunOutcome }
  | { type: 'startNewTask'; sessionPath: string }
  | { type: 'continueTask'; sessionPath: string }
  | {
      type: 'setModel';
      sessionPath?: string;
      defaultModel: string;
      defaultThinkingLevel: ThinkingLevel;
    }
  | { type: 'setPrefs'; prefs: Partial<ChatPrefs> }
  | { type: 'setPruningSettings'; settings: Partial<PruningSettings> }
  | { type: 'startEdit'; messageId: string }
  | { type: 'cancelEdit' }
  | { type: 'dismissNotice' }
  | { type: 'openOutcomeDialog' }
  | { type: 'closeOutcomeDialog' }
  | { type: 'openFileDiff'; sessionPath: string; filePath: string }
  | { type: 'openFileInEditor'; sessionPath: string; filePath: string }
  | { type: 'revertFile'; sessionPath: string; filePath: string }
  | { type: 'stateApplied'; payload: StateAppliedPayload }
  | { type: 'extensionUiResponse'; sessionPath: string; response: ExtensionUIResponsePayload };

