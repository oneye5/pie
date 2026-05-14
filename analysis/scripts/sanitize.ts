import {
  type RunOutcome,
  type RunSnapshot,
  type SanitizedAnalyticsData,
  type SanitizedBackendErrorRow,
  type SanitizedRunRow,
  type SanitizedToolUsageRow,
  type SanitizedVerificationUsageRow,
  type SourceAnalyticsPayload,
  type ThinkingLevel,
  type VerificationCommandKind,
} from './contracts.ts';
import { existingHashPrefix, hashToPrefix } from './hash.ts';

function normalizeNullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeVerificationState(totalCount: number, failureCount: number): 'none' | 'passing' | 'failing' {
  if (totalCount <= 0) {
    return 'none';
  }
  return failureCount > 0 ? 'failing' : 'passing';
}

function normalizeThinkingLevel(value: string | null | undefined): ThinkingLevel | null {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return normalized;
    case 'max':
      return 'xhigh';
    default:
      return null;
  }
}

function normalizeVerificationBucket(totalCount: number): '0' | '1' | '2-3' | '4+' {
  if (totalCount <= 0) {
    return '0';
  }
  if (totalCount === 1) {
    return '1';
  }
  if (totalCount <= 3) {
    return '2-3';
  }
  return '4+';
}

function toStartedDay(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function getRunOutcome(run: RunSnapshot, outcomesByRunId: Map<string, RunOutcome>): RunOutcome | null {
  return run.outcome ?? outcomesByRunId.get(run.runId) ?? null;
}

function runStatusPriority(status: RunSnapshot['status']): number {
  return status === 'open' ? 0 : 1;
}

function updatedAtMs(run: RunSnapshot): number {
  const parsed = Date.parse(run.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickPreferredRun(left: RunSnapshot, right: RunSnapshot): RunSnapshot {
  const leftPriority = runStatusPriority(left.status);
  const rightPriority = runStatusPriority(right.status);
  if (leftPriority !== rightPriority) {
    return leftPriority > rightPriority ? left : right;
  }

  if (updatedAtMs(left) !== updatedAtMs(right)) {
    return updatedAtMs(left) >= updatedAtMs(right) ? left : right;
  }

  return right;
}

function dedupeRunsById(runs: RunSnapshot[]): RunSnapshot[] {
  const deduped = new Map<string, RunSnapshot>();
  for (const run of runs) {
    const existing = deduped.get(run.runId);
    deduped.set(run.runId, existing ? pickPreferredRun(existing, run) : run);
  }
  return [...deduped.values()];
}

function sanitizeRun(run: RunSnapshot, outcomesByRunId: Map<string, RunOutcome>): SanitizedRunRow {
  const outcome = getRunOutcome(run, outcomesByRunId);
  const verificationTotalCount = run.verification.totalCount;
  const verificationFailureCount = run.verification.failureCount;
  const startedDay = toStartedDay(run.startedAt);

  return {
    runId: run.runId,
    taskGroupId: run.taskGroupId,
    sessionPathHash: hashToPrefix(run.sessionPath, 16),
    status: run.status,
    scored: run.scored,
    startedAt: run.startedAt,
    startedDay,
    updatedAt: run.updatedAt,
    finalizedAt: run.finalizedAt ?? null,
    finalizationReason: run.finalizationReason ?? null,
    resolution: outcome?.resolution ?? null,
    satisfaction: outcome?.satisfaction ?? null,
    modelId: normalizeNullableText(run.modelId),
    thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
    mixedModelConfig: run.mixedModelConfig,
    mixedTreatmentConfig: run.mixedTreatmentConfig,
    experimentAssignment: normalizeNullableText(run.experimentAssignment),
    promptFamily: normalizeNullableText(run.analyticsFactors?.promptFamily),
    promptHashPrefix: existingHashPrefix(run.analyticsFactors?.promptHash),
    toolSetHashPrefix: existingHashPrefix(run.analyticsFactors?.toolSetHash),
    skillSetHashPrefix: existingHashPrefix(run.analyticsFactors?.skillSetHash),
    skillEntries: (run.analyticsFactors?.skills ?? []).map((s) => ({
      name: s.name,
      lastModifiedAt: s.lastModifiedAt,
    })),
    selectedToolCount: run.analyticsFactors?.selectedToolIds.length ?? 0,
    skillCount: run.analyticsFactors?.skills.length ?? 0,
    contextFileCount: run.analyticsFactors?.contextFiles.length ?? 0,
    promptGuidelineCount: run.analyticsFactors?.promptGuidelineHashes.length ?? 0,
    sendCount: run.sendCount,
    assistantTurnCount: run.assistantTurnCount,
    assistantTurnDurationMs: run.assistantTurnDurationMs,
    busyDurationMs: run.busyDurationMs,
    busyPeriodCount: run.busyPeriodCount,
    interruptedCount: run.interruptedCount,
    messageEditCount: run.messageEditCount,
    truncatedAfterCount: run.truncatedAfterCount,
    backendErrorCount: run.backendErrorCodes.length,
    contextTokens: run.contextTokens,
    contextLimit: run.contextLimit,
    filesystemPathRefCount: run.filesystemPathRefCount,
    imageInputCount: run.imageInputCount,
    imageInputBytes: run.imageInputBytes,
    unsupportedInputCount: run.unsupportedInputCount,
    inputKindsUsed: [...run.inputKindsUsed],
    toolCallCount: run.toolUsage.totalCount,
    toolFailureCount: run.toolUsage.failureCount,
    subagentCallCount: run.toolUsage.subagentCallCount,
    subagentTaskCount: run.toolUsage.subagentTaskCount,
    subagentAgentCount: run.toolUsage.subagentAgentNames.length,
    verificationTotalCount,
    verificationFailureCount,
    verificationState: normalizeVerificationState(verificationTotalCount, verificationFailureCount),
    verificationCountBucket: normalizeVerificationBucket(verificationTotalCount),
    verificationCountsByKind: {
      test: run.verification.countsByKind.test ?? 0,
      build: run.verification.countsByKind.build ?? 0,
      lint: run.verification.countsByKind.lint ?? 0,
      typecheck: run.verification.countsByKind.typecheck ?? 0,
      format: run.verification.countsByKind.format ?? 0,
      other: run.verification.countsByKind.other ?? 0,
    },
    fileWriteCount: run.fileMutation.writeCount,
    fileEditCount: run.fileMutation.editCount,
    fileDeleteCount: run.fileMutation.deleteCount,
    fileRenameCount: run.fileMutation.renameCount,
    touchedFileCount: run.fileMutation.touchedFileCount,
    lineAdditions: run.fileMutation.lineAdditions,
    lineDeletions: run.fileMutation.lineDeletions,
    lineModifications: run.fileMutation.lineModifications,
    lineMutationTotal:
      run.fileMutation.lineAdditions + run.fileMutation.lineDeletions + run.fileMutation.lineModifications,
  };
}

function sanitizeToolUsage(run: RunSnapshot, outcome: RunOutcome | null): SanitizedToolUsageRow[] {
  const startedDay = toStartedDay(run.startedAt);
  return Object.entries(run.toolUsage.countsByName)
    .filter(([, callCount]) => callCount > 0)
    .map(([toolName, callCount]) => ({
      runId: run.runId,
      toolName,
      callCount,
      failureCount: run.toolUsage.failureCountsByName[toolName] ?? 0,
      startedAt: run.startedAt,
      startedDay,
      modelId: normalizeNullableText(run.modelId),
      thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
      experimentAssignment: normalizeNullableText(run.experimentAssignment),
      mixedTreatmentConfig: run.mixedTreatmentConfig,
      scored: run.scored,
      satisfaction: outcome?.satisfaction ?? null,
      resolution: outcome?.resolution ?? null,
    }));
}

function sanitizeVerificationUsage(run: RunSnapshot, outcome: RunOutcome | null): SanitizedVerificationUsageRow[] {
  const startedDay = toStartedDay(run.startedAt);
  const kinds: VerificationCommandKind[] = ['test', 'build', 'lint', 'typecheck', 'format', 'other'];
  return kinds
    .map((kind) => [kind, run.verification.countsByKind[kind] ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({
      runId: run.runId,
      kind,
      count,
      runHadAnyFailure: run.verification.failureCount > 0,
      startedAt: run.startedAt,
      startedDay,
      modelId: normalizeNullableText(run.modelId),
      thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
      experimentAssignment: normalizeNullableText(run.experimentAssignment),
      mixedTreatmentConfig: run.mixedTreatmentConfig,
      scored: run.scored,
      satisfaction: outcome?.satisfaction ?? null,
      resolution: outcome?.resolution ?? null,
    }));
}

function sanitizeBackendErrors(run: RunSnapshot, outcome: RunOutcome | null): SanitizedBackendErrorRow[] {
  if (run.backendErrorCodes.length === 0) {
    return [];
  }

  const counts = new Map<string, number>();
  for (const errorCode of run.backendErrorCodes) {
    const trimmed = errorCode.trim();
    if (!trimmed) {
      continue;
    }
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }

  const startedDay = toStartedDay(run.startedAt);
  return [...counts.entries()].map(([errorCode, count]) => ({
    runId: run.runId,
    errorCode,
    count,
    startedAt: run.startedAt,
    startedDay,
    modelId: normalizeNullableText(run.modelId),
    thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
    experimentAssignment: normalizeNullableText(run.experimentAssignment),
    scored: run.scored,
    satisfaction: outcome?.satisfaction ?? null,
    resolution: outcome?.resolution ?? null,
  }));
}

export function sanitizeSourceAnalytics(source: SourceAnalyticsPayload): SanitizedAnalyticsData {
  const outcomesByRunId = new Map<string, RunOutcome>();
  for (const outcome of source.outcomes) {
    outcomesByRunId.set(outcome.runId, outcome.outcome);
  }

  const dedupedRuns = dedupeRunsById([...source.completedRuns, ...source.openRuns]);
  const runs = dedupedRuns.map((run) => sanitizeRun(run, outcomesByRunId));
  const toolUsage: SanitizedToolUsageRow[] = [];
  const verificationUsage: SanitizedVerificationUsageRow[] = [];
  const backendErrors: SanitizedBackendErrorRow[] = [];

  for (const run of dedupedRuns) {
    const outcome = getRunOutcome(run, outcomesByRunId);
    toolUsage.push(...sanitizeToolUsage(run, outcome));
    verificationUsage.push(...sanitizeVerificationUsage(run, outcome));
    backendErrors.push(...sanitizeBackendErrors(run, outcome));
  }

  return {
    sourceSchemaVersion: source.schemaVersion,
    sourceExportedAt: source.exportedAt,
    sourceWorkspaceKey: source.workspaceKey,
    runs,
    toolUsage,
    verificationUsage,
    backendErrors,
  };
}
