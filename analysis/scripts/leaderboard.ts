import {
  SITE_DATA_SCHEMA_VERSION,
  type PreparedAnalyticsData,
  type PreparedRunRow,
  type ModelLeaderboardData,
  type ModelLeaderboardRow,
  type ModelLeaderboardProviderBreakdown,
  type LeaderboardDimension,
} from './contracts.ts';
import {
  LEADERBOARD_MINIMUM_SCORED_RUNS as MINIMUM_SCORED_RUNS,
  LEADERBOARD_SHRINKAGE_K as SHRINKAGE_K,
  LEADERBOARD_TOKEN_EFFICIENCY_MAX as TOKEN_EFFICIENCY_MAX,
  LEADERBOARD_WEIGHTS as WEIGHTS,
  LEADERBOARD_OUTCOME_EXPONENT as OUTCOME_EXPONENT,
  LEADERBOARD_MASTERY_COMPLEXITY_WEIGHT as MASTERY_COMPLEXITY_WEIGHT,
} from './leaderboard-scoring.ts';
import {
  computeComplexityScores,
  complexityWeightedMean,
  hasComplexityVariance,
} from './complexity-scoring.ts';

type DimensionKey =
  | 'satisfaction'
  | 'resolutionRate'
  | 'fileChurn'
  | 'toolReliability'
  | 'verificationPassRate'
  | 'tokenEfficiency';

const DIMENSION_KEYS: DimensionKey[] = [
  'satisfaction',
  'resolutionRate',
  'fileChurn',
  'toolReliability',
  'verificationPassRate',
  'tokenEfficiency',
];

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
function meanOf(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
  return { value, lowerBound: wilsonLower(successes, total), shrunk: null, n: total };
}
function resolutionScore(resolution: PreparedRunRow['resolution']): number {
  if (resolution === 'resolved') return 1;
  if (resolution === 'partially_resolved') return 0.5;
  return 0;
}
/**
 * Empirical-Bayes shrinkage toward a grand mean: shrinks a group's observed estimate toward the
 * population prior by the data fraction n/(n+k). For large n this converges to the observed
 * estimate; for small n extreme estimates are pulled toward the average, curbing cherry-picking
 * without a harsh multiplicative penalty.
 */
function shrink(observed: number, n: number, grandMean: number): number {
  return (n * observed + SHRINKAGE_K * grandMean) / (n + SHRINKAGE_K);
}
function rankRows(rows: ModelLeaderboardRow[]): void {
  const ranked = rows.filter((row) => row.compositeScore !== null).sort((a, b) => {
    const byScore = (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
    if (byScore !== 0) return byScore;
    // Tie-break mirrors the dashboard: more scored runs, then more total runs, then stable ids.
    if (b.scoredRunCount !== a.scoredRunCount) return b.scoredRunCount - a.scoredRunCount;
    if (b.runCount !== a.runCount) return b.runCount - a.runCount;
    if (a.modelId !== b.modelId) return a.modelId.localeCompare(b.modelId);
    return a.thinkingLevel.localeCompare(b.thinkingLevel);
  });
  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });
}

interface ComplexityOutcomePair {
  complexity: number;
  outcome: number;
}

interface GroupEstimate {
  modelId: string;
  thinkingLevel: string;
  runCount: number;
  scoredRunCount: number;
  subagentRunCount: number;
  subagentUsageRate: number | null;
  avgSubagentTasksPerRun: number | null;
  medianDurationMs: number | null;
  medianTokenEfficiency: number | null;
  medianCostUsd: number | null;
  meanTaskComplexity: number | null;
  /** Observed normalized point estimate per dimension in [0,1] (null when the group has no data).
   *  For difficulty-emphasized (outcome) dims this is the blended mastery estimate
   *  ((1-W)×rawRate + W×mean(complexity × outcome^EXPONENT)); for the raw process dims it is the
   *  unweighted rate/median. */
  observed: Record<DimensionKey, number | null>;
  /** Sample size per dimension. */
  n: Record<DimensionKey, number>;
  /** Display values: native-scale point estimate, 95% CI lower bound, and sample size per dimension. */
  dimensions: Record<DimensionKey, LeaderboardDimension>;
  /** Provider-specific entries collapsed into this provider-agnostic row. */
  providers: ModelLeaderboardProviderBreakdown[];
}

/**
 * Builds model leaderboard rows ranked by expected strength on the hardest work, gated by actual
 * success: a weighted composite of empirical-Bayes shrunk point estimates whose outcome
 * dimensions are blended mastery (raw success + complexity-weighted) so actual success dominates
 * task complexity while still rewarding completion of the most complex tasks. Cost is surfaced
 * separately and is not part of the composite.
 */
export function createModelLeaderboard(prepared: PreparedAnalyticsData): ModelLeaderboardData {
  const completedRuns = prepared.runs.filter((run) => run.status !== 'open');
  const grouped = new Map<string, PreparedRunRow[]>();
  for (const run of completedRuns) {
    // Group by canonical model family (provider-agnostic), not the provider-specific modelId.
    // `modelFamily` is resolved at prepare time from models.json's optional `family` field; runs
    // whose model isn't in the registry fall back to their own modelId (kept distinct).
    const family = run.modelFamily ?? normalizeModelId(run.modelId);
    const key = `${family}::${normalizeThinkingLevel(run.thinkingLevel)}`;
    const existing = grouped.get(key) ?? [];
    existing.push(run);
    grouped.set(key, existing);
  }

  // Pass 0: per-run complexity scores over the scored-run population. The outcome dimensions are
  // blended mastery ((1-W)×rawSuccessRate + W×mean(complexity × outcome^EXPONENT)) so actual success
  // dominates task complexity while still rewarding completion of the hardest tasks — the opposite
  // of the prior residual-control adjustment, which neutralized task difficulty.
  const allScoredRuns = completedRuns.filter((run) => run.scored && run.satisfaction !== null);
  const complexityScores = computeComplexityScores(allScoredRuns);
  const complexityOf = (run: PreparedRunRow): number => complexityScores.get(run.runId) ?? 0.5;
  const difficultyEmphasized = hasComplexityVariance(allScoredRuns.map((run) => complexityOf(run)));

  // Pass 1: per-group observed estimates (blended mastery for outcome dims, raw for
  // process dims), native-scale display values, CI lower bounds, per-run (complexity, outcome)
  // pairs, and mean task complexity.
  const estimates: GroupEstimate[] = [...grouped.entries()].map(([key, runs]) => {
    const [modelId, thinkingLevel] = key.split('::');
    const scoredRuns = runs.filter((run) => run.scored && run.satisfaction !== null);
    const scoredN = scoredRuns.length;

    // Provider breakdown: which provider-specific model ids collapsed into this provider-agnostic
    // family row. The backend stores each run's modelId distinctly; this surfaces the collapse so
    // provider differences stay investigable (e.g. Umans vs Ollama Cloud for the same GLM 5.2).
    const providersByModelId = new Map<string, { runCount: number; scoredRunCount: number }>();
    for (const run of runs) {
      const providerModelId = normalizeModelId(run.modelId);
      const entry = providersByModelId.get(providerModelId) ?? { runCount: 0, scoredRunCount: 0 };
      entry.runCount += 1;
      if (run.scored && run.satisfaction !== null) entry.scoredRunCount += 1;
      providersByModelId.set(providerModelId, entry);
    }
    const providers: ModelLeaderboardProviderBreakdown[] = [...providersByModelId.entries()]
      .map(([providerModelId, counts]) => ({ modelId: providerModelId, runCount: counts.runCount, scoredRunCount: counts.scoredRunCount }))
      .sort((a, b) => b.runCount - a.runCount || a.modelId.localeCompare(b.modelId));

    const satisfactionValues = scoredRuns.map((run) => run.satisfaction!);
    const resolutionValues = scoredRuns.map((run) => resolutionScore(run.resolution));
    const satMean = satisfactionValues.length > 0 ? meanOf(satisfactionValues) : null;
    const resMean = resolutionValues.length > 0 ? meanOf(resolutionValues) : null;

    const toolSuccesses = scoredRuns.filter((run) => run.toolFailureCount === 0).length;
    const verifyingRuns = scoredRuns.filter((run) => run.verificationTotalCount > 0);
    const verPassSuccesses = verifyingRuns.filter((run) => run.verificationState === 'passing').length;

    const tokenEfficiencyValues = scoredRuns.map((run) => run.tokenEfficiency).filter((value): value is number => value !== null);
    const tokenEfficiencyMedian = median(tokenEfficiencyValues, 3);
    const tokenEfficiencyClamped = tokenEfficiencyMedian !== null ? clamp(tokenEfficiencyMedian, 0, TOKEN_EFFICIENCY_MAX) : null;

    // File churn: re-edit rate per run (fraction of edits that revisited an already-edited file).
    // Lower = less churn = better; inverted for the composite so higher = better. Null for runs with
    // no attributable edits (incl. legacy runs captured before per-file tracking). Aggregated by MEAN
    // (not median) because churn is a long-tail signal — most runs don't churn, so a median would
    // collapse to 0 and hide models whose few runs churn badly.
    const fileChurnValues = scoredRuns.map((run) => run.editRevisitRate).filter((value): value is number => value !== null);
    const fileChurnMean = fileChurnValues.length > 0 ? meanOf(fileChurnValues) : null;

    const satisfaction: LeaderboardDimension = {
      value: satMean !== null ? round(satMean, 2) : null,
      lowerBound: meanLower(satisfactionValues, 1, 5),
      shrunk: null,
      n: scoredN,
    };
    const resolutionRate: LeaderboardDimension = {
      value: resMean !== null ? round(clamp(resMean, 0, 1), 3) : null,
      lowerBound: meanLower(resolutionValues, 0, 1),
      shrunk: null,
      n: scoredN,
    };
    const toolReliability = proportionDimension(toolSuccesses, scoredN);
    const verificationPassRate = proportionDimension(verPassSuccesses, verifyingRuns.length);
    const tokenEfficiency: LeaderboardDimension = {
      value: tokenEfficiencyClamped !== null ? round(tokenEfficiencyClamped, 3) : null,
      lowerBound: meanLower(tokenEfficiencyValues, 0, TOKEN_EFFICIENCY_MAX),
      shrunk: null,
      n: tokenEfficiencyValues.length,
    };
    // fileChurn native value = mean re-edit rate (0 = no churn, 1 = max churn). lowerBound on the
    // same native scale; shrunk/inverted handled in observed below.
    const fileChurn: LeaderboardDimension = {
      value: fileChurnMean !== null ? round(fileChurnMean, 3) : null,
      lowerBound: meanLower(fileChurnValues, 0, 1),
      shrunk: null,
      n: fileChurnValues.length,
    };

    // Per-run (complexity, outcome) pairs for the complexity-weighted dimensions. The four
    // outcome/process dimensions (satisfaction, resolution, verification pass, tool reliability)
    // are mastery-weighted; token efficiency and file churn stay raw (process metrics, not
    // "completing complex tasks").
    const pairs: Record<DimensionKey, ComplexityOutcomePair[]> = {
      satisfaction: scoredRuns.map((run) => ({ complexity: complexityOf(run), outcome: clamp((run.satisfaction! - 1) / 4, 0, 1) })),
      resolutionRate: scoredRuns.map((run) => ({ complexity: complexityOf(run), outcome: resolutionScore(run.resolution) })),
      fileChurn: [],
      verificationPassRate: verifyingRuns.map((run) => ({ complexity: complexityOf(run), outcome: run.verificationState === 'passing' ? 1 : 0 })),
      toolReliability: scoredRuns.map((run) => ({ complexity: complexityOf(run), outcome: run.toolFailureCount === 0 ? 1 : 0 })),
      tokenEfficiency: [],
    };

    // Blended mastery = (1-W)×rawSuccessRate + W×mean(complexity × outcome^OUTCOME_EXPONENT). The raw
    // success component makes actual success matter directly on every dimension (including 0/1 outcome
    // dims where the exponent is a no-op); the complexity-weighted component rewards completing the
    // hardest tasks. Together, actual success dominates task complexity — a mediocre performer on
    // very-hard tasks cannot ride its complexity past a strong consistent performer on medium-hard
    // tasks. Token efficiency (median tok/line) and file churn (re-edit rate) stay raw.
    const masteryOf = (rawRate: number | null, p: ComplexityOutcomePair[]): number | null => {
      if (rawRate === null) return null;
      const cwm = complexityWeightedMean(p, OUTCOME_EXPONENT);
      if (cwm === null) return null;
      return clamp((1 - MASTERY_COMPLEXITY_WEIGHT) * rawRate + MASTERY_COMPLEXITY_WEIGHT * cwm, 0, 1);
    };

    const observed: Record<DimensionKey, number | null> = {
      satisfaction: masteryOf(satMean !== null ? clamp((satMean - 1) / 4, 0, 1) : null, pairs.satisfaction),
      resolutionRate: masteryOf(resMean, pairs.resolutionRate),
      fileChurn: fileChurnMean !== null ? clamp(1 - fileChurnMean, 0, 1) : null,
      toolReliability: masteryOf(scoredN > 0 ? toolSuccesses / scoredN : null, pairs.toolReliability),
      verificationPassRate: masteryOf(verifyingRuns.length > 0 ? verPassSuccesses / verifyingRuns.length : null, pairs.verificationPassRate),
      tokenEfficiency: tokenEfficiencyClamped !== null ? clamp(1 - tokenEfficiencyClamped / TOKEN_EFFICIENCY_MAX, 0, 1) : null,
    };
    const n: Record<DimensionKey, number> = {
      satisfaction: scoredN,
      resolutionRate: scoredN,
      fileChurn: fileChurnValues.length,
      toolReliability: scoredN,
      verificationPassRate: verifyingRuns.length,
      tokenEfficiency: tokenEfficiencyValues.length,
    };

    const subagentRuns = runs.filter((run) => run.subagentCallCount > 0);
    const costValues = runs.map((run) => run.estimatedCostUsd).filter((value): value is number => value !== null && Number.isFinite(value));
    const meanTaskComplexity = scoredN > 0 ? round(meanOf(scoredRuns.map((run) => complexityOf(run))), 4) : null;

    return {
      modelId: modelId ?? '(unknown)',
      thinkingLevel: thinkingLevel ?? '(unspecified)',
      runCount: runs.length,
      scoredRunCount: scoredN,
      subagentRunCount: subagentRuns.length,
      subagentUsageRate: runs.length === 0 ? null : round(clamp(subagentRuns.length / runs.length, 0, 1), 3),
      avgSubagentTasksPerRun: average(subagentRuns.map((run) => run.subagentTaskCount), 2),
      medianDurationMs: median(runs.map((run) => run.busyDurationMs), 0),
      medianTokenEfficiency: median(runs.map((run) => run.tokenEfficiency).filter((value): value is number => value !== null), 3),
      medianCostUsd: costValues.length > 0 ? round(median(costValues, 4) ?? 0, 4) : null,
      meanTaskComplexity,
      observed,
      n,
      dimensions: { satisfaction, resolutionRate, fileChurn, toolReliability, verificationPassRate, tokenEfficiency },
      providers,
    };
  });

  // Pass 2: grand mean per dimension = mean of the groups' observed estimates (the EB prior and the
  // shrinkage target). For outcome dims this is the mean mastery across models; for process dims the
  // mean raw rate.
  const grandMean: Record<DimensionKey, number | null> = {} as Record<DimensionKey, number | null>;
  for (const dim of DIMENSION_KEYS) {
    const values = estimates.map((e) => e.observed[dim]).filter((value): value is number => value !== null);
    grandMean[dim] = values.length > 0 ? meanOf(values) : null;
  }

  // Pass 3: shrink each estimate toward the grand mean and assemble rows.
  const rows: ModelLeaderboardRow[] = estimates.map((e) => {
    let compositeScore: number | null = null;
    let reliabilityFactor: number | null = null;
    const shrunkDimensions = { ...e.dimensions } as Record<DimensionKey, LeaderboardDimension>;

    if (e.scoredRunCount >= MINIMUM_SCORED_RUNS) {
      let rawComposite = 0;
      for (const dim of DIMENSION_KEYS) {
        const obs = e.observed[dim];
        const gm = grandMean[dim];
        if (obs === null || gm === null) continue;
        const shrunkValue = clamp(shrink(obs, e.n[dim], gm), 0, 1);
        shrunkDimensions[dim] = { ...shrunkDimensions[dim]!, shrunk: round(shrunkValue, 4) };
        rawComposite += WEIGHTS[dim] * shrunkValue;
      }
      reliabilityFactor = round(clamp(e.scoredRunCount / (e.scoredRunCount + SHRINKAGE_K), 0, 1), 4);
      compositeScore = round(rawComposite, 4);
    }

    return {
      modelId: e.modelId,
      thinkingLevel: e.thinkingLevel,
      runCount: e.runCount,
      scoredRunCount: e.scoredRunCount,
      compositeScore,
      rank: null,
      reliabilityFactor,
      dimensions: {
        satisfaction: shrunkDimensions.satisfaction!,
        resolutionRate: shrunkDimensions.resolutionRate!,
        fileChurn: shrunkDimensions.fileChurn!,
        toolReliability: shrunkDimensions.toolReliability!,
        verificationPassRate: shrunkDimensions.verificationPassRate!,
        tokenEfficiency: shrunkDimensions.tokenEfficiency!,
      },
      medianCostUsd: e.medianCostUsd,
      meanTaskComplexity: e.meanTaskComplexity,
      difficultyEmphasized,
      subagentRunCount: e.subagentRunCount,
      subagentUsageRate: e.subagentUsageRate,
      avgSubagentTasksPerRun: e.avgSubagentTasksPerRun,
      medianDurationMs: e.medianDurationMs,
      medianTokenEfficiency: e.medianTokenEfficiency,
      providers: e.providers,
    };
  });

  rankRows(rows);
  rows.sort((left, right) => {
    if (left.rank === null && right.rank !== null) return 1;
    if (left.rank !== null && right.rank === null) return -1;
    if (left.rank !== null && right.rank !== null && left.rank !== right.rank) return left.rank - right.rank;
    if ((right.compositeScore ?? -1) !== (left.compositeScore ?? -1)) return (right.compositeScore ?? -1) - (left.compositeScore ?? -1);
    if (right.scoredRunCount !== left.scoredRunCount) return right.scoredRunCount - left.scoredRunCount;
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
      `Rows are provider-agnostic: runs are grouped by canonical model family (e.g. 'glm-5.2'), not the provider-specific modelId. The same underlying model offered by multiple providers (e.g. 'umans-glm-5.2' via Umans and 'glm-5.2:cloud' via Ollama Cloud) collapses into a single row. Families are declared via the optional 'family' field in models.json; models without a family default to their own id (kept distinct). The backend still stores each run's provider-specific modelId distinctly, and each row exposes a 'providers' breakdown (provider-specific ids + run counts) so provider differences stay investigable.`,
      `Composite ranks by expected strength on the hardest work, gated by actual success: a weighted sum of empirical-Bayes shrunk point estimates (prior strength k=${SHRINKAGE_K}). Four non-efficiency dimensions (satisfaction, resolution, verification pass, tool reliability) use blended mastery = ${(1 - MASTERY_COMPLEXITY_WEIGHT).toFixed(1)}×rawSuccessRate + ${MASTERY_COMPLEXITY_WEIGHT}×mean(complexity × outcome^${OUTCOME_EXPONENT}). The raw-success component makes actual success matter directly on every dimension — including the 0/1 outcome dims (verification, tool reliability) where the outcome exponent alone is a no-op (0^p=0, 1^p=1). The complexity-weighted component rewards completing the hardest tasks. Together, actual success dominates task complexity: a mediocre performer on very-hard tasks cannot ride its complexity past a strong consistent performer on medium-hard tasks, while a model that completes complex tasks still rises above one that only completes easy ones. fileChurn and tokenEfficiency are raw process metrics (not mastery-weighted): fileChurn penalizes rework — repeatedly re-editing the same files, the clearest signal the agent kept getting it wrong — and replaces the former "first-attempt success" dimension, which rewarded trivial 1-prompt sessions and penalized great long-running planning sessions.`,
      `Estimates are shrunk toward each dimension's cross-model grand mean by the data fraction n/(n+k), curbing small-sample cherry-picking without a harsh multiplicative penalty. Small-sample rows (few scored runs) are therefore pulled toward the population mean regardless of how hard their tasks were.`,
      `Task complexity is a per-run 0–1 score from 6 signals (line mutations, touched files, tool calls, busy duration, verification count, input tokens). When the scored population has no complexity variance, mastery collapses to a uniform rescaling of raw outcomes (no genuine difficulty emphasis); difficultyEmphasized flags whether variance was present.`,
      `reliabilityFactor reports sample confidence = scoredRunCount / (scoredRunCount + ${SHRINKAGE_K}); it is a display-only indicator and is NOT applied to the composite.`,
      `meanTaskComplexity reports each model's average task difficulty (0=easy, 1=hard) for transparency ("strength of schedule"); it is not part of the composite. difficultyEmphasized flags whether the composite was complexity-weighted for this row.`,
      `Dimensions: satisfaction (1–5 → 0–1), resolution rate, file churn (1 − mean re-edit rate; less churn = higher score), tool reliability (share of runs with zero tool failures), verification pass rate (share of verifying runs whose checks pass — not mere adoption), and token efficiency (1 − median tok/line ÷ ${TOKEN_EFFICIENCY_MAX}). The first four use blended mastery (${(1 - MASTERY_COMPLEXITY_WEIGHT).toFixed(1)}×raw rate + ${MASTERY_COMPLEXITY_WEIGHT}×complexity-weighted, outcome^${OUTCOME_EXPONENT}); file churn and token efficiency use raw metrics (process quality, not task completion).`,
      `Each dimension exposes value (observed point estimate on its native scale), lowerBound (95% CI lower bound, an uncertainty indicator — not used for ranking), shrunk (empirical-Bayes estimate used in the composite; blended mastery for the first four dims, raw for file churn and token efficiency), and n.`,
      `fileChurn measures rework: for each run the fraction of EDIT operations that revisited an already-edited file (0 = every edit touched a fresh file; →1 = kept re-editing the same files), derived from a per-file edit-count map captured at the tool-call level. It is aggregated by MEAN across a model's runs (churn is a long-tail signal — most runs don't churn, so a median would hide the few that do) and inverted so higher = less churn = better. Runs captured before per-file edit tracking existed (or with no attributable edits) have null churn and are excluded from this dimension, so it activates as new runs accumulate; firstAttemptSuccess remains on each run for the interruptions chart but is no longer part of the composite.`,
      `Models with fewer than ${MINIMUM_SCORED_RUNS} scored runs are shown but unranked (null composite and rank).`,
      `medianCostUsd surfaces per-run cost separately; cost is not part of the composite so rank #1 reflects strength, not cheapness.`,
      'Subagent context shows co-occurrence; subagent model attribution requires pipeline enhancement.',
    ],
  };
}
