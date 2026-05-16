import type {
  ActiveRunStatus,
  AssistantUsage,
  ComposerInput,
  RunOutcome,
  SessionAnalyticsFactors,
  ThinkingLevel,
} from '../../shared/protocol';
import type { VerificationCommandKind, SubagentTaskScoreRollup, ToolFailureKind } from '../../shared/tool-call-analysis';

export const RUN_ANALYTICS_SCHEMA_VERSION = 1;

export type TaskBoundaryIntent = 'new_task' | 'continue_task' | null;
export type RunFinalizationReason = 'scored' | 'closed_unscored' | 'new_task';

export type TreatmentChangeKind =
  | 'model'
  | 'thinking'
  | 'prompt'
  | 'toolSelection'
  | 'skills'
  | 'experimentAssignment'
  | 'extensions';

export interface ToolFailureSample {
  toolName: string;
  failureKind: ToolFailureKind;
  exitCode: number | null;
  errorExcerpt: string;
  verificationKinds: VerificationCommandKind[];
  occurredAt: string;
}

export interface ToolUsageRollup {
  totalCount: number;
  failureCount: number;
  /** Failed tool calls excluding verification-project failures and probe/no-match outcomes. */
  executionFailureCount: number;
  /** Failed tool calls where the command was verification and exposed project failures. */
  verificationProjectFailureCount: number;
  /** Failed probe/search commands that likely mean "no matches" rather than a broken tool. */
  probeFailureCount: number;
  countsByName: Record<string, number>;
  failureCountsByName: Record<string, number>;
  failureCountsByKind: Record<ToolFailureKind, number>;
  failureCountsByNameAndKind: Record<string, Record<ToolFailureKind, number>>;
  failureSamples: ToolFailureSample[];
  subagentCallCount: number;
  subagentTaskCount: number;
  subagentAgentNames: string[];
  subagentScoredTaskCount: number;
  subagentTaskScores: SubagentTaskScoreRollup;
}

export interface FileMutationRollup {
  writeCount: number;
  editCount: number;
  deleteCount: number;
  renameCount: number;
  touchedFileCount: number;
  lineAdditions: number;
  lineDeletions: number;
  lineModifications: number;
}

export interface FileExtensionRollup {
  readCountsByExtension: Record<string, number>;
  writeCountsByExtension: Record<string, number>;
  editCountsByExtension: Record<string, number>;
}

export interface VerificationRollup {
  totalCount: number;
  failureCount: number;
  countsByKind: Record<VerificationCommandKind, number>;
}

export interface RunSnapshot {
  sessionPath: string;
  runId: string;
  taskGroupId: string;
  status: ActiveRunStatus;
  scored: boolean;
  startedAt: string;
  updatedAt: string;
  finalizedAt?: string;
  finalizationReason?: RunFinalizationReason;
  outcome?: RunOutcome;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  mixedModelConfig: boolean;
  mixedTreatmentConfig: boolean;
  treatmentChangeKinds: TreatmentChangeKind[];
  experimentAssignment: string | null;
  analyticsFactors: SessionAnalyticsFactors | null;
  sendCount: number;
  assistantTurnCount: number;
  assistantTurnDurationMs: number;
  busyDurationMs: number;
  busyPeriodCount: number;
  interruptedCount: number;
  messageEditCount: number;
  truncatedAfterCount: number;
  backendErrorCodes: string[];
  contextTokens: number | null;
  contextLimit: number | null;
  /** Cumulative input tokens reported by the provider across assistant turns in this run. */
  inputTokens: number;
  /** Cumulative output tokens reported by the provider across assistant turns in this run. */
  outputTokens: number;
  /** Cumulative cache-read tokens across assistant turns in this run. */
  cacheReadTokens: number;
  /** Cumulative cache-write tokens across assistant turns in this run. */
  cacheWriteTokens: number;
  /** Number of assistant turns in this run that reported provider usage. */
  tokenReportedTurnCount: number;
  /** Usage from the most recent assistant turn in this run that reported it. */
  lastTurnUsage: AssistantUsage | null;
  filesystemPathRefCount: number;
  imageInputCount: number;
  imageInputBytes: number;
  unsupportedInputCount: number;
  inputKindsUsed: Array<ComposerInput['kind']>;
  toolUsage: ToolUsageRollup;
  fileMutation: FileMutationRollup;
  fileExtensions: FileExtensionRollup;
  verification: VerificationRollup;
}

export interface PersistedSessionRunState {
  currentRun: RunSnapshot | null;
  lastRun: RunSnapshot | null;
  nextTaskIntent: TaskBoundaryIntent;
  queuedUnsupportedInputCount: number;
  busyStartedAt: string | null;
}

export interface RunCheckpoint {
  schemaVersion: number;
  seq: number;
  sessions: Record<string, PersistedSessionRunState>;
}

export interface RunSnapshotLogEntry {
  schemaVersion: number;
  kind: 'run_snapshot';
  recordedAt: string;
  run: RunSnapshot;
}

export interface OutcomeHistoryLogEntry {
  schemaVersion: number;
  kind: 'run_outcome';
  recordedAt: string;
  sessionPath: string;
  runId: string;
  taskGroupId: string;
  outcome: RunOutcome;
}
