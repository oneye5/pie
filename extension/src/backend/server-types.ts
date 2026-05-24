import type { ContextWindowUsage, ThinkingLevel } from '../shared/protocol';
import type { DisplayTranscriptCache } from './transcript-window';
import type { ExtensionUIBridge } from './extension-ui-bridge';
import type { SdkBuildSystemPromptOptions, SdkRuntime, SdkSession } from './sdk';

export interface ActiveRequest {
  id: string;
  messageIndex: number;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  currentMessageId?: string;
  lastAssistantMessageId?: string;
  currentMessageStartedAt?: number;
  aborted: boolean;
}

export interface SessionContext {
  runtime: SdkRuntime;
  session: SdkSession;
  sessionPath: string;
  unsubscribe: () => void;
  activeRequest?: ActiveRequest;
  /** Per-session monotonic counter for `busy.changed` events. */
  busySeq: number;
  lastContextUsage?: ContextWindowUsage | null;
  displayTranscriptCache?: DisplayTranscriptCache;
  /** UI bridge for extension UI requests within this session. */
  uiBridge?: ExtensionUIBridge;
}

export interface SessionPromptState {
  _baseSystemPrompt?: string;
  _baseSystemPromptOptions?: SdkBuildSystemPromptOptions;
}

export type SessionContextCreationReason = 'new' | 'resume';
