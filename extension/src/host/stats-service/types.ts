import type {
  AssistantUsage,
  ComposerInput,
  SessionAnalyticsFactors,
  ThinkingLevel,
  ToolCall,
} from '../../shared/protocol';
import type { AppStore, RootState } from '../store';
import type { TaskBoundaryIntent, RunSnapshot } from '../run-analytics';

export type StoreDispatch = AppStore['dispatch'];
export type StoreGetState = () => RootState;

export interface SessionRunState {
  currentRun: RunSnapshot | null;
  lastRun: RunSnapshot | null;
  nextTaskIntent: TaskBoundaryIntent;
  queuedUnsupportedInputCount: number;
  turnIdsSeenInCurrentRun: Set<string>;
  busyStartedAt: string | null;
}

export interface RunObserver {
  prepareForSend(sessionPath: string, inputs: ComposerInput[]): string;
  onAssistantTurnStarted(sessionPath: string, turnId: string): void;
  onAssistantTurnEnded(
    sessionPath: string,
    turnId: string,
    durationMs: number,
    usage?: AssistantUsage,
  ): void;
  onToolStarted(sessionPath: string, toolCall: ToolCall): void;
  onToolFinished(sessionPath: string, toolCall: ToolCall): void;
  onInterrupted(sessionPath: string): void;
  onMessageEdited(sessionPath: string, messageId: string): void;
  onTruncatedAfter(sessionPath: string, messageId: string): void;
  onBackendError(sessionPath: string | undefined, code: string): void;
  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number): void;
  onBusyChanged(sessionPath: string, busy: boolean): void;
  onModelConfigChanged(sessionPath: string, modelId: string | undefined, thinkingLevel: ThinkingLevel | undefined): void;
  onSessionAnalyticsFactorsChanged(sessionPath: string, factors: SessionAnalyticsFactors | null): void;
  onUnsupportedInputAttempt(sessionPath: string): void;
  onSessionClosed(sessionPath: string): void;
  replaceSessionPath(oldPath: string, newPath: string): void;
}

export const NOOP_RUN_OBSERVER: RunObserver = {
  prepareForSend: () => 'noop-run',
  onAssistantTurnStarted: () => undefined,
  onAssistantTurnEnded: () => undefined,
  onToolStarted: () => undefined,
  onToolFinished: () => undefined,
  onInterrupted: () => undefined,
  onMessageEdited: () => undefined,
  onTruncatedAfter: () => undefined,
  onBackendError: () => undefined,
  onContextUsageChanged: () => undefined,
  onBusyChanged: () => undefined,
  onModelConfigChanged: () => undefined,
  onSessionAnalyticsFactorsChanged: () => undefined,
  onUnsupportedInputAttempt: () => undefined,
  onSessionClosed: () => undefined,
  replaceSessionPath: () => undefined,
};

export interface StatsServiceOptions {
  dataOutcomesRootPath: string;
  legacyUsageDataRootPath?: string;
  workspaceId: string;
  legacyWorkspaceIds?: string[];
  scheduleRender?: () => void;
  dispatch?: StoreDispatch;
  getState?: StoreGetState;
  now?: () => Date;
  createId?: () => string;
  getExperimentAssignment?: () => string | null;
}

export function emptySessionRunState(): SessionRunState {
  return {
    currentRun: null,
    lastRun: null,
    nextTaskIntent: null,
    queuedUnsupportedInputCount: 0,
    turnIdsSeenInCurrentRun: new Set<string>(),
    busyStartedAt: null,
  };
}
