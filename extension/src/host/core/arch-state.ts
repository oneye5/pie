/**
 * Target state shape for the CQRS reducer.
 *
 * This file defines the NEW `ArchState` that will replace the current Redux
 * store slices once the CQRS migration completes. Until then, these types
 * coexist with the Redux slice types; the reducer currently uses a smaller
 * `ArchState` defined here (for backward compatibility) that will be expanded
 * when the cutover happens.
 *
 * Sub-state domains:
 * - **transcript**: Messages, tool calls, editing state, window metadata
 * - **sessions**: Session list, running states, active path, analytics
 * - **settings**: Model config, prefs, pruning, backend readiness, extensions
 * - **composer**: Pending inputs, run summaries
 * - **fileChanges**: File change entries per session
 * - **pending**: Optimistic ops, interrupt flags, message aliases, turn tracking
 *
 * State-shape rule: keyed collections MUST use `Record<string, T>`,
 * never `Map`/`Set`.
 */

import type {
  ChatMessage,
  SystemPromptEntry,
  TranscriptWindow,
  SessionSummary,
  ModelSettings,
  ModelInfo,
  PruningSettings,
  ContextWindowUsage,
  SessionAnalyticsFactors,
  ChatPrefs,
  ExtensionInfo,
  ExtensionUIRequestPayload,
  FileChangeEntry,
  ComposerInput,
  ActiveRunSummary,
} from '../../shared/protocol';
import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
} from '../../shared/protocol';

// ---------------------------------------------------------------------------
// Transcript sub-state
// ---------------------------------------------------------------------------

/**
 * Per-session transcript data: messages, system prompts, window metadata,
 * and editing state.
 */
export interface TranscriptState {
  /** Chat messages keyed by session path. */
  bySession: Record<string, ChatMessage[]>;
  /** System prompts keyed by session path. */
  systemPromptsBySession: Record<string, SystemPromptEntry[]>;
  /** Transcript window (scroll/pagination state) keyed by session path. */
  windowBySession: Record<string, TranscriptWindow>;
  /** ID of the message currently being edited, or null. */
  editingMessageId: string | null;
}

// ---------------------------------------------------------------------------
// Sessions sub-state
// ---------------------------------------------------------------------------

/**
 * Session list, tab state, running/busy state, analytics per session.
 */
export interface SessionsState {
  /** Known session summaries. */
  sessions: SessionSummary[];
  /** Open tab paths (preserves order). */
  openTabPaths: string[];
  /** Session paths currently streaming a response. */
  runningSessionPaths: string[];
  /** Sessions that finished while not the active tab. */
  unreadFinishedSessionPaths: string[];
  /** Currently viewed session path. */
  activeSessionPath: string | null;
  /** Workspace root directory. */
  workspaceCwd: string | null;
  /** Per-session analytics factors (used for pruning catalog). */
  analyticsFactorsBySession: Record<string, SessionAnalyticsFactors | null>;
  /** Per-session interrupt-in-flight flag (formerly SessionArchState). */
  interruptInFlightBySession: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Settings sub-state
// ---------------------------------------------------------------------------

/**
 * Configuration, preferences, backend readiness, and extension state.
 * Merges the former settings-slice and ui-slice.
 */
export interface SettingsState {
  /** Active model settings (default model, thinking level). */
  modelSettings: ModelSettings | null;
  /** Pruning configuration. */
  pruningSettings: PruningSettings;
  /** Available models per session. */
  availableModelsBySession: Record<string, ModelInfo[]>;
  /** Context window usage per session. */
  contextUsageBySession: Record<string, ContextWindowUsage | null>;
  /** Whether the PI backend is connected and ready. */
  backendReady: boolean;
  /** User-facing notice message, or null. */
  notice: string | null;
  /** Chat display preferences. */
  prefs: ChatPrefs;
  /** Extensions that provide tool integrations. */
  availableExtensions: ExtensionInfo[];
  /** Whether the outcome dialog is showing. */
  showOutcomeDialog: boolean;
  /** Pending extension UI request (ask-user inline choices). */
  pendingExtensionUIRequest: ExtensionUIRequestPayload | null;
}

// ---------------------------------------------------------------------------
// Composer sub-state
// ---------------------------------------------------------------------------

/**
 * Per-session composer state: pending inputs and run summaries.
 */
export interface ComposerState {
  /** Pending file/image inputs per session, awaiting send. */
  pendingComposerInputsBySession: Record<string, ComposerInput[]>;
  /** Active run summary per session (for analytics export). */
  activeRunSummaryBySession: Record<string, ActiveRunSummary | null>;
}

// ---------------------------------------------------------------------------
// File changes sub-state
// ---------------------------------------------------------------------------

/**
 * Per-session file change entries derived from tool calls.
 */
export interface FileChangesState {
  /** File change entries keyed by session path. */
  bySession: Record<string, FileChangeEntry[]>;
}

// ---------------------------------------------------------------------------
// Pending / optimistic sub-state
// ---------------------------------------------------------------------------

/** Tracks an in-flight optimistic send or edit for rollback on failure. */
export interface PendingOp {
  kind: 'send' | 'edit';
  sessionPath: string;
  /** The local transcript entry ID inserted optimistically. */
  localId: string;
  /** Session summary snapshot before optimistic name change (null = no change). */
  previousSummary: SessionSummary | null;
}

/** Tracks the first message of the active streaming turn per session. */
export interface CurrentTurn {
  requestId: string;
  firstMessageId: string;
}

/**
 * Optimistic operations, interrupt flags, message aliases, and turn tracking.
 * This sub-state is only touched by the reducer — never by the webview.
 */
export interface PendingState {
  /** Optimistic pending operations keyed by `corrId`. */
  ops: Record<string, PendingOp>;
  /** Maps aliased message IDs to canonical IDs (for multi-turn continuations). */
  messageIdAlias: Record<string, string>;
  /** Tracks the first message of the current streaming turn per session. */
  currentTurnBySession: Record<string, CurrentTurn>;
}

// ---------------------------------------------------------------------------
// Top-level ArchState (target shape — expanded during cutover)
// ---------------------------------------------------------------------------

/**
 * All application state in a single tree. Each sub-state is a cohesive
 * domain with its own set of reducer handlers.
 *
 * The projection function `selectViewState(ArchState) → ViewState`
 * derives what the webview sees from this tree.
 *
 * During the transition, the reducer uses a smaller ArchState (just pending,
 * sessions, messageIdAlias, currentTurnBySession). This expanded shape will
 * be activated when the Redux store is removed and all state moves into the
 * reducer.
 */
export interface ArchState {
  transcript: TranscriptState;
  sessions: SessionsState;
  settings: SettingsState;
  composer: ComposerState;
  fileChanges: FileChangesState;
  pending: PendingState;
}

/** Returns a fresh `ArchState` with all sub-states at their defaults. */
export function createInitialArchState(): ArchState {
  return {
    transcript: {
      bySession: {},
      systemPromptsBySession: {},
      windowBySession: {},
      editingMessageId: null,
    },
    sessions: {
      sessions: [],
      openTabPaths: [],
      runningSessionPaths: [],
      unreadFinishedSessionPaths: [],
      activeSessionPath: null,
      workspaceCwd: null,
      analyticsFactorsBySession: {},
      interruptInFlightBySession: {},
    },
    settings: {
      modelSettings: null,
      pruningSettings: { ...DEFAULT_PRUNING_SETTINGS },
      availableModelsBySession: {},
      contextUsageBySession: {},
      backendReady: false,
      notice: null,
      prefs: { ...DEFAULT_CHAT_PREFS },
      availableExtensions: [],
      showOutcomeDialog: false,
      pendingExtensionUIRequest: null,
    },
    composer: {
      pendingComposerInputsBySession: {},
      activeRunSummaryBySession: {},
    },
    fileChanges: {
      bySession: {},
    },
    pending: {
      ops: {},
      messageIdAlias: {},
      currentTurnBySession: {},
    },
  };
}

