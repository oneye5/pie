/**
 * Wire-protocol version. Bump when changing event/payload shapes between the
 * extension host and the backend process. The host refuses to start the backend
 * unless the values match.
 */
export const PROTOCOL_VERSION = 3;

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

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ContextWindowUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface SessionSummary {
  path: string;
  name: string;
  cwd: string;
  modifiedAt: string;
  messageCount: number;
  modelId?: string;
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
  /** Ordered assistant content blocks as emitted by the agent. */
  parts?: ChatMessagePart[];
  /** Accumulated reasoning/thinking content (only present on assistant messages from reasoning models). */
  thinking?: string;
  status: 'streaming' | 'completed' | 'interrupted' | 'error';
  toolCalls?: ToolCall[];
  /** How long the response took to complete, in milliseconds. Only set on finished assistant messages. */
  durationMs?: number;
}

export type SystemPromptSource = 'provider' | 'harness' | 'user';

export type SystemPromptAvailability = 'available' | 'missing' | 'hidden' | 'unknown';

export interface SystemPromptEntry {
  source: SystemPromptSource;
  title: string;
  text: string;
  summary: string;
  availability: SystemPromptAvailability;
}

export interface BackendReadyPayload {
  sdkPath: string;
  agentDir: string;
  /** Version string of the loaded `@mariozechner/pi-coding-agent` SDK. */
  sdkVersion: string;
  /** Wire protocol version. Must match `PROTOCOL_VERSION` in the host. */
  protocolVersion: number;
}

export interface SessionOpenedPayload {
  session: SessionSummary;
  transcript: ChatMessage[];
  busy: boolean;
  selectionToken?: string;
  systemPrompts?: SystemPromptEntry[];
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

export interface ErrorPayload {
  code: string;
  message: string;
  requestId?: string;
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
export interface ChatPrefs {
  autoExpandReasoning: boolean;
  autoExpandToolCalls: boolean;
}

export const DEFAULT_CHAT_PREFS: ChatPrefs = {
  autoExpandReasoning: false,
  autoExpandToolCalls: false,
};

/** The full view state sent from the extension host to the webview. */
export interface ViewState {
  sessions: SessionSummary[];
  openTabPaths: string[];
  runningSessionPaths: string[];
  activeSession: SessionSummary | null;
  transcript: ChatMessage[];
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
      hostInstanceId: string;
      revision: number;
      state: ViewState;
    }
  | {
      type: 'patch';
      hostInstanceId: string;
      revision: number;
      op: PatchOp;
    }
  | { type: 'sendRejected'; sessionPath: string; text: string; pendingPaths: string[] }
  | { type: 'filePickerResult'; paths: string[] };

/** Messages the webview can send back to the host. */
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'refreshState' }
  | { type: 'requestSnapshot' }
  | { type: 'openFilePicker' }
  | { type: 'openFile'; path: string }
  | { type: 'send'; text: string; pendingPaths?: string[] }
  | { type: 'editMessage'; messageId: string; text: string }
  | { type: 'interrupt' }
  | { type: 'newSession' }
  | { type: 'openSession'; sessionPath: string }
  | { type: 'closeSession'; sessionPath: string }
  | {
      type: 'setModel';
      defaultModel: string;
      defaultThinkingLevel: ThinkingLevel;
    }
  | { type: 'setPrefs'; prefs: Partial<ChatPrefs> };
