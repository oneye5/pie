/**
 * Dependency-free task-complexity scoring helpers.
 *
 * Shared by the global leaderboard (`scripts/leaderboard.ts`) and the browser
 * dashboard (`site/app.ts`) so the two implementations cannot drift. The
 * stratified ranker (`stratified-ranker.ts`) re-uses the complexity primitives
 * for subagent bucket selection.
 *
 * Complexity score = mean percentile rank of 6 per-run signals (line mutations,
 * touched files, tool calls, busy duration, verification count, input tokens),
 * giving a 0–1 difficulty per run.
 */
import type { PreparedRunRow } from './contracts.ts';

// --- Complexity primitives (also used by the stratified ranker) ---

export interface ComplexitySignals {
  lineMutations: number;
  touchedFileCount: number;
  toolCallCount: number;
  busyDurationMs: number;
  verificationTotalCount: number;
  inputTokens: number;
}

export function extractSignals(run: PreparedRunRow): ComplexitySignals {
  return {
    lineMutations: run.lineAdditions + run.lineDeletions + run.lineModifications,
    touchedFileCount: run.touchedFileCount,
    toolCallCount: run.toolCallCount,
    busyDurationMs: run.busyDurationMs,
    verificationTotalCount: run.verificationTotalCount,
    inputTokens: run.inputTokens,
  };
}

/**
 * Percentile rank (0–1) of each value against the full population.
 * Returns an array parallel to `values`. Ties use the mid-rank convention
 * `(lt + 0.5·eq) / n`, so identical values share the same rank.
 */
export function percentileRanks(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return values.map(() => 0);

  return values.map((v) => {
    let lt = 0;
    let eq = 0;
    for (const s of sorted) {
      if (s < v) lt++;
      else if (s === v) eq++;
      else break;
    }
    return (lt + 0.5 * eq) / n;
  });
}

export function computeComplexityScores(runs: PreparedRunRow[]): Map<string, number> {
  const signals = runs.map(extractSignals);

  const lineMutationRanks = percentileRanks(signals.map((s) => s.lineMutations));
  const touchedFileRanks = percentileRanks(signals.map((s) => s.touchedFileCount));
  const toolCallRanks = percentileRanks(signals.map((s) => s.toolCallCount));
  const durationRanks = percentileRanks(signals.map((s) => s.busyDurationMs));
  const verificationRanks = percentileRanks(signals.map((s) => s.verificationTotalCount));
  const inputTokenRanks = percentileRanks(signals.map((s) => s.inputTokens));

  const scores = new Map<string, number>();
  for (let i = 0; i < runs.length; i++) {
    const score =
      (lineMutationRanks[i] +
        touchedFileRanks[i] +
        toolCallRanks[i] +
        durationRanks[i] +
        verificationRanks[i] +
        inputTokenRanks[i]) /
      6;
    scores.set(runs[i].runId, score);
  }
  return scores;
}

// --- Difficulty emphasis (complexity-weighted mastery) ---
//
// The leaderboard's outcome dimensions are weighted by task complexity so that
// completing the hardest tasks dominates the composite. Each run's outcome
// contributes `complexity × outcome` to the dimension mean: a model succeeds on
// complex tasks ⇒ high mastery (big weight × high outcome); a model only ever
// aces easy tasks ⇒ low mastery (small weights cap its score even at perfect
// outcomes). This *emphasizes* difficulty rather than controlling for it, so the
// top of the board is the model that demonstrably completes the most complex work.

/**
 * Mean of `complexity × outcome^outcomeExponent` over the given (complexity, outcome) pairs.
 * This is the per-dimension mastery estimate used in the difficulty-emphasized composite. The outcome
 * exponent (>1) penalizes partial / low outcomes per run so that merely *attempting* hard tasks
 * does not outrank *completing* them: a model must actually succeed, weighted by task complexity.
 * Returns null when there are no pairs (caller should treat the dimension as unobserved).
 */
export function complexityWeightedMean(
  pairs: { complexity: number; outcome: number }[],
  outcomeExponent = 1,
): number | null {
  if (pairs.length === 0) return null;
  let sum = 0;
  for (const p of pairs) sum += p.complexity * (p.outcome ** outcomeExponent);
  return sum / pairs.length;
}

/**
 * Whether the scored population has task-complexity variance, i.e. whether
 * complexity-weighting actually differentiates runs by difficulty. With no
 * variance every run shares the same complexity, so mastery collapses to a
 * uniform rescaling of raw outcomes (no genuine difficulty emphasis). Mirrors the
 * pre-emphasis "adjustment enabled" guard so identical-task fixtures stay a
 * no-op for the difficultyEmphasized flag.
 */
export function hasComplexityVariance(complexityScores: number[]): boolean {
  if (complexityScores.length === 0) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const c of complexityScores) {
    if (c < min) min = c;
    if (c > max) max = c;
  }
  return Number.isFinite(min) && Number.isFinite(max) && max - min > 1e-9;
}
