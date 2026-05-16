import type { VerificationCommandKind, SubagentTaskScoreRollup, ToolFailureKind } from '../../shared/tool-call-analysis';
import type {
  FileExtensionRollup,
  FileMutationRollup,
  ToolFailureSample,
  ToolUsageRollup,
  TreatmentChangeKind,
  VerificationRollup,
} from './types';
import { coerceStringArray, isObjectRecord, toNonNegativeInteger } from './coercion-utils';

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
  'extensions',
];

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
      sum: toNonNegativeInteger(dim.sum),
      count: toNonNegativeInteger(dim.count),
      max: toNonNegativeInteger(dim.max),
    };
  };

  return {
    precision: coerceDim(value.precision),
    creativity: coerceDim(value.creativity),
    reasoning: coerceDim(value.reasoning),
    thoroughness: coerceDim(value.thoroughness),
  };
}

export function coerceTreatmentChangeKinds(value: unknown): TreatmentChangeKind[] {
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

export function createEmptyFileExtensionRollup(): FileExtensionRollup {
  return {
    readCountsByExtension: {},
    writeCountsByExtension: {},
    editCountsByExtension: {},
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

export function coerceToolUsageRollup(value: unknown): ToolUsageRollup {
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

export function coerceFileMutationRollup(value: unknown): FileMutationRollup {
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

function coerceExtensionCountRecord(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0)
      .map(([ext, count]) => [ext, Math.trunc(count as number)]),
  );
}

export function coerceFileExtensionRollup(value: unknown): FileExtensionRollup {
  if (!isObjectRecord(value)) {
    return createEmptyFileExtensionRollup();
  }

  return {
    readCountsByExtension: coerceExtensionCountRecord(value.readCountsByExtension),
    writeCountsByExtension: coerceExtensionCountRecord(value.writeCountsByExtension),
    editCountsByExtension: coerceExtensionCountRecord(value.editCountsByExtension),
  };
}

export function coerceVerificationRollup(value: unknown): VerificationRollup {
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
