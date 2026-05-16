import {
  SITE_DATA_SCHEMA_VERSION,
  type PreparedAnalyticsData,
  type PreparedRunRow,
  type ModelLeaderboardData,
  type ModelLeaderboardRow,
  type LeaderboardDimension,
} from './contracts.ts';

const MINIMUM_SCORED_RUNS = 3;
const TARGET_SAMPLE = 10;
const TOKEN_EFFICIENCY_MAX = 50;
const WEIGHTS = { satisfaction: 0.35, resolutionRate: 0.30, firstAttemptSuccess: 0.15, toolReliability: 0.10, verificationAdoption: 0.05, tokenEfficiency: 0.05 } as const;
const T_CRITICAL_95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145, 15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086,
  21: 2.08, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
};

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function average(values: number[], digits = 3): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, digits);
}
function median(values: number[], digits = 0): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return round(sorted[midpoint] ?? 0, digits);
  return round(((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2, digits);
}
function normalizeModelId(modelId: string | null): string {
  return modelId?.trim() ? modelId : '(unknown)';
}
function normalizeThinkingLevel(thinkingLevel: string | null): string {
  return thinkingLevel?.trim() ? thinkingLevel : '(unspecified)';
}
function wilsonLower(successes: number, total: number): number | null {
  if (total <= 0) return null;
  const boundedSuccesses = clamp(successes, 0, total);
  const z = 1.96;
  const z2 = z ** 2;
  const phat = boundedSuccesses / total;
  const denominator = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denominator;
  const halfWidth = (z / denominator) * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total);
  return round(clamp(center - halfWidth, 0, 1), 4);
}
function tCritical95(df: number): number {
  if (!Number.isFinite(df) || df <= 1) return T_CRITICAL_95[1];
  if (df <= 30) return T_CRITICAL_95[Math.ceil(df)] ?? T_CRITICAL_95[30];
  if (df <= 40) return 2.021;
  if (df <= 60) return 2.0;
  if (df <= 120) return 1.98;
  return 1.96;
}
function meanLower(values: number[], min: number, max: number): number | null {
  if (values.length === 0) return null;
  const meanValue = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return round(clamp(meanValue, min, max), 4);
  const variance = values.reduce((sum, value) => sum + (value - meanValue) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  const margin = tCritical95(values.length - 1) * (sd / Math.sqrt(values.length));
  return round(clamp(meanValue - margin, min, max), 4);
}

function proportionDimension(successes: number, total: number): LeaderboardDimension {
  const value = total > 0 ? round(clamp(successes / total, 0, 1), 3) : null;
  return { value, lowerBound: wilsonLower(successes, total), n: total };
}
function resolutionScore(resolution: PreparedRunRow['resolution']): number {
  if (resolution === 'resolved') return 1;
  if (resolution === 'partially_resolved') return 0.5;
  return 0;
}
function rankRows(rows: ModelLeaderboardRow[]): void {
  const ranked = rows.filter((row) => row.compositeScore !== null).sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));
  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });
}

/**
 * Builds model leaderboard rows using conservative lower bounds of 95% confidence intervals.
 */
export function createModelLeaderboard(prepared: PreparedAnalyticsData): ModelLeaderboardData {
  const completedRuns = prepared.runs.filter((run) => run.status !== 'open');
  const grouped = new Map<string, PreparedRunRow[]>();
  for (const run of completedRuns) {
    const key = `${normalizeModelId(run.modelId)}::${normalizeThinkingLevel(run.thinkingLevel)}`;
    const existing = grouped.get(key) ?? [];
    existing.push(run);
    grouped.set(key, existing);
  }

  const rows: ModelLeaderboardRow[] = [...grouped.entries()].map(([key, runs]) => {
    const [modelId, thinkingLevel] = key.split('::');
    const scoredRuns = runs.filter((run) => run.scored && run.satisfaction !== null);
    const satisfactionValues = scoredRuns.map((run) => run.satisfaction!);
    const resolutionValues = scoredRuns.map((run) => resolutionScore(run.resolution));
    const satisfaction: LeaderboardDimension = { value: average(satisfactionValues, 2), lowerBound: meanLower(satisfactionValues, 1, 5), n: scoredRuns.length };
    const resolutionRate: LeaderboardDimension = { value: average(resolutionValues, 3), lowerBound: meanLower(resolutionValues, 0, 1), n: scoredRuns.length };
    const firstAttemptSuccess = proportionDimension(scoredRuns.filter((run) => run.firstAttemptSuccess).length, scoredRuns.length);
    const toolReliability = proportionDimension(scoredRuns.filter((run) => run.toolFailureCount === 0).length, scoredRuns.length);
    const verificationAdoption = proportionDimension(scoredRuns.filter((run) => run.verificationTotalCount > 0).length, scoredRuns.length);

    const tokenEfficiencyValues = scoredRuns.map((run) => run.tokenEfficiency).filter((value): value is number => value !== null);
    const tokenEfficiencyRawMedian = median(tokenEfficiencyValues, 3);
    const tokenEfficiency: LeaderboardDimension = {
      value: tokenEfficiencyRawMedian !== null ? round(clamp(tokenEfficiencyRawMedian, 0, TOKEN_EFFICIENCY_MAX), 3) : null,
      lowerBound: meanLower(tokenEfficiencyValues, 0, TOKEN_EFFICIENCY_MAX),
      n: tokenEfficiencyValues.length,
    };

    let compositeScore: number | null = null;
    let reliabilityFactor: number | null = null;
    if (scoredRuns.length >= MINIMUM_SCORED_RUNS) {
      const contributions: number[] = [];
      if (satisfaction.lowerBound !== null) contributions.push(WEIGHTS.satisfaction * clamp((satisfaction.lowerBound - 1) / 4, 0, 1));
      if (resolutionRate.lowerBound !== null) contributions.push(WEIGHTS.resolutionRate * clamp(resolutionRate.lowerBound, 0, 1));
      if (firstAttemptSuccess.lowerBound !== null) contributions.push(WEIGHTS.firstAttemptSuccess * clamp(firstAttemptSuccess.lowerBound, 0, 1));
      if (toolReliability.lowerBound !== null) contributions.push(WEIGHTS.toolReliability * clamp(toolReliability.lowerBound, 0, 1));
      if (verificationAdoption.lowerBound !== null) contributions.push(WEIGHTS.verificationAdoption * clamp(verificationAdoption.lowerBound, 0, 1));
      if (tokenEfficiency.lowerBound !== null) contributions.push(WEIGHTS.tokenEfficiency * clamp(1 - tokenEfficiency.lowerBound / TOKEN_EFFICIENCY_MAX, 0, 1));
      const rawComposite = contributions.reduce((sum, value) => sum + value, 0);
      reliabilityFactor = clamp(scoredRuns.length / TARGET_SAMPLE, 0, 1);
      compositeScore = round(rawComposite * reliabilityFactor, 4);
    }

    const subagentRuns = runs.filter((run) => run.subagentCallCount > 0);
    return {
      modelId: modelId ?? '(unknown)',
      thinkingLevel: thinkingLevel ?? '(unspecified)',
      runCount: runs.length,
      scoredRunCount: scoredRuns.length,
      compositeScore,
      rank: null,
      reliabilityFactor,
      dimensions: { satisfaction, resolutionRate, firstAttemptSuccess, toolReliability, verificationAdoption, tokenEfficiency },
      subagentRunCount: subagentRuns.length,
      subagentUsageRate: runs.length === 0 ? null : round(clamp(subagentRuns.length / runs.length, 0, 1), 3),
      avgSubagentTasksPerRun: average(subagentRuns.map((run) => run.subagentTaskCount), 2),
      medianDurationMs: median(runs.map((run) => run.busyDurationMs), 0),
      medianTokenEfficiency: median(runs.map((run) => run.tokenEfficiency).filter((value): value is number => value !== null), 3),
    };
  });

  rankRows(rows);
  rows.sort((left, right) => {
    if (left.rank === null && right.rank !== null) return 1;
    if (left.rank !== null && right.rank === null) return -1;
    if (left.rank !== null && right.rank !== null && left.rank !== right.rank) return left.rank - right.rank;
    if ((right.compositeScore ?? -1) !== (left.compositeScore ?? -1)) return (right.compositeScore ?? -1) - (left.compositeScore ?? -1);
    if (right.runCount !== left.runCount) return right.runCount - left.runCount;
    if (left.modelId !== right.modelId) return left.modelId.localeCompare(right.modelId);
    return left.thinkingLevel.localeCompare(right.thinkingLevel);
  });

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
    weights: WEIGHTS,
    minimumScoredRuns: MINIMUM_SCORED_RUNS,
    notes: [
      'Composite scores use conservative lower bounds of 95% confidence intervals, then apply a sample-size reliability penalty (scoredRunCount / 10, max 1.0).',
      'Models with 10+ scored runs receive full composite weight; fewer runs are penalized proportionally (e.g., 5 runs → 0.5 factor).',
      'All dimensions (including firstAttemptSuccess, toolReliability, verificationAdoption, and tokenEfficiency) use only scored runs for consistent population.',
      'Token efficiency (output tokens per mutation line) is a scoring dimension weighted at 0.05; lower values (fewer tokens per line = more efficient) score higher via inverted normalization (1 - value/50).',
      'Models with fewer than 3 scored runs are shown but unranked (null composite and rank).',
      'Subagent context shows co-occurrence; subagent model attribution requires pipeline enhancement.',
    ],
  };
}
