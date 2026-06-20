/**
 * Shared leaderboard scoring constants used by both the Node-side generator and the browser dashboard.
 * Keep this module dependency-free so both build targets can import it safely.
 *
 * Ranking philosophy: "expected strength on the hardest work". The composite uses **point estimates**
 * of each dimension (observed means / rates), not conservative confidence-bound lower bounds, so
 * rank #1 is the model that performs best in aggregate. The outcome dimensions are **complexity-weighted
 * mastery** estimates: each scored run contributes `complexity × outcome` to the dimension mean, so
 * success on the most complex tasks dominates the score. A model that only completes easy tasks cannot
 * reach the top (its easy-task successes are complexity-down-weighted); a model that completes complex
 * tasks rises. This *emphasizes* task difficulty rather than neutralizing it.
 *
 * Small-sample cherry-picking is still curbed by mild empirical-Bayes shrinkage toward the cross-model
 * grand mean (prior strength SHRINKAGE_K), not by a harsh multiplicative penalty. The reliabilityFactor
 * reported per row is the sample confidence n/(n+SHRINKAGE_K) — a display-only indicator of how much
 * data backs the estimate, never a score multiplier. Cost is surfaced separately (medianCostUsd) and
 * is NOT part of the composite.
 */
export const LEADERBOARD_MINIMUM_SCORED_RUNS = 3;

/** Empirical-Bayes prior strength. Larger = stronger pull toward the grand mean for small samples. */
export const LEADERBOARD_SHRINKAGE_K = 4;

export const LEADERBOARD_TOKEN_EFFICIENCY_MAX = 50;

/**
 * Outcome dimensions whose estimates are **complexity-weighted** (mastery) so that completing the
 * hardest tasks dominates the composite. toolReliability and tokenEfficiency are left raw: tool
 * reliability is a process-quality signal and token efficiency is a cost-adjacent efficiency metric,
 * neither of which measures "completing complex tasks".
 */
export const LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS = new Set([
  'satisfaction',
  'resolutionRate',
  'firstAttemptSuccess',
  'verificationPassRate',
]);
export const LEADERBOARD_WEIGHTS = {
  satisfaction: 0.35,
  resolutionRate: 0.30,
  firstAttemptSuccess: 0.15,
  toolReliability: 0.10,
  verificationPassRate: 0.05,
  tokenEfficiency: 0.05,
} as const;
