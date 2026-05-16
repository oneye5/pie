import type { AssistantUsage, ThinkingLevel } from '../../shared/protocol';
import { RUN_ANALYTICS_SCHEMA_VERSION } from './types';
import type { OutcomeHistoryLogEntry, RunSnapshot } from './types';
import { coerceSessionAnalyticsFactors } from './coercion-factors';
import {
  coerceFileExtensionRollup,
  coerceFileMutationRollup,
  coerceToolUsageRollup,
  coerceTreatmentChangeKinds,
  coerceVerificationRollup,
} from './coercion-rollups';
import {
  isInputKindArray,
  isObjectRecord,
  isRunOutcome,
  toNonNegativeInteger,
} from './coercion-utils';

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
    fileExtensions: coerceFileExtensionRollup(candidate.fileExtensions),
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
