/**
 * State shape for the CQRS reducer — the single source of truth for all
 * application state. The pure reducer (`core/reducer.ts`) transitions this tree
 * via `Event`s and emits `Effect`s; the projection (`core/projection.ts`)
 * derives the `ViewState` the webview renders.
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
  UserContentPart,
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
  /** Per-session message ID currently being edited. */
  editingMessageIdBySession: Record<string, string | null>;
  /**
   * Per-session corrId of the in-flight transcript paging request
   * (loadOlder/loadNewer/jumpToLatest), or absent when none is in flight.
   * Reducer-owned in-flight guard (moved from the host-side Set on
   * SessionMessageActions); keyed by corrId for request-identity, consistent
   * with send/edit PendingOp correlation. Cleared by the matching *Result
   * (or SessionScopeCleared on tab close).
   */
  pagingInFlightBySession: Record<string, string>;
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
  /** Per-session outcome dialog visibility. */
  showOutcomeDialogBySession: Record<string, boolean>;
  /** Per-session pending extension UI requests, keyed by request ID (ask-user inline choices). */
  pendingExtensionUIRequestsBySession: Record<string, Record<string, ExtensionUIRequestPayload>>;
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
  /** Draft composer text per session, persisted across reloads and session switches. */
  draftTextBySession: Record<string, string>;
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
  /** The raw user text sent (for send ops only — used to restore the draft on sendRejected). */
  text?: string;
}

/** Snapshot of the state an optimistic `SetModel` changed, for rollback when
 *  the backend `settings.set` fails. Every field the reducer flipped is
 *  captured here so revert restores exactly the pre-change state (the
 *  optimistic apply must match the disk write field-for-field; see STATE_CONTRACT
 *  § Optimistic Reconciliation).
 *
 *  `undefined` vs `null` distinguishes "key absent" (delete on revert) from
 *  "key present with a null value" (set null on revert) for the two Record
 *  fields (`contextUsageBySession`, `pendingComposerInputsBySession`). */
export interface SetModelSnapshot {
  previousModelSettings: ModelSettings | null;
  previousSummary: SessionSummary | null;
  previousContextUsage: ContextWindowUsage | null | undefined;
  previousPendingInputs: ComposerInput[] | undefined;
}

/** Tracks an in-flight `SetModel` lifecycle keyed by `corrId`.
 *
 *  Two phases share one entry:
 *  - `snapshot === null` — awaiting the user's modal confirmation (only when
 *    the switch would drop pending image inputs). No state has changed yet, so
 *    there is nothing to roll back; the entry just holds the stashed intent.
 *  - `snapshot !== null` — the optimistic apply has happened and the backend
 *    `SetModelRpc` is in flight; `SetModelResult{ok:false}` reverts via the
 *    snapshot, `{ok:true}` drops the entry. */
export interface SetModelPending {
  sessionPath: string;
  modelSettings: ModelSettings;
  snapshot: SetModelSnapshot | null;
}

/** Tracks the first message of the active streaming turn per session. */
export interface CurrentTurn {
  requestId: string;
  firstMessageId: string;
}

/**
 * A send queued while the target session was still a pending tab (backend
 * `session.create` in flight). The reducer queues the `Send` Command's payload
 * here instead of emitting `SendRpc`; when `PendingPathReplaced` resolves the
 * pending path, the reducer emits a `DrainPendingSendQueue` effect carrying
 * these entries, and the runner re-dispatches them as `Send` Commands with the
 * resolved session path.
 *
 * `previousSummary` is intentionally `null` — the optimistic session-name
 * derivation already happened via `SessionNameDerived` at enqueue time, and by
 * drain time the session has a real summary from `session.opened`. A non-null
 * `previousSummary` here would revert the name to the placeholder on a
 * `SendResult{ok:false}`, clobbering the real name.
 */
export interface PendingSendQueueEntry {
  corrId: string;
  text: string;
  inputs: ComposerInput[];
  composedText: string;
  localId: string;
  userParts?: UserContentPart[];
  previousSummary: SessionSummary | null;
  timestamp: number;
}

/**
 * A send queued while the backend was not yet ready. The reducer queues the
 * `Send` Command's payload here instead of emitting `SendRpc`; when
 * `BackendReadyChanged{ready:true}` fires, the reducer emits a
 * `DrainBackendReadyQueue` effect carrying all entries across all sessions,
 * and the runner re-dispatches them as `Send` Commands. A 30s watchdog effect
 * is started when the first send is queued; if the backend doesn't become
 * ready in time, the runner dispatches `BackendReadyWatchdogFired` and the
 * reducer drops the queued messages + removes the optimistic entries + sets a
 * notice.
 *
 * Unlike `PendingSendQueueEntry`, this type carries `sessionPath` because the
 * backend-ready queue spans multiple sessions (the drain re-dispatches each
 * entry to its own session).
 */
export interface BackendReadyQueueEntry {
  sessionPath: string;
  corrId: string;
  text: string;
  inputs: ComposerInput[];
  composedText: string;
  localId: string;
  userParts?: UserContentPart[];
  previousSummary: SessionSummary | null;
  timestamp: number;
}

/**
 * Optimistic operations, interrupt flags, message aliases, and turn tracking.
 * This sub-state is only touched by the reducer — never by the webview.
 */
export interface PendingState {
  /** Optimistic pending operations keyed by `corrId`. */
  ops: Record<string, PendingOp>;
  /** In-flight `SetModel` lifecycles keyed by `corrId` (modal-confirm + RPC). */
  setModelByCorrId: Record<string, SetModelPending>;
  /** Maps aliased message IDs to canonical IDs (for multi-turn continuations). */
  messageIdAlias: Record<string, string>;
  /** Tracks the first message of the current streaming turn per session. */
  currentTurnBySession: Record<string, CurrentTurn>;
  /** Maps backend request IDs to optimistic local message IDs for ID finalization. */
  requestIdToLocalId: Record<string, { sessionPath: string; localId: string }>;
  /** Sends queued while the target session was a pending tab, keyed by pending path. */
  sendQueueBySession: Record<string, PendingSendQueueEntry[]>;
  /** Sends queued while the backend was not yet ready, keyed by session path. */
  backendReadyQueueBySession: Record<string, BackendReadyQueueEntry[]>;
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
 * State-shape rule (binding): keyed collections MUST use `Record<string, T>`,
 * never `Map`/`Set` — see `docs/STATE_CONTRACT.md`.
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
      editingMessageIdBySession: {},
      pagingInFlightBySession: {},
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
      showOutcomeDialogBySession: {},
      pendingExtensionUIRequestsBySession: {},
    },
    composer: {
      pendingComposerInputsBySession: {},
      activeRunSummaryBySession: {},
      draftTextBySession: {},
    },
    fileChanges: {
      bySession: {},
    },
    pending: {
      ops: {},
      setModelByCorrId: {},
      messageIdAlias: {},
      currentTurnBySession: {},
      requestIdToLocalId: {},
      sendQueueBySession: {},
      backendReadyQueueBySession: {},
    },
  };
}

