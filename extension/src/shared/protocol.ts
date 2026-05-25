/**
 * Wire-protocol version. Bump when changing event/payload shapes between the
 * extension host and the backend process. The host refuses to start the backend
 * unless the values match.
 */
export const PROTOCOL_VERSION = 10;

/**
 * Wire-protocol version for the host↔webview channel. Bump when changing the
 * shape of `HostToWebviewMessage` or `WebviewToHostMessage` in a way that an
 * older webview build cannot tolerate. The webview logs a warning when the
 * value posted by the host does not match its compiled-in expectation; it does
 * not refuse to load (the webview is shipped together with the host so the
 * mismatch generally indicates a stale hot-reload).
 */
export const WEBVIEW_PROTOCOL_VERSION = 1;

export function assertProtocolVersion(peerLabel: string, protocolVersion: unknown): void {
  if (!Number.isInteger(protocolVersion)) {
    throw new Error(
      `PI protocol check failed: ${peerLabel} did not report a valid integer protocolVersion (expected ${PROTOCOL_VERSION}).`,
    );
  }

  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `PI protocol mismatch: host expects version ${PROTOCOL_VERSION} but ${peerLabel} reported ${protocolVersion}. Rebuild or update both sides together.`,
    );
  }
}

export interface RequestEnvelope<TParams = unknown> {
  id: string;
  method: string;
  params?: TParams;
}

export type ResponseEnvelope<TResult = unknown> =
  | {
      id: string;
      ok: true;
      result?: TResult;
    }
  | {
      id: string;
      ok: false;
      error: {
        code: string;
        message: string;
        data?: unknown;
      };
    };

export interface EventEnvelope<TPayload = unknown> {
  event: string;
  payload?: TPayload;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelSettings {
  defaultModel: string;
  defaultThinkingLevel: ThinkingLevel;
}

export type ModelInputKind = 'text' | 'image';

/**
 * Per-model metadata sourced from the shared `<agentDir>/model-profiles.{yaml,json}`.
 * Drives ordering and warning badges in the model picker.
 */
export interface ModelSubagentInfo {
  /** True when the model is allowed as a subagent target (profile `eligible`). */
  eligible: boolean;
  /** Sum of precision+creativity+thoroughness+reasoning (0-20). Used as overall rating. */
  aggregate: number;
  /** Optional human-readable reason recorded in the profile when ineligible. */
  disabledReason?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  /** Explicit input capabilities. Backends must default to `['text']` when unsure. */
  inputKinds: ModelInputKind[];
  contextWindow?: number;
  maxTokens?: number;
  /** Present when a matching subagent profile exists; absent for unprofiled models. */
  subagent?: ModelSubagentInfo;
}

export interface ContextWindowUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/**
 * Per-assistant-message token usage. Mirrors the fields on the pi-ai `Usage`
 * object — kept optional so older messages (or aborted/errored ones) can omit
 * fields the provider didn't report.
 */
export interface AssistantUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface SessionSummary {
  path: string;
  name: string;
  cwd: string;
  modifiedAt: string;
  messageCount: number;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * True when `name` is a backend-generated placeholder (not a user-meaningful
   * label). Lets the host preserve a real local name on top of placeholder
   * refreshes without resorting to string-content heuristics.
   */
  isPlaceholder?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  status: 'running' | 'completed' | 'failed';
}

export interface FilesystemPathComposerInput {
  id: string;
  kind: 'filesystemPathRef';
  path: string;
  name: string;
  source: 'picker' | 'drop';
}

export interface ImageBlobComposerInput {
  id: string;
  kind: 'imageBlob';
  mimeType: string;
  name: string;
  sizeBytes: number;
  dataBase64: string;
  width?: number;
  height?: number;
  source: 'paste' | 'drop';
}

export interface FileBlobComposerInput {
  id: string;
  kind: 'fileBlob';
  mimeType: string;
  name: string;
  sizeBytes: number;
  dataBase64: string;
  source: 'paste' | 'drop';
}

export type ComposerInput =
  | FilesystemPathComposerInput
  | ImageBlobComposerInput
  | FileBlobComposerInput;

export type ComposerInputDraft =
  | Omit<FilesystemPathComposerInput, 'id'>
  | Omit<ImageBlobComposerInput, 'id'>
  | Omit<FileBlobComposerInput, 'id'>;

export interface UserContentTextPart {
  kind: 'text';
  text: string;
}

export interface UserContentImagePart {
  kind: 'image';
  mimeType: string;
  dataBase64: string;
  name?: string;
  width?: number;
  height?: number;
}

export type UserContentPart = UserContentTextPart | UserContentImagePart;

export interface ChatMessageTextPart {
  kind: 'text';
  text: string;
}

export interface ChatMessageReasoningPart {
  kind: 'reasoning';
  text: string;
}

export interface ChatMessageToolCallPart {
  kind: 'toolCall';
  toolCall: ToolCall;
}

export type ChatMessagePart =
  | ChatMessageTextPart
  | ChatMessageReasoningPart
  | ChatMessageToolCallPart;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  createdAt: string;
  markdown: string;
  /** Ordered user content blocks when the message contains structured user input (e.g. pasted images). */
  userParts?: UserContentPart[];
  /** Ordered assistant content blocks as emitted by the agent. */
  parts?: ChatMessagePart[];
  /** Accumulated reasoning/thinking content (only present on assistant messages from reasoning models). */
  thinking?: string;
  /** Model id used for this assistant response, when the backend can determine it. */
  modelId?: string;
  /** Reasoning/thinking level used for this assistant response, when available. */
  thinkingLevel?: ThinkingLevel;
  status: 'streaming' | 'completed' | 'interrupted' | 'error';
  /** Human-readable error detail when status is 'error'. */
  errorDetail?: string;
  toolCalls?: ToolCall[];
  /** How long the response took to complete, in milliseconds. Only set on finished assistant messages. */
  durationMs?: number;
  /** Token accounting reported by the provider for this assistant turn, when available. */
  usage?: AssistantUsage;
  /** Custom message type from a pi extension (e.g. 'pruning-result'). Present on system messages mapped from custom_message entries. */
  customType?: string;
  /** Structured details from a custom_message entry, when provided by the source extension. Typed per customType. */
  customDetails?: CustomMessageDetails;
}

/**
 * Discriminated detail payloads keyed by `customType`.
 * Fallback `unknown` covers future extension types that haven't been typed yet.
 */
export type CustomMessageDetails = PruningDetails | unknown;

export type TranscriptPageDirection = 'older' | 'newer' | 'latest';

/**
 * Metadata describing the currently loaded transcript window inside the full
 * display transcript for a session.
 */
export interface TranscriptWindow {
  /** Total display-message rows currently available in the backend cache. */
  totalCount: number;
  /** Inclusive start index (0-based) of the loaded window in the full transcript. */
  loadedStart: number;
  /** Exclusive end index of the loaded window in the full transcript. */
  loadedEnd: number;
  /** True when there are undisplayed older rows before `loadedStart`. */
  hasOlder: boolean;
  /** True when there are undisplayed newer rows after `loadedEnd`. */
  hasNewer: boolean;
  /** True when the loaded window is only a subset of the full transcript. */
  isPartial: boolean;
  /** True when the full transcript contains at least one user message. */
  hasUserMessages: boolean;
}

export interface TranscriptPagePayload {
  sessionPath: string;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  busy: boolean;
}

export type SystemPromptSource = 'provider' | 'harness' | 'user';

export type SystemPromptAvailability = 'available' | 'missing' | 'hidden' | 'unknown';

export interface SystemPromptEntry {
  source: SystemPromptSource;
  title: string;
  text: string;
  summary: string;
  availability: SystemPromptAvailability;
  /** Full path or extra detail shown on hover when the title is shortened. */
  tooltip?: string;
}

export interface SessionContextFileFactor {
  path: string;
  hash: string;
}

export interface SessionToolSnippetFactor {
  toolId: string;
  hash: string;
}

export interface SessionSkillFactor {
  name: string;
  contentHash: string | null;
  sourceHash: string | null;
  disableModelInvocation: boolean;
  lastModifiedAt: string | null;
}

export interface SessionAnalyticsFactors {
  promptFamily: string | null;
  promptHash: string | null;
  harnessPromptHash: string | null;
  customPromptHash: string | null;
  appendSystemPromptHash: string | null;
  promptGuidelineHashes: string[];
  contextFiles: SessionContextFileFactor[];
  selectedToolIds: string[];
  toolSnippetHashes: SessionToolSnippetFactor[];
  toolSetHash: string | null;
  skills: SessionSkillFactor[];
  skillSetHash: string | null;
  /** Names of extensions active during this run (e.g. 'subagent', 'safeguard'). */
  activeExtensions: string[];
}

export interface BackendReadyPayload {
  sdkPath: string;
  agentDir: string;
  /** Version string of the loaded `@mariozechner/pi-coding-agent` SDK. */
  sdkVersion: string;
  /** Wire protocol version. Must match `PROTOCOL_VERSION` in the host. */
  protocolVersion: number;
  /** Resolved path to the auth.json file used by the backend. */
  authPath?: string;
}

export interface SessionOpenedPayload {
  session: SessionSummary;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  busy: boolean;
  selectionToken?: string;
  systemPrompts?: SystemPromptEntry[];
  analyticsFactors?: SessionAnalyticsFactors;
  modelSettings?: ModelSettings;
  availableModels?: ModelInfo[];
  contextUsage?: ContextWindowUsage;
}

export interface SessionListChangedPayload {
  sessions: SessionSummary[];
  activeSessionPath?: string;
}

export interface MessageStartedPayload {
  requestId: string;
  messageId: string;
  sessionPath: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface MessageDeltaPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  delta: string;
}

export interface MessageThinkingPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  thinking: string;
}

export interface ToolStartedPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  toolCallId: string;
  name: string;
  input: unknown;
}

export interface ToolFinishedPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  toolCallId: string;
  result: unknown;
  status: Extract<ToolCall['status'], 'completed' | 'failed'>;
}

export interface ToolProgressPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  toolCallId: string;
  /** Partial result from onUpdate callback — same shape as the final result. */
  partialResult: unknown;
}

export interface MessageFinishedPayload {
  requestId: string;
  sessionPath: string;
  message: ChatMessage;
}

export interface MessageAbortedPayload {
  requestId: string;
  sessionPath: string;
  messageId?: string;
}

export interface BusyChangedPayload {
  sessionPath: string;
  busy: boolean;
  /**
   * Monotonic per-session sequence number. The host drops out-of-order events
   * for a session (e.g. a stale `busy=false` arriving after an optimistic set).
   */
  seq?: number;
}

export interface ContextUsageChangedPayload {
  sessionPath: string;
  contextUsage: ContextWindowUsage | null;
}

export interface ErrorPayload {
  code: string;
  message: string;
  requestId?: string;
}

export type FileChangeKind = 'created' | 'modified' | 'deleted';

export interface FileChangeEntry {
  path: string;
  kind: FileChangeKind;
  toolCallId: string;
  messageId: string;
  description: string;
  timestamp: string;
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  return !!value && typeof value === 'object' && 'event' in value;
}

export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  return !!value && typeof value === 'object' && 'id' in value && 'ok' in value;
}

/** A targeted patch sent for high-frequency streaming updates between full state snapshots. */
export type PatchOp =
  | { kind: 'messageDelta'; messageId: string; delta: string }
  | { kind: 'messageThinking'; messageId: string; thinking: string }
  | { kind: 'toolCall'; messageId: string; toolCall: ToolCall }
  | { kind: 'clearOverlay'; messageIds?: string[] };

/** Webview-local UI preferences. Owned by the host so they survive teardown. */
/** Metadata describing a known pi extension (tool or hook). */
export interface ExtensionInfo {
  /** Machine-readable extension name (e.g. 'subagent', 'safeguard'). */
  id: string;
  /** Human-readable label shown in the settings UI. */
  label: string;
  /** Short description of what the extension does. */
  description: string;
}

/** Parsed pruning result emitted by the skill-pruner extension. */
export interface PruningResult {
  skillsKept: number;
  skillsTotal: number;
  toolsKept: number;
  toolsTotal: number;
  tokensSaved: number;
  hasSkillPruning: boolean;
  hasToolPruning: boolean;
  /** Error message if the pruning prepass failed. */
  error?: string;
  /** Full pruning details for expanded view in the banner. */
  details?: PruningDetails;
}

/** Rich details from skill-pruner's pruning-result custom message. */
export interface PruningDetails {
  includedSkills: string[];
  excludedSkills: string[];
  includedTools: string[];
  excludedTools: string[];
  mode: 'auto' | 'shadow' | 'off';
  skillTokensSaved: number;
  toolTokensSaved: number;
  /** Model used for the prepass LLM call. */
  prepassModel?: string;
  /** Thinking level of the prepass call. */
  prepassThinkingLevel?: string;
  /** Raw LLM response text (the reasoning/JSON output). */
  prepassResponse?: string;
  /** System prompt sent to the pruning LLM. */
  prepassSystemPrompt?: string;
  /** Latency of the prepass LLM call in milliseconds. */
  prepassLatencyMs?: number;
  /** Error message if pruning prepass failed. */
  prepassError?: string;
}

export type PruningMode = 'auto' | 'shadow' | 'off';

/** Subset of pruning config exposed in the settings UI. */
export interface PruningSettings {
  mode: PruningMode;
  skillCeiling: number;
  toolCeiling: number;
  /** Model used for the pruning prepass LLM call. */
  model: string;
  /** Provider for the pruning prepass model. */
  provider: string;
  /** Thinking level for the pruning prepass. */
  thinkingLevel: ThinkingLevel;
}

export interface ChatPrefs {
  autoExpandReasoning: boolean;
  autoExpandToolCalls: boolean;
  autoExpandSubagentCalls: boolean;
  suppressCompletionNotifications: boolean;
  showPruningMessages: boolean;
  /** Per-extension enabled/disabled toggles. Keys are extension IDs. */
  extensionToggles: Record<string, boolean>;
  /** Per-provider enabled/disabled toggles. Keys are provider names. */
  providerToggles: Record<string, boolean>;
}

/** Environment key used to expose pie provider toggles to in-process pi extensions. */
export const PROVIDER_TOGGLES_ENV = 'PIE_PROVIDER_TOGGLES_JSON';

/** Environment key used to expose pie extension toggles to in-process pi extensions. */
export const EXTENSION_TOGGLES_ENV = 'PIE_EXTENSION_TOGGLES_JSON';

export type ActiveRunStatus = 'open' | 'scored' | 'closed_unscored';

export interface ActiveRunSummary {
  runId: string;
  status: ActiveRunStatus;
  scored: boolean;
  /** True when the next send is queued to start a new task group. */
  nextSendStartsNewTask?: boolean;
}

export type RunOutcomeResolution = 'resolved' | 'partially_resolved' | 'unresolved';

export interface RunOutcome {
  resolution: RunOutcomeResolution;
  /** Intended to be a user-facing ordinal score (e.g. 1–5). */
  satisfaction: number;
}

export const DEFAULT_CHAT_PREFS: ChatPrefs = {
  autoExpandReasoning: false,
  autoExpandToolCalls: false,
  autoExpandSubagentCalls: false,
  suppressCompletionNotifications: false,
  showPruningMessages: true,
  extensionToggles: {},
  providerToggles: {},
};

export const DEFAULT_PRUNING_SETTINGS: PruningSettings = {
  mode: 'auto',
  skillCeiling: 5,
  toolCeiling: 5,
  model: 'gpt-5.4-mini',
  provider: 'github-copilot',
  thinkingLevel: 'minimal',
};

export const EMPTY_TRANSCRIPT_WINDOW: TranscriptWindow = {
  totalCount: 0,
  loadedStart: 0,
  loadedEnd: 0,
  hasOlder: false,
  hasNewer: false,
  isPartial: false,
  hasUserMessages: false,
};

export function resolveChatPrefs(prefs?: Partial<ChatPrefs> | null): ChatPrefs {
  return {
    ...DEFAULT_CHAT_PREFS,
    ...prefs,
    extensionToggles: {
      ...DEFAULT_CHAT_PREFS.extensionToggles,
      ...(prefs?.extensionToggles ?? {}),
    },
    providerToggles: {
      ...DEFAULT_CHAT_PREFS.providerToggles,
      ...(prefs?.providerToggles ?? {}),
    },
    autoExpandSubagentCalls:
      prefs?.autoExpandSubagentCalls
      ?? prefs?.autoExpandToolCalls
      ?? DEFAULT_CHAT_PREFS.autoExpandSubagentCalls,
  };
}

// ─── Extension UI types ──────────────────────────────────────────────────────

/** Methods supported by the extension UI bridge. */
export type ExtensionUIMethod = 'confirm' | 'select' | 'input' | 'notify';

/** A pending extension UI request (backend → host → webview). */
export type ExtensionUIRequestPayload =
  | { id: string; method: 'confirm'; title: string; message: string; timeout?: number; extensionId?: string }
  | { id: string; method: 'select'; title: string; options: string[]; timeout?: number; extensionId?: string }
  | { id: string; method: 'input'; title: string; placeholder?: string; timeout?: number; extensionId?: string }
  | { id: string; method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error'; extensionId?: string };

/** Response from the webview (webview → host → backend). */
export interface ExtensionUIResponsePayload {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
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
  /** Message ID currently being edited, or null. */
  editingMessageId: string | null;
  /** Whether the run-outcome dialog is open. */
  showOutcomeDialog: boolean;
  /** Pending extension UI request awaiting user response, or null. */
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
    };

/** Messages the webview can send back to the host. */
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'refreshState' }
  | {
      /**
       * Request a state snapshot. When `sessionPath` is provided the host MAY
       * respond with a snapshot scoped to that session; when omitted the host
       * responds with a global snapshot (all sessions + global state). Today the
       * host always responds with a global snapshot; the optional field is wired
       * through so per-session snapshot recovery can land without a protocol bump.
       */
      type: 'requestSnapshot';
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
  | { type: 'revertFile'; sessionPath: string; filePath: string }
  | { type: 'extensionUiResponse'; sessionPath: string; response: ExtensionUIResponsePayload };
