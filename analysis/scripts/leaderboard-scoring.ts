/**
 * Shared leaderboard scoring constants used by both the Node-side generator and the browser dashboard.
 * Keep this module dependency-free so both build targets can import it safely.
 *
 * Ranking philosophy: "expected strength on the hardest work, gated by actual success". The
 * composite uses **point estimates** of each dimension (observed means / rates), not conservative
 * confidence-bound lower bounds, so rank #1 is the model that performs best in aggregate. The four
 * non-efficiency dimensions are **blended mastery** estimates: `(1-W)×rawSuccessRate + W×mean(complexity ×
 * outcome^OUTCOME_EXPONENT)`. The raw-success component makes actual success matter directly on every
 * dimension (including 0/1 outcome dims where the exponent alone is a no-op); the complexity-weighted
 * component rewards completing the hardest tasks. The outcome exponent (>1) further penalizes partial
 * / low outcomes on the continuous dims. Together this makes actual success dominate task
 * complexity: a mediocre performer on very-hard tasks cannot ride its complexity past a strong
 * consistent performer on medium-hard tasks, while a model that completes complex tasks still rises
 * above one that only completes easy ones. fileChurn (re-edit rate) and tokenEfficiency are raw
 * process metrics, not mastery-weighted.
 *
 * Small-sample cherry-picking is curbed by mild empirical-Bayes shrinkage toward the cross-model
 * grand mean (prior strength SHRINKAGE_K), not a harsh multiplicative penalty. The reliabilityFactor
 * reported per row is the sample confidence n/(n+SHRINKAGE_K) — a display-only indicator of how much
 * data backs the estimate, never a score multiplier. Cost is surfaced separately (medianCostUsd) and
 * is NOT part of the composite.
 */
export const LEADERBOARD_MINIMUM_SCORED_RUNS = 3;

/** Empirical-Bayes prior strength. Larger = stronger pull toward the grand mean for small samples. */
export const LEADERBOARD_SHRINKAGE_K = 4;

export const LEADERBOARD_TOKEN_EFFICIENCY_MAX = 50;

/**
 * Exponent applied to the per-run outcome inside the complexity-weighted mastery estimate
 * (`mean(complexity × outcome^EXPONENT)`). >1 penalizes partial / low outcomes so success dominates
 * task complexity: a model must actually complete the work, not just be assigned it. 1 = raw
 * complexity-weighted mean (success and complexity weighted equally); 2 = quadratic emphasis on
 * success (a 0.5 outcome contributes 0.25, a 1.0 outcome is unchanged).
 */
export const LEADERBOARD_OUTCOME_EXPONENT = 2;

/**
 * Weight on the complexity-weighted term in the mastery blend. The mastery estimate for each
 * dimension is `(1 - W) × rawSuccessRate + W × mean(complexity × outcome^OUTCOME_EXPONENT)`, so the
 * raw success rate carries the remaining `1 - W` weight directly. This makes actual success matter
 * more than task complexity on the mastery-blended dimensions — including the 0/1 outcome dims
 * (verification pass, tool reliability) where the outcome exponent alone is a no-op (0^p=0, 1^p=1).
 * fileChurn and tokenEfficiency are raw process metrics and are NOT mastery-blended.
 * A mediocre performer on very-hard tasks can no longer ride its complexity past a strong consistent
 * performer on medium-hard tasks, while a model that completes complex tasks still rises above one
 * that only completes easy ones. 0.5 = equal weight to raw success and complexity-weighted success.
 */
export const LEADERBOARD_MASTERY_COMPLEXITY_WEIGHT = 0.5;

/**
 * Dimensions whose estimates are complexity-weighted mastery (mean(complexity × outcome^OUTCOME_EXPONENT))
 * so that completing the hardest tasks dominates the composite. Covers the four outcome/process
 * dimensions that measure "completing complex tasks"; tokenEfficiency and fileChurn are deliberately
 * excluded — they are process-quality / cost-adjacent metrics (median tok/line, re-edit rate), not
 * measures of "completing complex tasks", so they stay raw.
 */
export const LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS = new Set([
  'satisfaction',
  'resolutionRate',
  'verificationPassRate',
  'toolReliability',
]);

export const LEADERBOARD_WEIGHTS = {
  satisfaction: 0.35,
  resolutionRate: 0.30,
  fileChurn: 0.15,
  toolReliability: 0.10,
  verificationPassRate: 0.05,
  tokenEfficiency: 0.05,
} as const;
