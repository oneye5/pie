export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 24;
const SCROLL_TOP_DELTA_EPSILON_PX = 1;
const SCROLL_ANCHOR_VISIBILITY_EPSILON_PX = 1;
const SMOOTH_SCROLL_INTERPOLATION = 0.22;
const SMOOTH_SCROLL_MIN_STEP_PX = 2;
const SMOOTH_SCROLL_MAX_STEP_PX = 56;
export const SMOOTH_SCROLL_SNAP_EPSILON_PX = 1;
/**
 * When the gap between the current and target scroll position exceeds this many
 * pixels, snap directly to the target instead of easing toward it. This keeps
 * the latest content in view during bursty growth (large code blocks, tables,
 * rapid streaming deltas) and makes explicit jumps instant rather than
 * crawling toward the bottom at the per-frame max-step rate. Easing is
 * reserved for small streaming increments so the follow still feels smooth.
 */
const SMOOTH_SCROLL_LARGE_DELTA_SNAP_PX = 200;

export interface ScrollAnchorSnapshot {
  key: string;
  offsetTop: number;
}

export interface ScrollAnchorCandidate {
  key: string;
  top: number;
  bottom: number;
}

export function distanceFromBottom({ scrollHeight, scrollTop, clientHeight }: ScrollMetrics): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function isNearBottom(
  metrics: ScrollMetrics,
  thresholdPx = AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom(metrics) <= thresholdPx;
}

interface ResolveAutoFollowArgs {
  previousAutoFollow: boolean;
  previousScrollTop: number;
  nextScrollTop: number;
  metrics: ScrollMetrics;
  scrollTopDeltaEpsilonPx?: number;
  hasManualScrollIntent?: boolean;
}

export function resolveAutoFollowState({
  previousAutoFollow,
  previousScrollTop,
  nextScrollTop,
  metrics,
  scrollTopDeltaEpsilonPx = SCROLL_TOP_DELTA_EPSILON_PX,
  hasManualScrollIntent = true,
}: ResolveAutoFollowArgs): boolean {
  if (hasManualScrollIntent && nextScrollTop < previousScrollTop - scrollTopDeltaEpsilonPx) {
    return false;
  }

  if (isNearBottom(metrics)) {
    return true;
  }

  return previousAutoFollow;
}

export function captureScrollAnchor(
  candidates: readonly ScrollAnchorCandidate[],
  containerTop = 0,
  visibilityEpsilonPx = SCROLL_ANCHOR_VISIBILITY_EPSILON_PX,
): ScrollAnchorSnapshot | null {
  const firstVisible = candidates.find((candidate) => candidate.bottom > containerTop + visibilityEpsilonPx);
  if (!firstVisible) {
    return null;
  }

  return {
    key: firstVisible.key,
    offsetTop: firstVisible.top - containerTop,
  };
}

export function resolveScrollAnchorDelta(
  previousAnchor: ScrollAnchorSnapshot | null,
  candidates: readonly ScrollAnchorCandidate[],
  containerTop = 0,
): number | null {
  if (!previousAnchor) {
    return null;
  }

  const nextAnchor = candidates.find((candidate) => candidate.key === previousAnchor.key);
  if (!nextAnchor) {
    return null;
  }

  return nextAnchor.top - containerTop - previousAnchor.offsetTop;
}

export function advanceSmoothScrollTop(
  currentScrollTop: number,
  targetScrollTop: number,
  interpolation = SMOOTH_SCROLL_INTERPOLATION,
  minStepPx = SMOOTH_SCROLL_MIN_STEP_PX,
  maxStepPx = SMOOTH_SCROLL_MAX_STEP_PX,
  snapEpsilonPx = SMOOTH_SCROLL_SNAP_EPSILON_PX,
  largeDeltaSnapPx = SMOOTH_SCROLL_LARGE_DELTA_SNAP_PX,
): number {
  const delta = targetScrollTop - currentScrollTop;
  if (Math.abs(delta) <= snapEpsilonPx) {
    return targetScrollTop;
  }

  // Large deltas (bursty growth / explicit jumps) snap to the target so the
  // latest content is always in view instead of easing over many frames.
  if (Math.abs(delta) > largeDeltaSnapPx) {
    return targetScrollTop;
  }

  const step = Math.min(maxStepPx, Math.max(minStepPx, Math.abs(delta) * interpolation));
  const nextScrollTop = currentScrollTop + (Math.sign(delta) * step);

  return delta > 0
    ? Math.min(nextScrollTop, targetScrollTop)
    : Math.max(nextScrollTop, targetScrollTop);
}
