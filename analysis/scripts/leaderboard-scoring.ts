/**
 * Shared leaderboard scoring constants used by both the Node-side generator and the browser dashboard.
 * Keep this module dependency-free so both build targets can import it safely.
 *
 * Ranking philosophy: "expected strength". The composite uses **point estimates** of each
 * dimension (observed means / rates), not conservative confidence-bound lower bounds, so rank #1
 * is the model that performs best in aggregate. Small-sample cherry-picking is curbed by mild
 * empirical-Bayes shrinkage toward the cross-model grand mean (prior strength SHRINKAGE_K), not by
 * a harsh multiplicative penalty. The reliabilityFactor reported per row is the sample confidence
 * n/(n+SHRINKAGE_K) — a display-only indicator of how much data backs the estimate, never a score
 * multiplier. Cost is surfaced separately (medianCostUsd) and is NOT part of the composite.
 */
export const LEADERBOARD_MINIMUM_SCORED_RUNS = 3;

/** Empirical-Bayes prior strength. Larger = stronger pull toward the grand mean for small samples. */
export const LEADERBOARD_SHRINKAGE_K = 4;

export const LEADERBOARD_TOKEN_EFFICIENCY_MAX = 50;
export const LEADERBOARD_WEIGHTS = {
  satisfaction: 0.35,
  resolutionRate: 0.30,
  firstAttemptSuccess: 0.15,
  toolReliability: 0.10,
  verificationPassRate: 0.05,
  tokenEfficiency: 0.05,
} as const;
