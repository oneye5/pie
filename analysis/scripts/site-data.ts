import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  GENERATOR_VERSION,
  DATA_MODE_LOCAL_DEFAULT,
  SITE_DATA_FILE_NAMES,
  SITE_DATA_SCHEMA_VERSION,
  type ModelQualityAggregateRow,
  type ModelQualityData,
  type OverviewData,
  type ResolutionCounts,
  type PreparedAnalyticsData,
  type PreparedRunRow,
  type SiteDataBundle,
  type SiteDataFileName,
  type SiteManifest,
  type TimelineData,
  type TimelineRow,
  type ToolUsageAggregateRow,
  type ToolUsageData,
  type TreatmentComparisonData,
  type TreatmentComparisonRow,
  type VerificationImpactData,
  type VerificationImpactRow,
} from './contracts.ts';
import { ensureDir, writeJsonFile } from './fs-utils.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[], digits = 3): number | null {
  if (values.length === 0) {
    return null;
  }
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, digits);
}

function percentile(values: number[], p: number, digits = 0): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return round(sorted[lower]!, digits);
  }
  return round(sorted[lower]! * (1 - (index - lower)) + sorted[upper]! * (index - lower), digits);
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[midpoint] ?? null;
  }
  return round(((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2, 0);
}

function normalizeModelId(modelId: string | null): string {
  return modelId?.trim() ? modelId : '(unknown)';
}

function normalizeThinkingLevel(thinkingLevel: string | null): string {
  return thinkingLevel?.trim() ? thinkingLevel : '(unspecified)';
}

function normalizeExperimentAssignment(experimentAssignment: string | null): string {
  return experimentAssignment?.trim() ? experimentAssignment : '(none)';
}

function normalizePromptFamily(promptFamily: string | null): string {
  return promptFamily?.trim() ? promptFamily : '(none)';
}

function createEmptyResolutionCounts(): ResolutionCounts {
  return {
    resolved: 0,
    partiallyResolved: 0,
    unresolved: 0,
  };
}

function addResolutionCount(counts: ResolutionCounts, resolution: PreparedRunRow['resolution']): void {
  switch (resolution) {
    case 'resolved':
      counts.resolved += 1;
      break;
    case 'partially_resolved':
      counts.partiallyResolved += 1;
      break;
    case 'unresolved':
      counts.unresolved += 1;
      break;
    default:
      break;
  }
}

function createManifest(prepared: PreparedAnalyticsData, generatedAt: Date): SiteManifest {
  const completedRunCount = prepared.runs.filter((run) => run.status !== 'open').length;
  const openRunCount = prepared.runs.filter((run) => run.status === 'open').length;
  const scoredRunCount = prepared.runs.filter((run) => run.scored && run.satisfaction !== null).length;

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    sourceAnalyticsSchemaVersion: prepared.sourceSchemaVersion,
    generatedAt: generatedAt.toISOString(),
    sourceWorkspaceKey: prepared.sourceWorkspaceKey,
    sourceExportedAt: prepared.sourceExportedAt,
    completedRunCount,
    openRunCount,
    scoredRunCount,
    dataMode: DATA_MODE_LOCAL_DEFAULT,
    generatorVersion: GENERATOR_VERSION,
  };
}

function createOverview(prepared: PreparedAnalyticsData): OverviewData {
  const runs = prepared.runs;
  const completedRuns = runs.filter((run) => run.status !== 'open');
  const scoredRuns = completedRuns.filter((run) => run.satisfaction !== null);
  const resolutionCounts = createEmptyResolutionCounts();
  for (const run of scoredRuns) {
    addResolutionCount(resolutionCounts, run.resolution);
  }

  const totalToolCalls = completedRuns.reduce((sum, run) => sum + run.toolCallCount, 0);
  const totalToolFailures = completedRuns.reduce((sum, run) => sum + run.toolFailureCount, 0);
  const latestRunTimestamp = [...completedRuns]
    .map((run) => run.updatedAt)
    .sort((left, right) => left.localeCompare(right))
    .at(-1) ?? null;

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    totalCompletedRuns: completedRuns.length,
    totalOpenRuns: runs.filter((run) => run.status === 'open').length,
    totalScoredRuns: scoredRuns.length,
    averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
    resolutionCounts,
    medianBusyDurationMs: median(completedRuns.map((run) => run.busyDurationMs)),
    p90BusyDurationMs: percentile(completedRuns.map((run) => run.busyDurationMs), 90),
    p99BusyDurationMs: percentile(completedRuns.map((run) => run.busyDurationMs), 99),
    verificationRunRate: completedRuns.length === 0
      ? null
      : round(completedRuns.filter((run) => run.verificationTotalCount > 0).length / completedRuns.length, 3),
    toolFailureRate: totalToolCalls === 0 ? null : round(totalToolFailures / totalToolCalls, 3),
    medianTokenEfficiency: percentile(completedRuns.map((r) => r.tokenEfficiency).filter((v): v is number => v !== null), 50, 1),
    averageContextUtilization: average(completedRuns.map((r) => r.contextUtilization).filter((v): v is number => v !== null), 3),
    averageCacheHitRatio: average(completedRuns.map((r) => r.cacheHitRatio).filter((v): v is number => v !== null), 3),
    firstAttemptSuccessRate: completedRuns.length === 0
      ? null
      : round(completedRuns.filter((r) => r.firstAttemptSuccess).length / completedRuns.length, 3),
    latestRunTimestamp,
  };
}

function createModelQuality(prepared: PreparedAnalyticsData): ModelQualityData {
  const groups = new Map<string, PreparedRunRow[]>();
  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    const key = [
      normalizeModelId(run.modelId),
      normalizeThinkingLevel(run.thinkingLevel),
      normalizeExperimentAssignment(run.experimentAssignment),
    ].join('::');
    const existing = groups.get(key) ?? [];
    existing.push(run);
    groups.set(key, existing);
  }

  const rows: ModelQualityAggregateRow[] = [...groups.entries()].map(([key, runs]) => {
    const [modelId, thinkingLevel, experimentAssignment] = key.split('::');
    const scoredRuns = runs.filter((run) => run.satisfaction !== null);
    const resolutionCounts = createEmptyResolutionCounts();
    for (const run of scoredRuns) {
      addResolutionCount(resolutionCounts, run.resolution);
    }

    return {
      modelId: modelId ?? '(unknown)',
      thinkingLevel: thinkingLevel ?? '(unspecified)',
      experimentAssignment: experimentAssignment ?? '(none)',
      runCount: runs.length,
      scoredRunCount: scoredRuns.length,
      averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
      averageBusyDurationMs: average(runs.map((run) => run.busyDurationMs), 0),
      medianBusyDurationMs: median(runs.map((run) => run.busyDurationMs)),
      p90BusyDurationMs: percentile(runs.map((run) => run.busyDurationMs), 90),
      p99BusyDurationMs: percentile(runs.map((run) => run.busyDurationMs), 99),
      averageToolFailures: average(runs.map((run) => run.toolFailureCount), 2),
      verificationRunRate: runs.length === 0
        ? null
        : round(runs.filter((run) => run.verificationTotalCount > 0).length / runs.length, 3),
      medianTokenEfficiency: percentile(runs.map((r) => r.tokenEfficiency).filter((v): v is number => v !== null), 50, 1),
      averageContextUtilization: average(runs.map((r) => r.contextUtilization).filter((v): v is number => v !== null), 3),
      averageCacheHitRatio: average(runs.map((r) => r.cacheHitRatio).filter((v): v is number => v !== null), 3),
      firstAttemptSuccessRate: runs.length === 0
        ? null
        : round(runs.filter((r) => r.firstAttemptSuccess).length / runs.length, 3),
      resolutionCounts,
    };
  });

  rows.sort((left, right) => {
    if (right.runCount !== left.runCount) {
      return right.runCount - left.runCount;
    }
    if (left.modelId !== right.modelId) {
      return left.modelId.localeCompare(right.modelId);
    }
    if (left.thinkingLevel !== right.thinkingLevel) {
      return left.thinkingLevel.localeCompare(right.thinkingLevel);
    }
    return left.experimentAssignment.localeCompare(right.experimentAssignment);
  });

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
    notes: [
      'Satisfaction averages from fewer than 3 scored runs are highly variable and should be interpreted with caution.',
      'Runs from the same task group are not independent observations; treat per-run sample sizes as upper bounds.',
    ],
  };
}

function createVerificationImpact(prepared: PreparedAnalyticsData): VerificationImpactData {
  const groupedRuns = new Map<string, PreparedRunRow[]>();
  const summaryGroups = new Map<string, PreparedRunRow[]>();

  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    const kinds = prepared.verificationUsage
      .filter((row) => row.runId === run.runId)
      .map((row) => row.kind);
    const effectiveKinds = kinds.length > 0 ? [...new Set(kinds)] : ['none'];
    for (const verificationKind of effectiveKinds) {
      const key = [verificationKind, run.verificationCountBucket, run.verificationState].join('::');
      const existing = groupedRuns.get(key) ?? [];
      existing.push(run);
      groupedRuns.set(key, existing);
    }

    const summaryExisting = summaryGroups.get(run.verificationState) ?? [];
    summaryExisting.push(run);
    summaryGroups.set(run.verificationState, summaryExisting);
  }

  const rows: VerificationImpactRow[] = [...groupedRuns.entries()].map(([key, runs]) => {
    const [verificationKind, countBucket, verificationState] = key.split('::');
    const scoredRuns = runs.filter((run) => run.satisfaction !== null);
    const resolutionCounts = createEmptyResolutionCounts();
    for (const run of scoredRuns) {
      addResolutionCount(resolutionCounts, run.resolution);
    }
    return {
      verificationKind: verificationKind ?? 'none',
      countBucket: (countBucket ?? '0') as VerificationImpactRow['countBucket'],
      verificationState: (verificationState ?? 'none') as VerificationImpactRow['verificationState'],
      runCount: new Set(runs.map((run) => run.runId)).size,
      scoredRunCount: new Set(scoredRuns.map((run) => run.runId)).size,
      averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
      resolutionCounts,
    };
  });

  rows.sort((left, right) => {
    if (left.verificationKind !== right.verificationKind) {
      return left.verificationKind.localeCompare(right.verificationKind);
    }
    if (left.countBucket !== right.countBucket) {
      return left.countBucket.localeCompare(right.countBucket);
    }
    return left.verificationState.localeCompare(right.verificationState);
  });

  const summaryRows = [...summaryGroups.entries()].map(([verificationState, runs]) => {
    const scoredRuns = runs.filter((run) => run.satisfaction !== null);
    const resolutionCounts = createEmptyResolutionCounts();
    for (const run of scoredRuns) {
      addResolutionCount(resolutionCounts, run.resolution);
    }
    return {
      verificationState: verificationState as VerificationImpactData['summaryRows'][number]['verificationState'],
      runCount: runs.length,
      scoredRunCount: scoredRuns.length,
      averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
      resolutionCounts,
    };
  });

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
    summaryRows,
    notes: [
      'Verification failures are tracked at the run level; per-kind failure attribution is not available in the source snapshots.',
      'Open (in-progress) runs are excluded from verification impact metrics.',
    ],
  };
}

function createToolUsage(prepared: PreparedAnalyticsData): ToolUsageData {
  const grouped = new Map<string, typeof prepared.toolUsage>();
  for (const row of prepared.toolUsage) {
    const existing = grouped.get(row.toolName) ?? [];
    existing.push(row);
    grouped.set(row.toolName, existing);
  }

  const scoredRuns = prepared.runs.filter((run) => run.satisfaction !== null);

  const summaryRows: ToolUsageAggregateRow[] = [...grouped.entries()].map(([toolName, toolRows]) => {
    const usedRunIds = new Set(toolRows.map((row) => row.runId));
    const usedRuns = scoredRuns.filter((run) => usedRunIds.has(run.runId));
    const unusedRuns = scoredRuns.filter((run) => !usedRunIds.has(run.runId));
    return {
      toolName,
      callCount: toolRows.reduce((sum, row) => sum + row.callCount, 0),
      failureCount: toolRows.reduce((sum, row) => sum + row.failureCount, 0),
      executionFailureCount: toolRows.reduce((sum, row) => sum + row.executionFailureCount, 0),
      verificationProjectFailureCount: toolRows.reduce((sum, row) => sum + row.verificationProjectFailureCount, 0),
      probeFailureCount: toolRows.reduce((sum, row) => sum + row.probeFailureCount, 0),
      affectedRunCount: usedRunIds.size,
      averageSatisfactionWhenUsed: average(usedRuns.map((run) => run.satisfaction!), 2),
      averageSatisfactionWhenUnused: average(unusedRuns.map((run) => run.satisfaction!), 2),
    };
  });

  summaryRows.sort((left, right) => {
    if (right.callCount !== left.callCount) {
      return right.callCount - left.callCount;
    }
    return left.toolName.localeCompare(right.toolName);
  });

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows: prepared.toolUsage,
    summaryRows,
  };
}

function createTreatmentComparison(prepared: PreparedAnalyticsData): TreatmentComparisonData {
  const groups = new Map<string, PreparedRunRow[]>();
  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    const key = [
      normalizePromptFamily(run.promptFamily),
      run.promptHashPrefix ?? '',
      run.toolSetHashPrefix ?? '',
      run.skillSetHashPrefix ?? '',
      normalizeExperimentAssignment(run.experimentAssignment),
      run.mixedTreatmentConfig ? 'mixed' : 'pure',
    ].join('::');
    const existing = groups.get(key) ?? [];
    existing.push(run);
    groups.set(key, existing);
  }

  const rows: TreatmentComparisonRow[] = [...groups.entries()].map(([key, runs]) => {
    const [promptFamily, promptHashPrefix, toolSetHashPrefix, skillSetHashPrefix, experimentAssignment, purity] = key.split('::');
    const scoredRuns = runs.filter((run) => run.satisfaction !== null);
    const resolutionCounts = createEmptyResolutionCounts();
    for (const run of scoredRuns) {
      addResolutionCount(resolutionCounts, run.resolution);
    }

    return {
      promptFamily: promptFamily ?? '(none)',
      promptHashPrefix: promptHashPrefix || null,
      toolSetHashPrefix: toolSetHashPrefix || null,
      skillSetHashPrefix: skillSetHashPrefix || null,
      experimentAssignment: experimentAssignment ?? '(none)',
      mixedTreatmentConfig: purity === 'mixed',
      runCount: runs.length,
      scoredRunCount: scoredRuns.length,
      averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
      resolutionCounts,
    };
  });

  rows.sort((left, right) => {
    if (right.runCount !== left.runCount) {
      return right.runCount - left.runCount;
    }
    if (left.promptFamily !== right.promptFamily) {
      return left.promptFamily.localeCompare(right.promptFamily);
    }
    return left.experimentAssignment.localeCompare(right.experimentAssignment);
  });

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
  };
}

function createTimeline(prepared: PreparedAnalyticsData): TimelineData {
  const groups = new Map<string, PreparedRunRow[]>();
  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    const existing = groups.get(run.startedDay) ?? [];
    existing.push(run);
    groups.set(run.startedDay, existing);
  }

  const rows: TimelineRow[] = [...groups.entries()]
    .sort(([leftBucket], [rightBucket]) => leftBucket.localeCompare(rightBucket))
    .map(([bucketStart, runs]) => {
      const scoredRuns = runs.filter((run) => run.satisfaction !== null);
      const modelMix = Object.fromEntries(
        [...runs.reduce((counts, run) => {
          const modelId = normalizeModelId(run.modelId);
          counts.set(modelId, (counts.get(modelId) ?? 0) + 1);
          return counts;
        }, new Map<string, number>()).entries()].sort(([left], [right]) => left.localeCompare(right)),
      );

      return {
        bucketStart,
        runCount: runs.length,
        scoredRunCount: scoredRuns.length,
        averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
        verificationRunCount: runs.filter((run) => run.verificationTotalCount > 0).length,
        toolFailureCount: runs.reduce((sum, run) => sum + run.toolFailureCount, 0),
        averageBusyDurationMs: average(runs.map((run) => run.busyDurationMs), 0),
        modelMix,
      };
    });

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
  };
}

export function buildSiteDataBundle(prepared: PreparedAnalyticsData, generatedAt = new Date()): SiteDataBundle {
  return {
    manifest: createManifest(prepared, generatedAt),
    overview: createOverview(prepared),
    runSummary: {
      schemaVersion: SITE_DATA_SCHEMA_VERSION,
      rows: prepared.runs,
    },
    modelQuality: createModelQuality(prepared),
    verificationImpact: createVerificationImpact(prepared),
    toolUsage: createToolUsage(prepared),
    treatmentComparison: createTreatmentComparison(prepared),
    timeline: createTimeline(prepared),
  };
}

export function siteDataFileMap(bundle: SiteDataBundle): Record<SiteDataFileName, unknown> {
  return {
    'manifest.json': bundle.manifest,
    'overview.json': bundle.overview,
    'run-summary.json': bundle.runSummary,
    'model-quality.json': bundle.modelQuality,
    'verification-impact.json': bundle.verificationImpact,
    'tool-usage.json': bundle.toolUsage,
    'treatment-comparison.json': bundle.treatmentComparison,
    'timeline.json': bundle.timeline,
  };
}

async function assertNoUnexpectedSiteDataFiles(outputDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        throw new Error(`Unexpected subdirectory found in site data directory: ${entry.name}`);
      }
      if (!entry.isFile()) {
        continue;
      }
      if (path.extname(entry.name).toLowerCase() !== '.json') {
        throw new Error(`Unexpected non-JSON file found in site data directory: ${entry.name}`);
      }
      if (!SITE_DATA_FILE_NAMES.includes(entry.name as SiteDataFileName)) {
        throw new Error(`Unexpected JSON file found in site data directory: ${entry.name}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export async function writeSiteData(outputDir: string, bundle: SiteDataBundle): Promise<void> {
  if (path.extname(outputDir).toLowerCase() === '.json') {
    throw new Error(`Site-data output must be a directory, received JSON file path: ${outputDir}`);
  }
  if (path.basename(outputDir).toLowerCase() === 'run-analytics.json') {
    throw new Error('Refusing to use run-analytics.json as a site-data output target.');
  }

  await assertNoUnexpectedSiteDataFiles(outputDir);
  await ensureDir(outputDir);
  const files = siteDataFileMap(bundle);
  await Promise.all(
    SITE_DATA_FILE_NAMES.map(async (fileName) => {
      await writeJsonFile(path.join(outputDir, fileName), files[fileName]);
    }),
  );
}

function validateManifest(manifest: unknown): asserts manifest is SiteManifest {
  assert(isRecord(manifest), 'manifest.json must contain an object.');
  assert(manifest.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'manifest.json has an unexpected schemaVersion.');
  assert(typeof manifest.generatedAt === 'string', 'manifest.json is missing generatedAt.');
  assert(typeof manifest.sourceWorkspaceKey === 'string', 'manifest.json is missing sourceWorkspaceKey.');
  assert(typeof manifest.sourceExportedAt === 'string', 'manifest.json is missing sourceExportedAt.');
  assert(typeof manifest.completedRunCount === 'number', 'manifest.json is missing completedRunCount.');
  assert(typeof manifest.openRunCount === 'number', 'manifest.json is missing openRunCount.');
  assert(typeof manifest.scoredRunCount === 'number', 'manifest.json is missing scoredRunCount.');
  assert(manifest.dataMode === DATA_MODE_LOCAL_DEFAULT, 'manifest.json has an unexpected dataMode.');
}

function validateOverview(overview: unknown, manifest: SiteManifest): asserts overview is OverviewData {
  assert(isRecord(overview), 'overview.json must contain an object.');
  assert(overview.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'overview.json has an unexpected schemaVersion.');
  assert(overview.totalCompletedRuns === manifest.completedRunCount, 'overview.json totalCompletedRuns does not match manifest.json.');
  assert(overview.totalOpenRuns === manifest.openRunCount, 'overview.json totalOpenRuns does not match manifest.json.');
  assert(overview.totalScoredRuns === manifest.scoredRunCount, 'overview.json totalScoredRuns does not match manifest.json.');
}

function validateRunSummary(runSummary: unknown): void {
  assert(isRecord(runSummary), 'run-summary.json must contain an object.');
  assert(runSummary.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'run-summary.json has an unexpected schemaVersion.');
  assert(Array.isArray(runSummary.rows), 'run-summary.json is missing rows.');
  for (const [index, row] of runSummary.rows.entries()) {
    assert(isRecord(row), `run-summary.json row ${index} must be an object.`);
    assert(typeof row.runId === 'string', `run-summary.json row ${index} is missing runId.`);
    assert(typeof row.sessionPathHash === 'string', `run-summary.json row ${index} is missing sessionPathHash.`);
    assert(typeof row.toolCallCount === 'number', `run-summary.json row ${index} is missing toolCallCount.`);
  }
}

function validateComparativeRows(label: string, rows: unknown): void {
  assert(Array.isArray(rows), `${label} is missing rows.`);
  rows.forEach((row, index) => {
    assert(isRecord(row), `${label} row ${index} must be an object.`);
    assert(typeof row.runCount === 'number' && row.runCount >= 0, `${label} row ${index} has an invalid runCount.`);
  });
}

function validateToolUsage(toolUsage: unknown): asserts toolUsage is ToolUsageData {
  assert(isRecord(toolUsage), 'tool-usage.json must contain an object.');
  assert(toolUsage.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'tool-usage.json has an unexpected schemaVersion.');
  assert(Array.isArray(toolUsage.rows), 'tool-usage.json is missing rows.');
  toolUsage.rows.forEach((row, index) => {
    assert(isRecord(row), `tool-usage.json row ${index} must be an object.`);
    assert(typeof row.toolName === 'string', `tool-usage.json row ${index} is missing toolName.`);
    assert(typeof row.callCount === 'number' && row.callCount >= 0, `tool-usage.json row ${index} has an invalid callCount.`);
    assert(typeof row.runId === 'string', `tool-usage.json row ${index} is missing runId.`);
  });
  assert(Array.isArray(toolUsage.summaryRows), 'tool-usage.json is missing summaryRows.');
  toolUsage.summaryRows.forEach((row, index) => {
    assert(isRecord(row), `tool-usage.json summary row ${index} must be an object.`);
    assert(typeof row.toolName === 'string', `tool-usage.json summary row ${index} is missing toolName.`);
    assert(typeof row.callCount === 'number' && row.callCount >= 0, `tool-usage.json summary row ${index} has an invalid callCount.`);
    assert(typeof row.affectedRunCount === 'number' && row.affectedRunCount >= 0, `tool-usage.json summary row ${index} has an invalid affectedRunCount.`);
  });
}

function validateVerificationImpact(verificationImpact: unknown): asserts verificationImpact is VerificationImpactData {
  assert(isRecord(verificationImpact), 'verification-impact.json must contain an object.');
  assert(verificationImpact.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'verification-impact.json has an unexpected schemaVersion.');
  assert(Array.isArray(verificationImpact.rows), 'verification-impact.json is missing rows.');
  assert(Array.isArray(verificationImpact.summaryRows), 'verification-impact.json is missing summaryRows.');
  verificationImpact.summaryRows.forEach((row, index) => {
    assert(isRecord(row), `verification-impact.json summary row ${index} must be an object.`);
    assert(typeof row.verificationState === 'string', `verification-impact.json summary row ${index} is missing verificationState.`);
    assert(typeof row.runCount === 'number' && row.runCount >= 0, `verification-impact.json summary row ${index} has an invalid runCount.`);
  });
}

function validateTimeline(timeline: unknown): asserts timeline is TimelineData {
  assert(isRecord(timeline), 'timeline.json must contain an object.');
  assert(timeline.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'timeline.json has an unexpected schemaVersion.');
  assert(Array.isArray(timeline.rows), 'timeline.json is missing rows.');
  let previousBucket: string | null = null;
  for (const [index, row] of timeline.rows.entries()) {
    assert(isRecord(row), `timeline.json row ${index} must be an object.`);
    assert(typeof row.bucketStart === 'string', `timeline.json row ${index} is missing bucketStart.`);
    assert(typeof row.runCount === 'number' && row.runCount >= 0, `timeline.json row ${index} has an invalid runCount.`);
    assert(isRecord(row.modelMix), `timeline.json row ${index} is missing modelMix.`);
    if (previousBucket !== null) {
      assert(previousBucket.localeCompare(row.bucketStart) <= 0, 'timeline.json rows must be sorted by bucketStart.');
    }
    previousBucket = row.bucketStart;
  }
}

export function validateSiteDataBundle(bundle: SiteDataBundle): void {
  validateManifest(bundle.manifest);
  validateOverview(bundle.overview, bundle.manifest);
  validateRunSummary(bundle.runSummary);
  validateComparativeRows('model-quality.json', bundle.modelQuality.rows);
  validateVerificationImpact(bundle.verificationImpact);
  validateToolUsage(bundle.toolUsage);
  validateComparativeRows('treatment-comparison.json', bundle.treatmentComparison.rows);
  validateTimeline(bundle.timeline);
}

export async function readSiteDataBundle(outputDir: string): Promise<SiteDataBundle> {
  await assertNoUnexpectedSiteDataFiles(outputDir);
  const fileMap = await Promise.all(SITE_DATA_FILE_NAMES.map(async (fileName) => {
    const content = JSON.parse(await fs.readFile(path.join(outputDir, fileName), 'utf8')) as unknown;
    return [fileName, content] as const;
  }));
  const files = Object.fromEntries(fileMap) as Record<SiteDataFileName, unknown>;
  return {
    manifest: files['manifest.json'] as SiteDataBundle['manifest'],
    overview: files['overview.json'] as SiteDataBundle['overview'],
    runSummary: files['run-summary.json'] as SiteDataBundle['runSummary'],
    modelQuality: files['model-quality.json'] as SiteDataBundle['modelQuality'],
    verificationImpact: files['verification-impact.json'] as SiteDataBundle['verificationImpact'],
    toolUsage: files['tool-usage.json'] as SiteDataBundle['toolUsage'],
    treatmentComparison: files['treatment-comparison.json'] as SiteDataBundle['treatmentComparison'],
    timeline: files['timeline.json'] as SiteDataBundle['timeline'],
  };
}
