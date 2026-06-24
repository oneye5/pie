export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 24;
const SCROLL_TOP_DELTA_EPSILON_PX = 1;
const SCROLL_ANCHOR_VISIBILITY_EPSILON_PX = 1;
const SMOOTH_SCROLL_INTERPOLATION = 0.7;
const SMOOTH_SCROLL_MIN_STEP_PX = 2;
// Caps the per-frame step so large one-shot resizes (tool-body expand/collapse,
// ~up to 420px) glide at a constant velocity instead of lunging to the new
// bottom in a single frame. 120px/frame converges a 420px resize in ~6 frames
// (~100ms); smaller (streaming) deltas are uncapped and close in 1–3 frames.
const SMOOTH_SCROLL_MAX_STEP_PX = 120;
export const SMOOTH_SCROLL_SNAP_EPSILON_PX = 1;
/**
 * Only truly huge one-shot deltas snap directly to the target; everything
 * below this threshold eases. Explicit jumps (scrollToBottom, jumpToLatest,
 * post-session-switch positioning) snap via direct scrollTop assignments
 * rather than through advanceSmoothScrollTop, so this threshold only governs
 * bursty *growth* during the auto-follow loop. The high cap bounds the worst
 * case so a pathological multi-thousand-pixel burst (e.g. a huge collapsed
 * block suddenly expanded) doesn't ease over many frames and leave the latest
 * content off-screen for ~0.5s+.
 */
const SMOOTH_SCROLL_LARGE_DELTA_SNAP_PX = 1000;

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
}

/**
 * Decides whether auto-follow (stick-to-bottom) stays engaged after a scroll
 * event. Detection is input-device-agnostic: any movement away from the
 * bottom disengages, so keyboard scroll-up (Page Up / Home / ↑ / Shift+Space)
 * — which fires no wheel/touch/pointer event — is caught just like wheel,
 * touch, and scrollbar drag.
 *
 * The auto-follow rAF loop's own programmatic scrolls only ever move scrollTop
 * toward the bottom (an increase or a snap), so they can never trip the
 * "scrolled up" branch; a prior `hasManualScrollIntent` gate is what let
 * keyboard scroll-up slip through and left the rAF loop re-pinning scrollTop to
 * the bottom every frame, fighting the reader.
 *
 * `isNearBottom` is checked first so tiny upward nudges within the threshold
 * stay engaged, and — importantly — so a content-shrink clamp (the browser
 * clamping scrollTop down to the new bottom when content above shrinks, e.g. a
 * tool card collapsing or context pruning) does not falsely disengage follow.
 */
export function resolveAutoFollowState({
  previousAutoFollow,
  previousScrollTop,
  nextScrollTop,
  metrics,
  scrollTopDeltaEpsilonPx = SCROLL_TOP_DELTA_EPSILON_PX,
}: ResolveAutoFollowArgs): boolean {
  if (isNearBottom(metrics)) {
    return true;
  }

  if (nextScrollTop < previousScrollTop - scrollTopDeltaEpsilonPx) {
    return false;
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

  // Only truly huge one-shot deltas (see SMOOTH_SCROLL_LARGE_DELTA_SNAP_PX)
  // snap; ordinary tool-body expand/collapse eases so the follow doesn't
  // visibly jump. Explicit jumps snap via direct scrollTop sets, not here.
  if (Math.abs(delta) > largeDeltaSnapPx) {
    return targetScrollTop;
  }

  const step = Math.min(maxStepPx, Math.max(minStepPx, Math.abs(delta) * interpolation));
  const nextScrollTop = currentScrollTop + (Math.sign(delta) * step);

  return delta > 0
    ? Math.min(nextScrollTop, targetScrollTop)
    : Math.max(nextScrollTop, targetScrollTop);
}
