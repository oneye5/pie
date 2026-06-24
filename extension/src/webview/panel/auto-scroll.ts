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
// bottom in a single frame. Raised from 120 so medium sub-threshold bursts
// (a single ~420px section) recover ~1 frame sooner; note the real two-section
// fix is the snap threshold below (deltas ≈528px+ snap rather than ease), since
// interpolation 0.7 still bounds sub-threshold convergence to ~5 frames.
// Streaming growth is far below the cap (a few px/frame), so it only bounds
// discrete expand/collapse, not the smooth streaming glide.
const SMOOTH_SCROLL_MAX_STEP_PX = 240;
export const SMOOTH_SCROLL_SNAP_EPSILON_PX = 1;
/**
 * One-shot deltas ABOVE this threshold snap directly to the target; at-or-below
 * ease. Explicit jumps (scrollToBottom, jumpToLatest, post-session-switch
 * positioning) snap via direct scrollTop assignments rather than through
 * advanceSmoothScrollTop, so this threshold only governs bursty *growth* during
 * the auto-follow loop.
 *
 * Set just above a single expanded section's height — the shared
 * --expanded-section-max-height (~240px + header ≈ 264px) and a typical
 * tool-body expand (~420px) — so a SINGLE section opening still EASES (smooth),
 * but TWO sections opening in the same snapshot (≈528px+) SNAP, keeping the
 * pinned-to-bottom viewport on the latest content instead of easing behind it
 * for ~100ms+. Per-snapshot streaming growth stays well under this and eases.
 * (Previously 1000, which let normal two-section bursts ease and drift.)
 */
const SMOOTH_SCROLL_LARGE_DELTA_SNAP_PX = 480;

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

  // Deltas above the snap threshold (see SMOOTH_SCROLL_LARGE_DELTA_SNAP_PX)
  // snap; single-section expand/collapse (below the threshold) eases so the
  // follow doesn't visibly jump, while two-section bursts snap to stay pinned
  // to the latest. Explicit jumps snap via direct scrollTop sets, not here.
  if (Math.abs(delta) > largeDeltaSnapPx) {
    return targetScrollTop;
  }

  const step = Math.min(maxStepPx, Math.max(minStepPx, Math.abs(delta) * interpolation));
  const nextScrollTop = currentScrollTop + (Math.sign(delta) * step);

  return delta > 0
    ? Math.min(nextScrollTop, targetScrollTop)
    : Math.max(nextScrollTop, targetScrollTop);
}
