import type {
  ActiveRunStatus,
  AssistantUsage,
  ComposerInput,
  RunOutcome,
  SessionAnalyticsFactors,
  ThinkingLevel,
} from '../shared/protocol';
import type { VerificationCommandKind, SubagentTaskScoreRollup, ToolFailureKind } from '../shared/tool-call-analysis';

export const RUN_ANALYTICS_SCHEMA_VERSION = 1;

export type TaskBoundaryIntent = 'new_task' | 'continue_task' | null;
export type RunFinalizationReason = 'scored' | 'closed_unscored' | 'new_task';

export type TreatmentChangeKind =
  | 'model'
  | 'thinking'
  | 'prompt'
  | 'toolSelection'
  | 'skills'
  | 'experimentAssignment';

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

const VERIFICATION_COMMAND_KINDS: VerificationCommandKind[] = [
  'test',
  'build',
  'lint',
  'typecheck',
  'format',
  'other',
];

const TOOL_FAILURE_KINDS: ToolFailureKind[] = [
  'unavailable_tool',
  'invalid_tool_arguments',
  'missing_file_or_path',
  'shell_command_error',
  'probe_no_match',
  'verification_project_failure',
  'timeout',
  'nonzero_exit',
  'unknown',
];

const TREATMENT_CHANGE_KINDS: TreatmentChangeKind[] = [
  'model',
  'thinking',
  'prompt',
  'toolSelection',
  'skills',
  'experimentAssignment',
];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isRunOutcome(value: unknown): value is RunOutcome {
  return !!value
    && typeof value === 'object'
    && 'resolution' in value
    && 'satisfaction' in value
    && typeof (value as { resolution: unknown }).resolution === 'string'
    && typeof (value as { satisfaction: unknown }).satisfaction === 'number';
}

function isInputKindArray(value: unknown): value is Array<ComposerInput['kind']> {
  return Array.isArray(value)
    && value.every((item) => item === 'filesystemPathRef' || item === 'imageBlob' || item === 'fileBlob');
}

function toNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function coerceSubagentTaskScores(value: unknown): SubagentTaskScoreRollup {
  if (!isObjectRecord(value)) {
    return {
      precision:    { sum: 0, count: 0, max: 0 },
      creativity:   { sum: 0, count: 0, max: 0 },
      reasoning:    { sum: 0, count: 0, max: 0 },
      thoroughness: { sum: 0, count: 0, max: 0 },
    };
  }

  const coerceDim = (dim: unknown): { sum: number; count: number; max: number } => {
    if (!isObjectRecord(dim)) return { sum: 0, count: 0, max: 0 };
    return {
      sum:   toNonNegativeInteger(dim.sum),
      count: toNonNegativeInteger(dim.count),
      max:   toNonNegativeInteger(dim.max),
    };
  };

  return {
    precision:    coerceDim(value.precision),
    creativity:   coerceDim(value.creativity),
    reasoning:    coerceDim(value.reasoning),
    thoroughness: coerceDim(value.thoroughness),
  };
}

function coerceTreatmentChangeKinds(value: unknown): TreatmentChangeKind[] {
  const kinds = new Set<TreatmentChangeKind>();
  for (const item of coerceStringArray(value)) {
    if (TREATMENT_CHANGE_KINDS.includes(item as TreatmentChangeKind)) {
      kinds.add(item as TreatmentChangeKind);
    }
  }
  return [...kinds];
}

function createEmptyToolFailureKindRecord(): Record<ToolFailureKind, number> {
  return {
    unavailable_tool: 0,
    invalid_tool_arguments: 0,
    missing_file_or_path: 0,
    shell_command_error: 0,
    probe_no_match: 0,
    verification_project_failure: 0,
    timeout: 0,
    nonzero_exit: 0,
    unknown: 0,
  };
}

export function createEmptyToolUsageRollup(): ToolUsageRollup {
  return {
    totalCount: 0,
    failureCount: 0,
    executionFailureCount: 0,
    verificationProjectFailureCount: 0,
    probeFailureCount: 0,
    countsByName: {},
    failureCountsByName: {},
    failureCountsByKind: createEmptyToolFailureKindRecord(),
    failureCountsByNameAndKind: {},
    failureSamples: [],
    subagentCallCount: 0,
    subagentTaskCount: 0,
    subagentAgentNames: [],
    subagentScoredTaskCount: 0,
    subagentTaskScores: {
      precision:    { sum: 0, count: 0, max: 0 },
      creativity:   { sum: 0, count: 0, max: 0 },
      reasoning:    { sum: 0, count: 0, max: 0 },
      thoroughness: { sum: 0, count: 0, max: 0 },
    },
  };
}

export function createEmptyFileMutationRollup(): FileMutationRollup {
  return {
    writeCount: 0,
    editCount: 0,
    deleteCount: 0,
    renameCount: 0,
    touchedFileCount: 0,
    lineAdditions: 0,
    lineDeletions: 0,
    lineModifications: 0,
  };
}

export function createEmptyVerificationRollup(): VerificationRollup {
  return {
    totalCount: 0,
    failureCount: 0,
    countsByKind: {
      test: 0,
      build: 0,
      lint: 0,
      typecheck: 0,
      format: 0,
      other: 0,
    },
  };
}

function coerceToolFailureKindRecord(value: unknown): Record<ToolFailureKind, number> {
  const result = createEmptyToolFailureKindRecord();
  if (!isObjectRecord(value)) {
    return result;
  }
  for (const kind of TOOL_FAILURE_KINDS) {
    const count = value[kind];
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      result[kind] = Math.trunc(count);
    }
  }
  return result;
}

function coerceToolFailureSample(value: unknown): ToolFailureSample | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const failureKind = typeof value.failureKind === 'string' && TOOL_FAILURE_KINDS.includes(value.failureKind as ToolFailureKind)
    ? value.failureKind as ToolFailureKind
    : null;
  if (typeof value.toolName !== 'string' || !failureKind || typeof value.occurredAt !== 'string') {
    return null;
  }
  const exitCode = typeof value.exitCode === 'number' && Number.isFinite(value.exitCode)
    ? Math.trunc(value.exitCode)
    : null;
  return {
    toolName: value.toolName,
    failureKind,
    exitCode,
    errorExcerpt: typeof value.errorExcerpt === 'string' ? value.errorExcerpt : '',
    verificationKinds: coerceStringArray(value.verificationKinds)
      .filter((kind): kind is VerificationCommandKind => VERIFICATION_COMMAND_KINDS.includes(kind as VerificationCommandKind)),
    occurredAt: value.occurredAt,
  };
}

function coerceToolUsageRollup(value: unknown): ToolUsageRollup {
  if (!isObjectRecord(value)) {
    return createEmptyToolUsageRollup();
  }

  const countsByName = isObjectRecord(value.countsByName)
    ? Object.fromEntries(
      Object.entries(value.countsByName)
        .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0)
        .map(([name, count]) => [name, Math.trunc(count as number)]),
    )
    : {};
  const failureCountsByName = isObjectRecord(value.failureCountsByName)
    ? Object.fromEntries(
      Object.entries(value.failureCountsByName)
        .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0)
        .map(([name, count]) => [name, Math.trunc(count as number)]),
    )
    : {};
  const failureCountsByNameAndKind: Record<string, Record<ToolFailureKind, number>> = {};
  if (isObjectRecord(value.failureCountsByNameAndKind)) {
    for (const [toolName, counts] of Object.entries(value.failureCountsByNameAndKind)) {
      failureCountsByNameAndKind[toolName] = coerceToolFailureKindRecord(counts);
    }
  }

  return {
    totalCount: toNonNegativeInteger(value.totalCount),
    failureCount: toNonNegativeInteger(value.failureCount),
    executionFailureCount: toNonNegativeInteger(value.executionFailureCount),
    verificationProjectFailureCount: toNonNegativeInteger(value.verificationProjectFailureCount),
    probeFailureCount: toNonNegativeInteger(value.probeFailureCount),
    countsByName,
    failureCountsByName,
    failureCountsByKind: coerceToolFailureKindRecord(value.failureCountsByKind),
    failureCountsByNameAndKind,
    failureSamples: Array.isArray(value.failureSamples)
      ? value.failureSamples.map(coerceToolFailureSample).filter((sample): sample is ToolFailureSample => sample !== null)
      : [],
    subagentCallCount: toNonNegativeInteger(value.subagentCallCount),
    subagentTaskCount: toNonNegativeInteger(value.subagentTaskCount),
    subagentAgentNames: coerceStringArray(value.subagentAgentNames),
    subagentScoredTaskCount: toNonNegativeInteger(value.subagentScoredTaskCount),
    subagentTaskScores: coerceSubagentTaskScores(value.subagentTaskScores),
  };
}

function coerceFileMutationRollup(value: unknown): FileMutationRollup {
  if (!isObjectRecord(value)) {
    return createEmptyFileMutationRollup();
  }

  return {
    writeCount: toNonNegativeInteger(value.writeCount),
    editCount: toNonNegativeInteger(value.editCount),
    deleteCount: toNonNegativeInteger(value.deleteCount),
    renameCount: toNonNegativeInteger(value.renameCount),
    touchedFileCount: toNonNegativeInteger(value.touchedFileCount),
    lineAdditions: toNonNegativeInteger(value.lineAdditions),
    lineDeletions: toNonNegativeInteger(value.lineDeletions),
    lineModifications: toNonNegativeInteger(value.lineModifications),
  };
}

function coerceVerificationRollup(value: unknown): VerificationRollup {
  if (!isObjectRecord(value)) {
    return createEmptyVerificationRollup();
  }

  const countsByKind = createEmptyVerificationRollup().countsByKind;
  if (isObjectRecord(value.countsByKind)) {
    for (const kind of VERIFICATION_COMMAND_KINDS) {
      countsByKind[kind] = toNonNegativeInteger(value.countsByKind[kind], 0);
    }
  }

  return {
    totalCount: toNonNegativeInteger(value.totalCount),
    failureCount: toNonNegativeInteger(value.failureCount),
    countsByKind,
  };
}

function coerceContextFiles(value: unknown): SessionAnalyticsFactors['contextFiles'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isObjectRecord)
    .map((entry) => ({
      path: typeof entry.path === 'string' ? entry.path : '',
      hash: typeof entry.hash === 'string' ? entry.hash : '',
    }))
    .filter((entry) => entry.path.length > 0 && entry.hash.length > 0);
}

function coerceToolSnippetHashes(value: unknown): SessionAnalyticsFactors['toolSnippetHashes'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isObjectRecord)
    .map((entry) => ({
      toolId: typeof entry.toolId === 'string' ? entry.toolId : '',
      hash: typeof entry.hash === 'string' ? entry.hash : '',
    }))
    .filter((entry) => entry.toolId.length > 0 && entry.hash.length > 0);
}

function coerceSkills(value: unknown): SessionAnalyticsFactors['skills'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isObjectRecord)
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : '',
      contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : null,
      sourceHash: typeof entry.sourceHash === 'string' ? entry.sourceHash : null,
      disableModelInvocation: entry.disableModelInvocation === true,
      lastModifiedAt: typeof entry.lastModifiedAt === 'string' ? entry.lastModifiedAt : null,
    }))
    .filter((entry) => entry.name.length > 0);
}

export function coerceSessionAnalyticsFactors(value: unknown): SessionAnalyticsFactors | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  return {
    promptFamily:
      value.promptFamily === null
        ? null
        : typeof value.promptFamily === 'string'
          ? value.promptFamily
          : null,
    promptHash:
      value.promptHash === null
        ? null
        : typeof value.promptHash === 'string'
          ? value.promptHash
          : null,
    harnessPromptHash:
      value.harnessPromptHash === null
        ? null
        : typeof value.harnessPromptHash === 'string'
          ? value.harnessPromptHash
          : null,
    customPromptHash:
      value.customPromptHash === null
        ? null
        : typeof value.customPromptHash === 'string'
          ? value.customPromptHash
          : null,
    appendSystemPromptHash:
      value.appendSystemPromptHash === null
        ? null
        : typeof value.appendSystemPromptHash === 'string'
          ? value.appendSystemPromptHash
          : null,
    promptGuidelineHashes: coerceStringArray(value.promptGuidelineHashes),
    contextFiles: coerceContextFiles(value.contextFiles),
    selectedToolIds: coerceStringArray(value.selectedToolIds),
    toolSnippetHashes: coerceToolSnippetHashes(value.toolSnippetHashes),
    toolSetHash:
      value.toolSetHash === null
        ? null
        : typeof value.toolSetHash === 'string'
          ? value.toolSetHash
          : null,
    skills: coerceSkills(value.skills),
    skillSetHash:
      value.skillSetHash === null
        ? null
        : typeof value.skillSetHash === 'string'
          ? value.skillSetHash
          : null,
  };
}

function coerceAssistantUsage(value: unknown): AssistantUsage | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const inputTokens = toNonNegativeInteger(value.inputTokens);
  const outputTokens = toNonNegativeInteger(value.outputTokens);
  const cacheReadTokens = toNonNegativeInteger(value.cacheReadTokens);
  const cacheWriteTokens = toNonNegativeInteger(value.cacheWriteTokens);
  const reportedTotal = toNonNegativeInteger(value.totalTokens);
  const totalTokens = reportedTotal > 0
    ? reportedTotal
    : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (totalTokens === 0) {
    return null;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

export function coerceRunSnapshot(value: unknown): RunSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<RunSnapshot>;
  if (
    typeof candidate.sessionPath !== 'string'
    || typeof candidate.runId !== 'string'
    || typeof candidate.taskGroupId !== 'string'
    || (candidate.status !== 'open' && candidate.status !== 'scored' && candidate.status !== 'closed_unscored')
    || typeof candidate.scored !== 'boolean'
    || typeof candidate.startedAt !== 'string'
    || typeof candidate.updatedAt !== 'string'
    || typeof candidate.sendCount !== 'number'
    || typeof candidate.assistantTurnCount !== 'number'
    || typeof candidate.assistantTurnDurationMs !== 'number'
    || typeof candidate.interruptedCount !== 'number'
    || typeof candidate.messageEditCount !== 'number'
    || typeof candidate.truncatedAfterCount !== 'number'
    || !Array.isArray(candidate.backendErrorCodes)
    || !candidate.backendErrorCodes.every((item) => typeof item === 'string')
    || (candidate.contextTokens !== null && typeof candidate.contextTokens !== 'number' && candidate.contextTokens !== undefined)
    || (candidate.contextLimit !== null && typeof candidate.contextLimit !== 'number' && candidate.contextLimit !== undefined)
    || typeof candidate.filesystemPathRefCount !== 'number'
    || typeof candidate.imageInputCount !== 'number'
    || typeof candidate.imageInputBytes !== 'number'
    || typeof candidate.unsupportedInputCount !== 'number'
    || !isInputKindArray(candidate.inputKindsUsed)
    || typeof candidate.mixedModelConfig !== 'boolean'
    || (candidate.finalizedAt !== undefined && typeof candidate.finalizedAt !== 'string')
    || (candidate.finalizationReason !== undefined
      && candidate.finalizationReason !== 'scored'
      && candidate.finalizationReason !== 'closed_unscored'
      && candidate.finalizationReason !== 'new_task')
    || (candidate.outcome !== undefined && !isRunOutcome(candidate.outcome))
    || (candidate.modelId !== undefined && typeof candidate.modelId !== 'string')
    || (candidate.thinkingLevel !== undefined && typeof candidate.thinkingLevel !== 'string')
  ) {
    return null;
  }

  return {
    sessionPath: candidate.sessionPath,
    runId: candidate.runId,
    taskGroupId: candidate.taskGroupId,
    status: candidate.status,
    scored: candidate.scored,
    startedAt: candidate.startedAt,
    updatedAt: candidate.updatedAt,
    finalizedAt: candidate.finalizedAt,
    finalizationReason: candidate.finalizationReason,
    outcome: candidate.outcome,
    modelId: candidate.modelId,
    thinkingLevel: candidate.thinkingLevel as ThinkingLevel | undefined,
    mixedModelConfig: candidate.mixedModelConfig,
    mixedTreatmentConfig: candidate.mixedTreatmentConfig === true,
    treatmentChangeKinds: coerceTreatmentChangeKinds(candidate.treatmentChangeKinds),
    experimentAssignment:
      candidate.experimentAssignment === null
        ? null
        : typeof candidate.experimentAssignment === 'string'
          ? candidate.experimentAssignment
          : null,
    analyticsFactors: coerceSessionAnalyticsFactors(candidate.analyticsFactors),
    sendCount: Math.trunc(candidate.sendCount),
    assistantTurnCount: Math.trunc(candidate.assistantTurnCount),
    assistantTurnDurationMs: Math.trunc(candidate.assistantTurnDurationMs),
    busyDurationMs: toNonNegativeInteger(candidate.busyDurationMs),
    busyPeriodCount: toNonNegativeInteger(candidate.busyPeriodCount),
    interruptedCount: Math.trunc(candidate.interruptedCount),
    messageEditCount: Math.trunc(candidate.messageEditCount),
    truncatedAfterCount: Math.trunc(candidate.truncatedAfterCount),
    backendErrorCodes: [...candidate.backendErrorCodes],
    contextTokens: candidate.contextTokens ?? null,
    contextLimit: candidate.contextLimit ?? null,
    inputTokens: toNonNegativeInteger(candidate.inputTokens),
    outputTokens: toNonNegativeInteger(candidate.outputTokens),
    cacheReadTokens: toNonNegativeInteger(candidate.cacheReadTokens),
    cacheWriteTokens: toNonNegativeInteger(candidate.cacheWriteTokens),
    tokenReportedTurnCount: toNonNegativeInteger(candidate.tokenReportedTurnCount),
    lastTurnUsage: coerceAssistantUsage(candidate.lastTurnUsage),
    filesystemPathRefCount: Math.trunc(candidate.filesystemPathRefCount),
    imageInputCount: Math.trunc(candidate.imageInputCount),
    imageInputBytes: Math.trunc(candidate.imageInputBytes),
    unsupportedInputCount: Math.trunc(candidate.unsupportedInputCount),
    inputKindsUsed: [...candidate.inputKindsUsed],
    toolUsage: coerceToolUsageRollup(candidate.toolUsage),
    fileMutation: coerceFileMutationRollup(candidate.fileMutation),
    verification: coerceVerificationRollup(candidate.verification),
  };
}

export function coerceOutcomeHistoryLogEntry(value: unknown): OutcomeHistoryLogEntry | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  if (
    value.schemaVersion !== RUN_ANALYTICS_SCHEMA_VERSION
    || value.kind !== 'run_outcome'
    || typeof value.recordedAt !== 'string'
    || typeof value.sessionPath !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.taskGroupId !== 'string'
    || !isRunOutcome(value.outcome)
  ) {
    return null;
  }

  return {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    kind: 'run_outcome',
    recordedAt: value.recordedAt,
    sessionPath: value.sessionPath,
    runId: value.runId,
    taskGroupId: value.taskGroupId,
    outcome: value.outcome,
  };
}

export function normalizeExperimentAssignment(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
