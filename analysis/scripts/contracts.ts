export const RUN_ANALYTICS_SCHEMA_VERSION = 1;
export const SITE_DATA_SCHEMA_VERSION = 1;
export const DATA_MODE_LOCAL_DEFAULT = 'local-default';
export const GENERATOR_VERSION = 'analysis-v1';

export const SITE_DATA_FILE_NAMES = [
  'manifest.json',
  'overview.json',
  'run-summary.json',
  'model-quality.json',
  'verification-impact.json',
  'tool-usage.json',
  'treatment-comparison.json',
  'timeline.json',
] as const;

export type SiteDataFileName = (typeof SITE_DATA_FILE_NAMES)[number];

export type ActiveRunStatus = 'open' | 'scored' | 'closed_unscored';
export type RunFinalizationReason = 'scored' | 'closed_unscored' | 'new_task';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type InputKind = 'filesystemPathRef' | 'imageBlob' | 'fileBlob';
export type VerificationCommandKind = 'test' | 'build' | 'lint' | 'typecheck' | 'format' | 'other';
export type ToolFailureKind =
  | 'unavailable_tool'
  | 'invalid_tool_arguments'
  | 'missing_file_or_path'
  | 'shell_command_error'
  | 'probe_no_match'
  | 'verification_project_failure'
  | 'timeout'
  | 'nonzero_exit'
  | 'unknown';
export type TreatmentChangeKind =
  | 'model'
  | 'thinking'
  | 'prompt'
  | 'toolSelection'
  | 'skills'
  | 'experimentAssignment';
export type RunOutcomeResolution = 'resolved' | 'partially_resolved' | 'unresolved';
export type VerificationState = 'none' | 'passing' | 'failing';
export type VerificationCountBucket = '0' | '1' | '2-3' | '4+';

export interface RunOutcome {
  resolution: RunOutcomeResolution;
  satisfaction: number;
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
}

export interface SubagentTaskScoreRollup {
  precision:    { sum: number; count: number; max: number };
  creativity:   { sum: number; count: number; max: number };
  reasoning:    { sum: number; count: number; max: number };
  thoroughness: { sum: number; count: number; max: number };
}

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
  executionFailureCount: number;
  verificationProjectFailureCount: number;
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
  filesystemPathRefCount: number;
  imageInputCount: number;
  imageInputBytes: number;
  unsupportedInputCount: number;
  inputKindsUsed: InputKind[];
  toolUsage: ToolUsageRollup;
  fileMutation: FileMutationRollup;
  verification: VerificationRollup;
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

export interface SourceAnalyticsPayload {
  schemaVersion: number;
  exportedAt: string;
  workspaceKey: string;
  completedRuns: RunSnapshot[];
  openRuns: RunSnapshot[];
  outcomes: OutcomeHistoryLogEntry[];
}

export interface LoadedSourceAnalytics {
  source: SourceAnalyticsPayload;
  sourceKind: 'fixture' | 'export' | 'storage-dir';
  sourcePath: string;
}

export interface ResolutionCounts {
  resolved: number;
  partiallyResolved: number;
  unresolved: number;
}

export interface PreparedSkillEntry {
  name: string;
  lastModifiedAt: string | null;
}

export interface PreparedRunRow {
  runId: string;
  taskGroupId: string;
  sessionPathHash: string;
  status: ActiveRunStatus;
  scored: boolean;
  startedAt: string;
  startedDay: string;
  updatedAt: string;
  finalizedAt: string | null;
  finalizationReason: RunFinalizationReason | null;
  resolution: RunOutcomeResolution | null;
  satisfaction: number | null;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  mixedModelConfig: boolean;
  mixedTreatmentConfig: boolean;
  experimentAssignment: string | null;
  promptFamily: string | null;
  promptHashPrefix: string | null;
  toolSetHashPrefix: string | null;
  skillSetHashPrefix: string | null;
  skillEntries: PreparedSkillEntry[];
  selectedToolCount: number;
  skillCount: number;
  contextFileCount: number;
  promptGuidelineCount: number;
  sendCount: number;
  assistantTurnCount: number;
  assistantTurnDurationMs: number;
  busyDurationMs: number;
  busyPeriodCount: number;
  interruptedCount: number;
  messageEditCount: number;
  truncatedAfterCount: number;
  backendErrorCount: number;
  contextTokens: number | null;
  contextLimit: number | null;
  filesystemPathRefCount: number;
  imageInputCount: number;
  imageInputBytes: number;
  unsupportedInputCount: number;
  inputKindsUsed: InputKind[];
  toolCallCount: number;
  toolFailureCount: number;
  subagentCallCount: number;
  subagentTaskCount: number;
  subagentAgentCount: number;
  subagentScoredTaskCount: number;
  subagentMeanPrecision: number | null;
  subagentMeanCreativity: number | null;
  subagentMeanReasoning: number | null;
  subagentMeanThoroughness: number | null;
  subagentMaxPrecision: number | null;
  subagentMaxCreativity: number | null;
  subagentMaxReasoning: number | null;
  subagentMaxThoroughness: number | null;
  subagentCompositeMean: number | null;
  verificationTotalCount: number;
  verificationFailureCount: number;
  verificationState: VerificationState;
  verificationCountBucket: VerificationCountBucket;
  verificationCountsByKind: Record<VerificationCommandKind, number>;
  fileWriteCount: number;
  fileEditCount: number;
  fileDeleteCount: number;
  fileRenameCount: number;
  touchedFileCount: number;
  lineAdditions: number;
  lineDeletions: number;
  lineModifications: number;
  lineMutationTotal: number;
}

export interface PreparedToolUsageRow {
  runId: string;
  toolName: string;
  callCount: number;
  failureCount: number;
  executionFailureCount: number;
  verificationProjectFailureCount: number;
  probeFailureCount: number;
  startedAt: string;
  startedDay: string;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
  mixedTreatmentConfig: boolean;
  scored: boolean;
  satisfaction: number | null;
  resolution: RunOutcomeResolution | null;
}

export interface PreparedToolFailureRow {
  runId: string;
  toolName: string;
  failureKind: ToolFailureKind;
  count: number;
  exitCode: number | null;
  errorExcerpt: string | null;
  verificationKinds: VerificationCommandKind[];
  startedAt: string;
  startedDay: string;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
  mixedTreatmentConfig: boolean;
  scored: boolean;
  satisfaction: number | null;
  resolution: RunOutcomeResolution | null;
}

export interface PreparedVerificationUsageRow {
  runId: string;
  kind: VerificationCommandKind;
  count: number;
  runHadAnyFailure: boolean;
  startedAt: string;
  startedDay: string;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
  mixedTreatmentConfig: boolean;
  scored: boolean;
  satisfaction: number | null;
  resolution: RunOutcomeResolution | null;
}

export interface PreparedBackendErrorRow {
  runId: string;
  errorCode: string;
  count: number;
  startedAt: string;
  startedDay: string;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
  scored: boolean;
  satisfaction: number | null;
  resolution: RunOutcomeResolution | null;
}

export interface PreparedAnalyticsData {
  sourceSchemaVersion: number;
  sourceExportedAt: string;
  sourceWorkspaceKey: string;
  runs: PreparedRunRow[];
  toolUsage: PreparedToolUsageRow[];
  toolFailures: PreparedToolFailureRow[];
  verificationUsage: PreparedVerificationUsageRow[];
  backendErrors: PreparedBackendErrorRow[];
}

export interface SiteManifest {
  schemaVersion: number;
  sourceAnalyticsSchemaVersion: number;
  generatedAt: string;
  sourceWorkspaceKey: string;
  sourceExportedAt: string;
  completedRunCount: number;
  openRunCount: number;
  scoredRunCount: number;
  dataMode: typeof DATA_MODE_LOCAL_DEFAULT;
  generatorVersion: string;
}

export interface OverviewData {
  schemaVersion: number;
  totalCompletedRuns: number;
  totalOpenRuns: number;
  totalScoredRuns: number;
  averageSatisfaction: number | null;
  resolutionCounts: ResolutionCounts;
  medianBusyDurationMs: number | null;
  verificationRunRate: number | null;
  toolFailureRate: number | null;
  latestRunTimestamp: string | null;
}

export interface RunSummaryData {
  schemaVersion: number;
  rows: PreparedRunRow[];
}

export interface ModelQualityAggregateRow {
  modelId: string;
  thinkingLevel: string;
  experimentAssignment: string;
  runCount: number;
  scoredRunCount: number;
  averageSatisfaction: number | null;
  averageBusyDurationMs: number | null;
  medianBusyDurationMs: number | null;
  averageToolFailures: number | null;
  verificationRunRate: number | null;
  resolutionCounts: ResolutionCounts;
}

export interface ModelQualityData {
  schemaVersion: number;
  rows: ModelQualityAggregateRow[];
}

export interface VerificationImpactRow {
  verificationKind: string;
  countBucket: VerificationCountBucket;
  verificationState: VerificationState;
  runCount: number;
  scoredRunCount: number;
  averageSatisfaction: number | null;
  resolutionCounts: ResolutionCounts;
}

export interface VerificationImpactSummaryRow {
  verificationState: VerificationState;
  runCount: number;
  scoredRunCount: number;
  averageSatisfaction: number | null;
  resolutionCounts: ResolutionCounts;
}

export interface VerificationImpactData {
  schemaVersion: number;
  rows: VerificationImpactRow[];
  summaryRows: VerificationImpactSummaryRow[];
  notes: string[];
}

export interface ToolUsageAggregateRow {
  toolName: string;
  callCount: number;
  failureCount: number;
  executionFailureCount: number;
  verificationProjectFailureCount: number;
  probeFailureCount: number;
  affectedRunCount: number;
  averageSatisfactionWhenUsed: number | null;
  averageSatisfactionWhenUnused: number | null;
}

export interface ToolUsageData {
  schemaVersion: number;
  rows: PreparedToolUsageRow[];
  summaryRows: ToolUsageAggregateRow[];
}

export interface TreatmentComparisonRow {
  promptFamily: string;
  promptHashPrefix: string | null;
  toolSetHashPrefix: string | null;
  skillSetHashPrefix: string | null;
  experimentAssignment: string;
  mixedTreatmentConfig: boolean;
  runCount: number;
  scoredRunCount: number;
  averageSatisfaction: number | null;
  resolutionCounts: ResolutionCounts;
}

export interface TreatmentComparisonData {
  schemaVersion: number;
  rows: TreatmentComparisonRow[];
}

export interface TimelineRow {
  bucketStart: string;
  runCount: number;
  scoredRunCount: number;
  averageSatisfaction: number | null;
  verificationRunCount: number;
  toolFailureCount: number;
  averageBusyDurationMs: number | null;
  modelMix: Record<string, number>;
}

export interface TimelineData {
  schemaVersion: number;
  rows: TimelineRow[];
}

export interface SiteDataBundle {
  manifest: SiteManifest;
  overview: OverviewData;
  runSummary: RunSummaryData;
  modelQuality: ModelQualityData;
  verificationImpact: VerificationImpactData;
  toolUsage: ToolUsageData;
  treatmentComparison: TreatmentComparisonData;
  timeline: TimelineData;
}
