export const DISPLAY_SCORE_DIMS = [
  { key: 'precision', label: 'P', full: 'Precision' },
  { key: 'creativity', label: 'C', full: 'Creativity' },
  { key: 'reasoning', label: 'R', full: 'Reasoning' },
  { key: 'thoroughness', label: 'T', full: 'Thoroughness' },
] as const;

export type DisplayScoreDimKey = typeof DISPLAY_SCORE_DIMS[number]['key'];
export type DisplayTaskScores = Record<DisplayScoreDimKey, number>;
export type PartialTaskScores = Partial<DisplayTaskScores>;

/**
 * Mirrors the subagent model-selection default used when a caller omits a task-score dimension.
 * UI display should show the effective full requirement vector, not just explicitly provided fields.
 */
export const DEFAULT_DISPLAY_TASK_SCORE = 2;

export function normalizeTaskScoresForDisplay(scores: PartialTaskScores | undefined): DisplayTaskScores | undefined {
  if (scores == null) return undefined;

  return {
    precision: scores.precision ?? DEFAULT_DISPLAY_TASK_SCORE,
    creativity: scores.creativity ?? DEFAULT_DISPLAY_TASK_SCORE,
    reasoning: scores.reasoning ?? DEFAULT_DISPLAY_TASK_SCORE,
    thoroughness: scores.thoroughness ?? DEFAULT_DISPLAY_TASK_SCORE,
  };
}
