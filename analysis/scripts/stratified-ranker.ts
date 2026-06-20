/**
 * Stratified leaderboard for subagent model selection (v2).
 *
 * Computes on-demand from the analytics data store:
 *   1. Per-run complexity scores (6 heuristics, percentile-normalized)
 *   2. Splits runs into complexity terciles (low / medium / high)
 *   3. Computes outcome scores per model per band (point estimates)
 *   4. Two-stage ranking: quality composite → cost within quality tiers
 *   5. Assigns models to buckets (small / medium / frontier)
 *
 * Used by the subagent extension via bridge.ts. The existing global
 * leaderboard (leaderboard.ts) is unchanged.
 */

import {
  type PreparedAnalyticsData,
  type PreparedRunRow,
} from "./contracts.ts";
import { prepareSourceAnalytics } from "./prepare.ts";
import { loadSourceAnalytics } from "./source.ts";

// --- Types ---

/** Simplified model config entry (from model-profiles.yaml v2 schema). */
export interface SimpleModelConfig {
  id: string;
  eligible: boolean;
  thinking: ThinkingLevel[];
  disabled_reason: string | null;
  cost: number;
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface BucketAssignments {
  small: string[];
  medium: string[];
  frontier: string[];
}

// --- Constants ---

/** Minimum scored runs before the ranker returns non-empty assignments. */
export const BOOTSTRAP_MIN_RUNS = 40;

/** Token efficiency cap (matches leaderboard-scoring.ts). */
const TOKEN_EFFICIENCY_MAX = 50;

/** Number of complexity bands (terciles). */
const BAND_COUNT = 3;

const BAND_NAMES = ["low", "medium", "high"] as const;
type BandName = (typeof BAND_NAMES)[number];

/** Bucket each band maps to. */
const BAND_TO_BUCKET: Record<BandName, keyof BucketAssignments> = {
  low: "small",
  medium: "medium",
  high: "frontier",
};

// --- Complexity scoring (shared via complexity-scoring.ts) ---
// The primitives live in complexity-scoring.ts so the global leaderboard and the
// dashboard use the exact same complexity definition. Re-exported here for the
// subagent bucket path and its tests.

import { computeComplexityScores } from './complexity-scoring.ts';

export { computeComplexityScores, extractSignals, percentileRanks } from './complexity-scoring.ts';
export type { ComplexitySignals } from './complexity-scoring.ts';

// --- Band assignment ---

export interface BandAssignment {
  band: BandName;
  runs: PreparedRunRow[];
}

export function assignBands(
  runs: PreparedRunRow[],
  complexityScores: Map<string, number>,
): BandAssignment[] {
  const scored = runs
    .filter((r) => r.scored)
    .map((r) => ({ run: r, score: complexityScores.get(r.runId) ?? 0 }));

  if (scored.length === 0) {
    return BAND_NAMES.map((band) => ({ band, runs: [] }));
  }

  // Sort by complexity score ascending
  scored.sort((a, b) => a.score - b.score);

  const bandSize = Math.ceil(scored.length / BAND_COUNT);
  const bands: BandAssignment[] = [];

  for (let b = 0; b < BAND_COUNT; b++) {
    const start = b * bandSize;
    const end = Math.min(start + bandSize, scored.length);
    bands.push({
      band: BAND_NAMES[b],
      runs: scored.slice(start, end).map((s) => s.run),
    });
  }

  return bands;
}

// --- Outcome scoring ---

function resolutionScore(resolution: PreparedRunRow["resolution"]): number {
  if (resolution === "resolved") return 1;
  if (resolution === "partially_resolved") return 0.5;
  return 0;
}

export interface ModelOutcomeScores {
  modelId: string;
  runCount: number;
  satisfaction: number; // 1–5 mean
  resolutionRate: number; // 0–1 mean
  firstAttemptSuccess: number; // 0–1 proportion
  toolReliability: number; // 0–1 proportion
  verificationAdoption: number; // 0–1 proportion
  tokenEfficiency: number; // median, inverted (0–1, higher = better)
  compositeScore: number; // 0–1 quality composite
}

export function computeOutcomeScores(
  modelRuns: PreparedRunRow[],
): ModelOutcomeScores | null {
  const scored = modelRuns.filter(
    (r) => r.scored && r.satisfaction !== null,
  );
  if (scored.length === 0) return null;

  const modelId = scored[0].modelId ?? "(unknown)";

  // Satisfaction (1–5 mean)
  const satisfactionValues = scored.map((r) => r.satisfaction!);
  const satisfaction =
    satisfactionValues.reduce((a, b) => a + b, 0) / satisfactionValues.length;

  // Resolution rate (0–1 mean)
  const resolutionValues = scored.map((r) => resolutionScore(r.resolution));
  const resolutionRate =
    resolutionValues.reduce((a, b) => a + b, 0) / resolutionValues.length;

  // First-attempt success (0–1 proportion)
  const firstAttemptSuccess =
    scored.filter((r) => r.firstAttemptSuccess).length / scored.length;

  // Tool reliability (0–1 proportion)
  const toolReliability =
    scored.filter((r) => r.toolFailureCount === 0).length / scored.length;

  // Verification adoption (0–1 proportion)
  const verificationAdoption =
    scored.filter((r) => r.verificationTotalCount > 0).length / scored.length;

  // Token efficiency (median, inverted)
  const tokenEfficiencyValues = scored
    .map((r) => r.tokenEfficiency)
    .filter((v): v is number => v !== null);
  const sorted = [...tokenEfficiencyValues].sort((a, b) => a - b);
  const median =
    sorted.length > 0
      ? sorted[Math.floor(sorted.length / 2)]
      : TOKEN_EFFICIENCY_MAX;
  // Invert: lower tokens-per-line = better efficiency
  const tokenEfficiencyNorm = 1 - Math.min(median, TOKEN_EFFICIENCY_MAX) / TOKEN_EFFICIENCY_MAX;

  // Quality composite (6 dimensions, equal weights)
  const compositeScore =
    ((satisfaction - 1) / 4) * (1 / 6) + // normalize 1–5 → 0–1
    resolutionRate * (1 / 6) +
    firstAttemptSuccess * (1 / 6) +
    toolReliability * (1 / 6) +
    verificationAdoption * (1 / 6) +
    tokenEfficiencyNorm * (1 / 6);

  return {
    modelId,
    runCount: scored.length,
    satisfaction,
    resolutionRate,
    firstAttemptSuccess,
    toolReliability,
    verificationAdoption,
    tokenEfficiency: tokenEfficiencyNorm,
    compositeScore,
  };
}

// --- Two-stage ranking ---

interface RankedModelEntry {
  modelId: string;
  compositeScore: number;
  cost: number;
}

export function rankModelsInBand(
  outcomes: ModelOutcomeScores[],
  modelConfig: SimpleModelConfig[],
): string[] {
  // Build cost lookup from model config
  const costMap = new Map<string, number>();
  for (const cfg of modelConfig) {
    costMap.set(cfg.id, cfg.cost);
  }

  // Create entries with cost
  const entries: RankedModelEntry[] = outcomes.map((o) => ({
    modelId: o.modelId,
    compositeScore: o.compositeScore,
    cost: costMap.get(o.modelId) ?? 10, // default cost if unknown
  }));

  // Stage 1: sort by quality composite descending
  entries.sort((a, b) => b.compositeScore - a.compositeScore);

  // Stage 2: within top half and bottom half, re-rank by cost (ascending)
  const mid = Math.ceil(entries.length / 2);
  const topHalf = entries.slice(0, mid);
  const bottomHalf = entries.slice(mid);

  topHalf.sort((a, b) => a.cost - b.cost);
  bottomHalf.sort((a, b) => a.cost - b.cost);

  return [...topHalf, ...bottomHalf].map((e) => e.modelId);
}

// --- Bucket assignment ---

interface ModelBandResult {
  modelId: string;
  band: BandName;
  compositeScore: number;
}

export function assignModelsToBuckets(
  bands: BandAssignment[],
  modelConfig: SimpleModelConfig[],
): BucketAssignments {
  // Collect all model-band outcomes
  const allResults: ModelBandResult[] = [];

  for (const band of bands) {
    // Group runs by model
    const byModel = new Map<string, PreparedRunRow[]>();
    for (const run of band.runs) {
      const mid = run.modelId ?? "(unknown)";
      if (!byModel.has(mid)) byModel.set(mid, []);
      byModel.get(mid)!.push(run);
    }

    for (const [modelId, runs] of byModel) {
      const outcomes = computeOutcomeScores(runs);
      if (outcomes) {
        allResults.push({
          modelId,
          band: band.band,
          compositeScore: outcomes.compositeScore,
        });
      }
    }
  }

  // Each model appears in only its best band (highest composite score)
  const bestBand = new Map<string, { band: BandName; score: number }>();
  for (const r of allResults) {
    const existing = bestBand.get(r.modelId);
    if (!existing || r.compositeScore > existing.score) {
      bestBand.set(r.modelId, { band: r.band, score: r.compositeScore });
    }
  }

  // Group by bucket
  const buckets: BucketAssignments = { small: [], medium: [], frontier: [] };
  const bucketEntries = new Map<keyof BucketAssignments, ModelOutcomeScores[]>();

  for (const band of bands) {
    const byModel = new Map<string, PreparedRunRow[]>();
    for (const run of band.runs) {
      const mid = run.modelId ?? "(unknown)";
      if (!byModel.has(mid)) byModel.set(mid, []);
      byModel.get(mid)!.push(run);
    }

    for (const [modelId, runs] of byModel) {
      const best = bestBand.get(modelId);
      if (!best || best.band !== band.band) continue;

      const outcomes = computeOutcomeScores(runs);
      if (!outcomes) continue;

      const bucket = BAND_TO_BUCKET[band.band];
      if (!bucketEntries.has(bucket)) bucketEntries.set(bucket, []);
      bucketEntries.get(bucket)!.push(outcomes);
    }
  }

  // Rank within each bucket
  for (const [bucket, outcomes] of bucketEntries) {
    buckets[bucket] = rankModelsInBand(outcomes, modelConfig);
  }

  return buckets;
}

// --- Eligibility filter ---

/**
 * Filter bucket assignments to only include eligible models.
 * Models with `eligible: false` in config are removed.
 * Models in analytics data but not in config are included (with warning).
 */
export function filterEligible(
  buckets: BucketAssignments,
  modelConfig: SimpleModelConfig[],
): BucketAssignments {
  const eligibleSet = new Set(
    modelConfig.filter((c) => c.eligible).map((c) => c.id),
  );
  // Also include models in analytics but not in config (treated as eligible)
  const configIds = new Set(modelConfig.map((c) => c.id));
  const allBucketIds = new Set([
    ...buckets.small,
    ...buckets.medium,
    ...buckets.frontier,
  ]);
  for (const id of allBucketIds) {
    if (!configIds.has(id)) {
      // Model in data but not in config — include with warning
      eligibleSet.add(id);
    }
  }

  return {
    small: buckets.small.filter((id) => eligibleSet.has(id)),
    medium: buckets.medium.filter((id) => eligibleSet.has(id)),
    frontier: buckets.frontier.filter((id) => eligibleSet.has(id)),
  };
}

// --- Public API ---

/**
 * Compute bucket assignments from the analytics data store.
 *
 * @param analyticsDir - Path to the analytics data directory (containing exports/ or JSONL files)
 * @param modelConfig - Simple model config entries from model-profiles.yaml
 * @returns Bucket assignments (empty if < 40 scored runs exist)
 */
export async function computeBucketAssignments(
  analyticsDir: string,
  modelConfig: SimpleModelConfig[],
): Promise<BucketAssignments> {
  // Load analytics data
  let prepared: PreparedAnalyticsData;
  try {
    const loaded = await loadSourceAnalytics({ storageDir: analyticsDir });
    prepared = prepareSourceAnalytics(loaded.source);
  } catch {
    // If loading fails, return empty assignments (fallback to active model)
    return { small: [], medium: [], frontier: [] };
  }

  const scoredRuns = prepared.runs.filter((r) => r.scored);

  // Bootstrap gate: need at least 40 scored runs
  if (scoredRuns.length < BOOTSTRAP_MIN_RUNS) {
    return { small: [], medium: [], frontier: [] };
  }

  // 1. Compute complexity scores
  const complexityScores = computeComplexityScores(prepared.runs);

  // 2. Split into terciles
  const bands = assignBands(prepared.runs, complexityScores);

  // 3-5. Compute outcomes, rank, assign to buckets
  const buckets = assignModelsToBuckets(bands, modelConfig);

  // Filter by eligibility
  return filterEligible(buckets, modelConfig);
}
