import type {
  ActiveRunStatus,
  AssistantUsage,
  ComposerInput,
  PruningMode,
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

/**
 * Terminal status of a single assistant turn, mirrored on throughput samples
 * so rate-limit / failure signals can be graphed alongside generation speed.
 */
export type TurnThroughputStatus = 'completed' | 'error' | 'interrupted';

/**
 * One timestamped throughput observation per assistant turn.
 *
 * Throughput = `outputTokens` ÷ (`generationDurationMs` / 1000). The
 * generation duration is the wall-clock span from `message_start` to
 * `message_end`, which excludes tool-execution time (tools run between
 * messages), so it isolates how fast the model itself is emitting tokens.
 *
 * `concurrentBusySessions` records how many sessions were mid-run when the
 * turn ended (including this one), enabling multi-session throughput /
 * rate-limit-resilience analysis.
 */
export interface TurnThroughputSample {
  /** ISO timestamp when the assistant turn ended (`message_end`). */
  endedAt: string;
  /** Output tokens reported for this turn (0 when the provider did not report usage). */
  outputTokens: number;
  /** Wall-clock generation time for this turn in ms (tool-execution excluded). */
  generationDurationMs: number;
  /** Sessions concurrently mid-run when this turn ended, including this one. */
  concurrentBusySessions: number;
  /** Terminal status of the turn. */
  status: TurnThroughputStatus;
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
  /** Cumulative wall-clock execution time (ms) across all timed tool calls. */
  totalDurationMs: number;
  /** Number of completed/failed tool calls that reported an execution duration. */
  timedCallCount: number;
  /** Cumulative execution time (ms) per normalized tool name. */
  durationMsByName: Record<string, number>;
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

/**
 * Snapshot of the functional (behavioral) settings in effect when a run started.
 * Captured once at run start from `ArchState.settings` so outcomes can be
 * compared across setting values (e.g. sub-agent parent-model toggle, pruning
 * mode, per-extension enable/disable toggles). Mirrored on the analysis side.
 *
 * Intentionally a small, low-cardinality set of toggles — the dimensions most
 * useful for A/B-style graphing. Additive/optional on `RunSnapshot`: historical
 * runs recorded before this field existed coerce to `null` ("untracked").
 */
export interface FunctionalSettingsSnapshot {
  /** When true, sub-agents always use the parent's active model (skip bucket selection). */
  subagentAlwaysParentModel: boolean;
  /** Pruning mode at run start. */
  pruningMode: PruningMode;
  /** Per-extension enabled/disabled toggles at run start (extension id -> enabled). */
  extensionToggles: Record<string, boolean>;
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
  /** Functional settings snapshot captured at run start; null for runs recorded before tracking existed. */
  functionalSettings: FunctionalSettingsSnapshot | null;
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
  /**
   * Per-turn throughput observations (one timestamped sample per assistant
   * turn). Empty for runs recorded before throughput sampling existed.
   */
  turnThroughputSamples: TurnThroughputSample[];
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
