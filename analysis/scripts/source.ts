import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  type FileExtensionRollup,
  type FileMutationRollup,
  type InputKind,
  type LoadedSourceAnalytics,
  type OutcomeHistoryLogEntry,
  type PruningSourceDecision,
  type RunFinalizationReason,
  type RunOutcome,
  type RunSnapshot,
  type SessionAnalyticsFactors,
  type SourceAnalyticsPayload,
  type ThinkingLevel,
  type ToolFailureKind,
  type ToolFailureSample,
  type ToolUsageRollup,
  type TreatmentChangeKind,
  type VerificationCommandKind,
  type VerificationRollup,
} from './contracts.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_FIXTURE_PATH = fileURLToPath(new URL('../fixtures/small-run-analytics.json', import.meta.url));
export const DEFAULT_SITE_DATA_DIR = fileURLToPath(new URL('../site/data', import.meta.url));
export const DEFAULT_DUCKDB_PATH = fileURLToPath(new URL('../data/usage.duckdb', import.meta.url));
export const DEFAULT_STAGING_EXPORTS_DIR = fileURLToPath(new URL('../data/exports', import.meta.url));
export const DEFAULT_SITE_DIST_DIR = fileURLToPath(new URL('../site/dist', import.meta.url));

const INPUT_KINDS = new Set<InputKind>(['filesystemPathRef', 'imageBlob', 'fileBlob']);
const THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const FINALIZATION_REASONS = new Set<RunFinalizationReason>(['scored', 'closed_unscored', 'new_task']);
const TREATMENT_CHANGE_KINDS = new Set<TreatmentChangeKind>([
  'model',
  'thinking',
  'prompt',
  'toolSelection',
  'skills',
  'experimentAssignment',
  'extensions',
]);
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

export interface SourceSelection {
  exportPath?: string;
  storageDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function coerceOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function coerceNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function coerceCountRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      result[key] = Math.trunc(count);
    }
  }
  return result;
}

function coerceSubagentTaskScores(value: unknown): ToolUsageRollup['subagentTaskScores'] {
  if (!isRecord(value)) {
    return {
      precision:    { sum: 0, count: 0, max: 0 },
      creativity:   { sum: 0, count: 0, max: 0 },
      reasoning:    { sum: 0, count: 0, max: 0 },
      thoroughness: { sum: 0, count: 0, max: 0 },
    };
  }

  const coerceDim = (dim: unknown): { sum: number; count: number; max: number } => {
    if (!isRecord(dim)) return { sum: 0, count: 0, max: 0 };
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

function createEmptyToolUsageRollup(): ToolUsageRollup {
  return {
    totalCount: 0,
    failureCount: 0,
    executionFailureCount: 0,
    verificationProjectFailureCount: 0,
    probeFailureCount: 0,
    totalDurationMs: 0,
    timedCallCount: 0,
    durationMsByName: {},
    countsByName: {},
    failureCountsByName: {},
    failureCountsByKind: {} as Record<ToolFailureKind, number>,
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

function createEmptyFileMutationRollup(): FileMutationRollup {
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

function createEmptyFileExtensionRollup(): FileExtensionRollup {
  return {
    readCountsByExtension: {},
    writeCountsByExtension: {},
    editCountsByExtension: {},
  };
}

function coerceExtensionCountRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0)
      .map(([ext, count]) => [ext, Math.trunc(count as number)]),
  );
}

function coerceFileExtensionRollup(value: unknown): FileExtensionRollup {
  if (!isRecord(value)) {
    return createEmptyFileExtensionRollup();
  }

  return {
    readCountsByExtension: coerceExtensionCountRecord(value.readCountsByExtension),
    writeCountsByExtension: coerceExtensionCountRecord(value.writeCountsByExtension),
    editCountsByExtension: coerceExtensionCountRecord(value.editCountsByExtension),
  };
}

function createEmptyVerificationRollup(): VerificationRollup {
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
  const result = {} as Record<ToolFailureKind, number>;
  if (!isRecord(value)) {
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
  if (!isRecord(value)) {
    return null;
  }
  const failureKind = typeof value.failureKind === 'string' && TOOL_FAILURE_KINDS.includes(value.failureKind as ToolFailureKind)
    ? value.failureKind as ToolFailureKind
    : null;
  if (typeof value.toolName !== 'string' || !failureKind || typeof value.occurredAt !== 'string') {
    return null;
  }
  return {
    toolName: value.toolName,
    failureKind,
    exitCode: typeof value.exitCode === 'number' && Number.isFinite(value.exitCode) ? Math.trunc(value.exitCode) : null,
    errorExcerpt: typeof value.errorExcerpt === 'string' ? value.errorExcerpt : '',
    verificationKinds: coerceStringArray(value.verificationKinds)
      .filter((kind): kind is VerificationCommandKind => VERIFICATION_COMMAND_KINDS.includes(kind as VerificationCommandKind)),
    occurredAt: value.occurredAt,
  };
}

function coerceToolUsageRollup(value: unknown): ToolUsageRollup {
  if (!isRecord(value)) {
    return createEmptyToolUsageRollup();
  }

  const failureCountsByNameAndKind: Record<string, Record<ToolFailureKind, number>> = {};
  if (isRecord(value.failureCountsByNameAndKind)) {
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
    totalDurationMs: toNonNegativeInteger(value.totalDurationMs),
    timedCallCount: toNonNegativeInteger(value.timedCallCount),
    durationMsByName: coerceCountRecord(value.durationMsByName),
    countsByName: coerceCountRecord(value.countsByName),
    failureCountsByName: coerceCountRecord(value.failureCountsByName),
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
  if (!isRecord(value)) {
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
  if (!isRecord(value)) {
    return createEmptyVerificationRollup();
  }

  const countsByKind = createEmptyVerificationRollup().countsByKind;
  if (isRecord(value.countsByKind)) {
    for (const kind of VERIFICATION_COMMAND_KINDS) {
      countsByKind[kind] = toNonNegativeInteger(value.countsByKind[kind]);
    }
  }

  return {
    totalCount: toNonNegativeInteger(value.totalCount),
    failureCount: toNonNegativeInteger(value.failureCount),
    countsByKind,
  };
}

function coerceSessionAnalyticsFactors(value: unknown): SessionAnalyticsFactors | null {
  if (!isRecord(value)) {
    return null;
  }

  const contextFiles = Array.isArray(value.contextFiles)
    ? value.contextFiles
      .filter(isRecord)
      .map((entry) => ({
        path: typeof entry.path === 'string' ? entry.path : '',
        hash: typeof entry.hash === 'string' ? entry.hash : '',
      }))
      .filter((entry) => entry.path.length > 0 && entry.hash.length > 0)
    : [];

  const toolSnippetHashes = Array.isArray(value.toolSnippetHashes)
    ? value.toolSnippetHashes
      .filter(isRecord)
      .map((entry) => ({
        toolId: typeof entry.toolId === 'string' ? entry.toolId : '',
        hash: typeof entry.hash === 'string' ? entry.hash : '',
      }))
      .filter((entry) => entry.toolId.length > 0 && entry.hash.length > 0)
    : [];

  const skills = Array.isArray(value.skills)
    ? value.skills
      .filter(isRecord)
      .map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : null,
        sourceHash: typeof entry.sourceHash === 'string' ? entry.sourceHash : null,
        disableModelInvocation: entry.disableModelInvocation === true,
        lastModifiedAt: typeof entry.lastModifiedAt === 'string' ? entry.lastModifiedAt : null,
      }))
      .filter((entry) => entry.name.length > 0)
    : [];

  return {
    promptFamily: coerceNullableString(value.promptFamily),
    promptHash: coerceNullableString(value.promptHash),
    harnessPromptHash: coerceNullableString(value.harnessPromptHash),
    customPromptHash: coerceNullableString(value.customPromptHash),
    appendSystemPromptHash: coerceNullableString(value.appendSystemPromptHash),
    promptGuidelineHashes: coerceStringArray(value.promptGuidelineHashes),
    contextFiles,
    selectedToolIds: coerceStringArray(value.selectedToolIds),
    toolSnippetHashes,
    toolSetHash: coerceNullableString(value.toolSetHash),
    skills,
    skillSetHash: coerceNullableString(value.skillSetHash),
    activeExtensions: coerceStringArray(value.activeExtensions),
  };
}

function coerceRunOutcome(value: unknown): RunOutcome | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    (value.resolution !== 'resolved' && value.resolution !== 'partially_resolved' && value.resolution !== 'unresolved')
    || typeof value.satisfaction !== 'number'
    || !Number.isFinite(value.satisfaction)
  ) {
    return null;
  }

  return {
    resolution: value.resolution,
    satisfaction: value.satisfaction,
  };
}

function coerceInputKinds(value: unknown): InputKind[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((kind): kind is InputKind => typeof kind === 'string' && INPUT_KINDS.has(kind as InputKind));
}

function coerceTreatmentChangeKinds(value: unknown): TreatmentChangeKind[] {
  const kinds = new Set<TreatmentChangeKind>();
  for (const kind of coerceStringArray(value)) {
    if (TREATMENT_CHANGE_KINDS.has(kind as TreatmentChangeKind)) {
      kinds.add(kind as TreatmentChangeKind);
    }
  }
  return [...kinds];
}

function coerceThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'max') {
    return 'xhigh';
  }
  return THINKING_LEVELS.has(normalized as ThinkingLevel) ? normalized as ThinkingLevel : undefined;
}

export function coerceRunSnapshot(value: unknown): RunSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const status = value.status;
  if (
    typeof value.sessionPath !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.taskGroupId !== 'string'
    || (status !== 'open' && status !== 'scored' && status !== 'closed_unscored')
    || typeof value.scored !== 'boolean'
    || typeof value.startedAt !== 'string'
    || typeof value.updatedAt !== 'string'
  ) {
    return null;
  }

  const outcomeCandidate = value.outcome == null ? undefined : coerceRunOutcome(value.outcome);
  if (value.outcome != null && !outcomeCandidate) {
    return null;
  }

  const thinkingLevel = coerceThinkingLevel(value.thinkingLevel);
  const finalizationReason = typeof value.finalizationReason === 'string' && FINALIZATION_REASONS.has(value.finalizationReason as RunFinalizationReason)
    ? value.finalizationReason as RunFinalizationReason
    : undefined;

  return {
    sessionPath: value.sessionPath,
    runId: value.runId,
    taskGroupId: value.taskGroupId,
    status,
    scored: value.scored,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    finalizedAt: coerceOptionalString(value.finalizedAt),
    finalizationReason,
    outcome: outcomeCandidate ?? undefined,
    modelId: coerceOptionalString(value.modelId),
    thinkingLevel,
    mixedModelConfig: value.mixedModelConfig === true,
    mixedTreatmentConfig: value.mixedTreatmentConfig === true,
    treatmentChangeKinds: coerceTreatmentChangeKinds(value.treatmentChangeKinds),
    experimentAssignment: typeof value.experimentAssignment === 'string' && value.experimentAssignment.trim().length > 0
      ? value.experimentAssignment
      : null,
    analyticsFactors: coerceSessionAnalyticsFactors(value.analyticsFactors),
    sendCount: toNonNegativeInteger(value.sendCount),
    assistantTurnCount: toNonNegativeInteger(value.assistantTurnCount),
    assistantTurnDurationMs: toNonNegativeInteger(value.assistantTurnDurationMs),
    busyDurationMs: toNonNegativeInteger(value.busyDurationMs),
    busyPeriodCount: toNonNegativeInteger(value.busyPeriodCount),
    interruptedCount: toNonNegativeInteger(value.interruptedCount),
    messageEditCount: toNonNegativeInteger(value.messageEditCount),
    truncatedAfterCount: toNonNegativeInteger(value.truncatedAfterCount),
    backendErrorCodes: coerceStringArray(value.backendErrorCodes),
    contextTokens: typeof value.contextTokens === 'number' && Number.isFinite(value.contextTokens)
      ? Math.trunc(value.contextTokens)
      : null,
    contextLimit: typeof value.contextLimit === 'number' && Number.isFinite(value.contextLimit)
      ? Math.trunc(value.contextLimit)
      : null,
    inputTokens: toNonNegativeInteger(value.inputTokens),
    outputTokens: toNonNegativeInteger(value.outputTokens),
    cacheReadTokens: toNonNegativeInteger(value.cacheReadTokens),
    cacheWriteTokens: toNonNegativeInteger(value.cacheWriteTokens),
    tokenReportedTurnCount: toNonNegativeInteger(value.tokenReportedTurnCount),
    filesystemPathRefCount: toNonNegativeInteger(value.filesystemPathRefCount),
    imageInputCount: toNonNegativeInteger(value.imageInputCount),
    imageInputBytes: toNonNegativeInteger(value.imageInputBytes),
    unsupportedInputCount: toNonNegativeInteger(value.unsupportedInputCount),
    inputKindsUsed: coerceInputKinds(value.inputKindsUsed),
    toolUsage: coerceToolUsageRollup(value.toolUsage),
    fileMutation: coerceFileMutationRollup(value.fileMutation),
    fileExtensions: coerceFileExtensionRollup(value.fileExtensions),
    verification: coerceVerificationRollup(value.verification),
  };
}

export function coerceOutcomeHistoryEntry(value: unknown): OutcomeHistoryLogEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const outcome = coerceRunOutcome(value.outcome);
  if (
    value.schemaVersion !== RUN_ANALYTICS_SCHEMA_VERSION
    || value.kind !== 'run_outcome'
    || typeof value.recordedAt !== 'string'
    || typeof value.sessionPath !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.taskGroupId !== 'string'
    || !outcome
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
    outcome,
  };
}

function coerceRunSnapshotArray(label: string, value: unknown): RunSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array.`);
  }

  return value.map((entry, index) => {
    const snapshot = coerceRunSnapshot(entry);
    if (!snapshot) {
      throw new Error(`Invalid run snapshot at ${label}[${index}].`);
    }
    return snapshot;
  });
}

function coerceOutcomeArray(value: unknown): OutcomeHistoryLogEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected outcomes to be an array.');
  }

  return value.map((entry, index) => {
    const outcome = coerceOutcomeHistoryEntry(entry);
    if (!outcome) {
      throw new Error(`Invalid outcome history entry at outcomes[${index}].`);
    }
    return outcome;
  });
}

export function coerceSourceAnalyticsPayload(value: unknown): SourceAnalyticsPayload {
  if (!isRecord(value)) {
    throw new Error('Source analytics payload must be a JSON object.');
  }

  if (value.schemaVersion !== RUN_ANALYTICS_SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion: expected ${RUN_ANALYTICS_SCHEMA_VERSION}, received ${String(value.schemaVersion)}.`);
  }
  if (typeof value.exportedAt !== 'string') {
    throw new Error('Source analytics payload is missing exportedAt.');
  }
  if (typeof value.workspaceKey !== 'string') {
    throw new Error('Source analytics payload is missing workspaceKey.');
  }

  return {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    exportedAt: value.exportedAt,
    workspaceKey: value.workspaceKey,
    completedRuns: coerceRunSnapshotArray('completedRuns', value.completedRuns),
    openRuns: coerceRunSnapshotArray('openRuns', value.openRuns),
    outcomes: coerceOutcomeArray(value.outcomes),
    pruningDecisions: Array.isArray(value.pruningDecisions) ? value.pruningDecisions : [],
  };
}

function readPruningDecisions(configRoot: string): PruningSourceDecision[] {
  const pruningPath = path.join(configRoot, 'data', 'pruning.jsonl');
  let raw: string;
  try {
    raw = readFileSync(pruningPath, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.trim().split('\n').filter((line) => line.trim().length > 0);
  const decisions: PruningSourceDecision[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (
        typeof parsed.timestamp === 'string' &&
        typeof parsed.sessionId === 'string' &&
        typeof parsed.mode === 'string' &&
        Array.isArray(parsed.included) &&
        Array.isArray(parsed.excluded)
      ) {
        decisions.push({
          timestamp: parsed.timestamp,
          sessionId: parsed.sessionId,
          sessionPath: typeof parsed.sessionPath === 'string' ? parsed.sessionPath : parsed.sessionId,
          mode: parsed.mode,
          query: typeof parsed.query === 'string' ? parsed.query : '',
          llmModel: typeof parsed.llmModel === 'string' ? parsed.llmModel : '',
          llmThinkingLevel: typeof parsed.llmThinkingLevel === 'string' ? parsed.llmThinkingLevel : '',
          llmLatencyMs: typeof parsed.llmLatencyMs === 'number' ? parsed.llmLatencyMs : 0,
          included: parsed.included.filter((s: unknown) => typeof s === 'string'),
          excluded: parsed.excluded.filter((s: unknown) => typeof s === 'string'),
          skillBlockTokens: typeof parsed.skillBlockTokens === 'number' ? parsed.skillBlockTokens : 0,
          originalBlockTokens: typeof parsed.originalBlockTokens === 'number' ? parsed.originalBlockTokens : 0,
          toolIncluded: Array.isArray(parsed.toolIncluded) ? parsed.toolIncluded.filter((s: unknown) => typeof s === 'string') : [],
          toolExcluded: Array.isArray(parsed.toolExcluded) ? parsed.toolExcluded.filter((s: unknown) => typeof s === 'string') : [],
          toolBlockTokens: typeof parsed.toolBlockTokens === 'number' ? parsed.toolBlockTokens : 0,
          originalToolBlockTokens: typeof parsed.originalToolBlockTokens === 'number' ? parsed.originalToolBlockTokens : 0,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return decisions;
}

export async function readSourceAnalyticsPayload(filePath: string): Promise<SourceAnalyticsPayload> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read source analytics payload at ${filePath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in source analytics payload at ${filePath}: ${(error as Error).message}`);
  }

  return coerceSourceAnalyticsPayload(parsed);
}

async function querySourceAnalyticsPayloadFromStorageDir(storageDir: string): Promise<SourceAnalyticsPayload> {
  const queryModuleUrl = pathToFileURL(path.resolve(SCRIPT_DIR, '../../extension/src/host/run-analytics/query.ts')).href;
  const typesModuleUrl = pathToFileURL(path.resolve(SCRIPT_DIR, '../../extension/src/host/run-analytics/types.ts')).href;
  const [{ queryRunAnalyticsStore }, { RUN_ANALYTICS_SCHEMA_VERSION: sourceSchemaVersion }] = await Promise.all([
    import(queryModuleUrl),
    import(typesModuleUrl),
  ]);

  const result = await queryRunAnalyticsStore(storageDir);
  return {
    schemaVersion: sourceSchemaVersion,
    exportedAt: new Date().toISOString(),
    workspaceKey: path.basename(storageDir),
    completedRuns: result.completedRuns,
    openRuns: result.openRuns,
    outcomes: result.outcomes,
    pruningDecisions: [],
  };
}

export async function loadSourceAnalytics(selection: SourceSelection = {}): Promise<LoadedSourceAnalytics> {
  const configRoot = path.resolve(SCRIPT_DIR, '..', '..');
  if (selection.exportPath) {
    const source = await readSourceAnalyticsPayload(selection.exportPath);
    source.pruningDecisions = readPruningDecisions(configRoot);
    return {
      source,
      sourceKind: 'export',
      sourcePath: selection.exportPath,
    };
  }

  if (selection.storageDir) {
    const source = await querySourceAnalyticsPayloadFromStorageDir(selection.storageDir);
    source.pruningDecisions = readPruningDecisions(configRoot);
    return {
      source,
      sourceKind: 'storage-dir',
      sourcePath: selection.storageDir,
    };
  }

  const source = await readSourceAnalyticsPayload(DEFAULT_FIXTURE_PATH);
  source.pruningDecisions = readPruningDecisions(configRoot);
  return {
    source,
    sourceKind: 'fixture',
    sourcePath: DEFAULT_FIXTURE_PATH,
  };
}

