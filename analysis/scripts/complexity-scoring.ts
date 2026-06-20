/**
 * Dependency-free task-complexity scoring and difficulty-adjustment helpers.
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

// --- Difficulty adjustment (residual control) ---
//
// Selection bias: stronger models are assigned harder tasks, so their raw
// outcome rates look worse than they are while easy-task models look better.
// To control for this, each outcome dimension's observed estimate is replaced
// by `grandMean + mean_residual`, where `residual_i = outcome_i − baseline(c_i)`
// and `baseline` is the population's mean outcome at that task complexity.
// A model that only aces easy tasks gets ~0 residual (the easy-task baseline is
// already high) → it lands at the grand mean (mid-pack); a model that beats the
// hard-task baseline lifts above it. This *controls for* difficulty rather than
// *rewarding* being assigned hard tasks (failing hard tasks yields negative
// residuals → below mid-pack).

/** Minimum population size to fit a complexity baseline (else adjustment is a no-op). */
export const COMPLEXITY_BASELINE_MIN_RUNS = 10;

export interface ComplexityBaseline {
  enabled: boolean;
  /** Population mean outcome for the bin containing `complexity` (0 when disabled). */
  baselineAt: (complexity: number) => number;
}

function baselineBinCount(n: number): number {
  return Math.min(10, Math.max(1, Math.floor(n / 5)));
}

interface BaselineBin {
  lo: number;
  hi: number;
  mean: number;
}

/**
 * Fit a nonparametric population baseline of outcome vs complexity using
 * equal-frequency bins (each bin holds ~n/k runs, so no bin is ever empty).
 *
 * Returns `enabled: false` (a no-op) when there is no complexity variance, the
 * population is too small, or fewer than 2 bins would form — in which case
 * callers fall back to raw observed estimates, byte-identical to pre-adjustment.
 * This no-op guard keeps every fixture that clones a single base run (identical
 * complexity ⇒ zero variance) unchanged.
 */
export function fitComplexityBaseline(pairs: { complexity: number; outcome: number }[]): ComplexityBaseline {
  const n = pairs.length;
  const k = baselineBinCount(n);
  if (n < COMPLEXITY_BASELINE_MIN_RUNS || k < 2) return { enabled: false, baselineAt: () => 0 };

  let min = Infinity;
  let max = -Infinity;
  for (const p of pairs) {
    if (p.complexity < min) min = p.complexity;
    if (p.complexity > max) max = p.complexity;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) {
    return { enabled: false, baselineAt: () => 0 };
  }

  // Stable sort by complexity (Array.prototype.sort is stable, so ties keep
  // insertion order — which is the deterministic run iteration order).
  const sorted = [...pairs].sort((a, b) => a.complexity - b.complexity);
  const bins: BaselineBin[] = [];
  const size = n / k;
  for (let b = 0; b < k; b++) {
    const start = Math.floor(b * size);
    const end = b === k - 1 ? n : Math.floor((b + 1) * size);
    let sum = 0;
    for (let i = start; i < end; i++) sum += sorted[i]!.outcome;
    const sliceMean = sum / (end - start);
    bins.push({ lo: sorted[start]!.complexity, hi: sorted[end - 1]!.complexity, mean: sliceMean });
  }

  const baselineAt = (complexity: number): number => {
    for (let i = 0; i < bins.length; i++) {
      if (complexity <= bins[i]!.hi || i === bins.length - 1) return bins[i]!.mean;
    }
    return bins[bins.length - 1]!.mean;
  };
  return { enabled: true, baselineAt };
}

/**
 * Mean of (outcome − baseline(complexity)) over the given pairs. Returns null
 * when the baseline is disabled (caller should use the raw observed estimate)
 * or when there are no pairs.
 */
export function meanResidual(
  pairs: { complexity: number; outcome: number }[],
  baseline: ComplexityBaseline,
): number | null {
  if (pairs.length === 0 || !baseline.enabled) return null;
  let sum = 0;
  for (const p of pairs) sum += p.outcome - baseline.baselineAt(p.complexity);
  return sum / pairs.length;
}
