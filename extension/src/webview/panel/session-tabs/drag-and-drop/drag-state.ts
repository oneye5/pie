import { TAB_DRAG_VERTICAL_SLOP_PX } from './constants';
import { getHorizontalDropIndex } from '../../../../shared/tab-behavior';

import type { TabDragCandidate, SessionTabDragState } from '../types';

export function runComputeDropIndex(
  clientX: number,
  clientY: number,
  stripRef: { current: HTMLElement | null },
): number | null {
  const strip = stripRef.current;
  if (!strip) {
    return null;
  }

  const stripRect = strip.getBoundingClientRect();
  if (
    clientY < stripRect.top - TAB_DRAG_VERTICAL_SLOP_PX ||
    clientY > stripRect.bottom + TAB_DRAG_VERTICAL_SLOP_PX
  ) {
    return null;
  }

  const rects = Array.from(strip.querySelectorAll<HTMLElement>('[data-drop-target-tab="true"]'))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });

  return getHorizontalDropIndex(rects, clientX);
}

export function runSyncDragFromPointer(
  clientX: number,
  clientY: number,
  dragStateRef: { current: SessionTabDragState | null },
  stripRef: { current: HTMLElement | null },
  setDragState: (state: SessionTabDragState | null) => void,
): void {
  const current = dragStateRef.current;
  if (!current) {
    return;
  }

  const nextDropIndex = runComputeDropIndex(clientX, clientY, stripRef);
  if (
    current.currentX === clientX &&
    current.currentY === clientY &&
    current.dropIndex === nextDropIndex
  ) {
    return;
  }

  const nextState: SessionTabDragState = {
    ...current,
    currentX: clientX,
    currentY: clientY,
    dropIndex: nextDropIndex,
  };
  dragStateRef.current = nextState;
  setDragState(nextState);
}

export function runReleaseSuppressedClickSoon(
  suppressNextClickRef: { current: boolean },
  suppressClickTimerRef: { current: number | null },
): void {
  suppressNextClickRef.current = true;
  if (suppressClickTimerRef.current !== null) {
    window.clearTimeout(suppressClickTimerRef.current);
  }
  suppressClickTimerRef.current = window.setTimeout(() => {
    suppressNextClickRef.current = false;
    suppressClickTimerRef.current = null;
  }, 0);
}

export function runResetDrag(
  suppressClick: boolean,
  suppressNextClickRef: { current: boolean },
  suppressClickTimerRef: { current: number | null },
  dragCandidateRef: { current: TabDragCandidate | null },
  dragStateRef: { current: SessionTabDragState | null },
  pointerPositionRef: { current: { x: number; y: number } | null },
  setDragState: (state: SessionTabDragState | null) => void,
  endTracking: () => void,
): void {
  if (suppressClick) {
    runReleaseSuppressedClickSoon(suppressNextClickRef, suppressClickTimerRef);
  }
  dragCandidateRef.current = null;
  dragStateRef.current = null;
  pointerPositionRef.current = null;
  setDragState(null);
  endTracking();
}

export function runCommitDrag(
  dragStateRef: { current: SessionTabDragState | null },
  openTabPathsRef: { current: string[] },
  onMove: (movedPath: string, sourceIndex: number, dropIndex: number) => void,
  onSelect: (path: string) => void,
  resetDrag: (suppressClick: boolean) => void,
): void {
  const current = dragStateRef.current;
  if (!current) {
    resetDrag(false);
    return;
  }

  const currentPaths = openTabPathsRef.current;
  const dropIndex = current.dropIndex;
  // Resolve the source by path (not the stale sourceIndex) so a tab
  // closing/inserting elsewhere mid-drag doesn't move the wrong tab. The host
  // re-resolves the from-index from the sessionPath.
  const sourceIndex = currentPaths.indexOf(current.sourcePath);
  const sourceStillPresent = sourceIndex !== -1;
  const shouldMove = sourceStillPresent && dropIndex !== null && dropIndex !== sourceIndex;

  if (shouldMove) {
    onMove(current.sourcePath, sourceIndex, dropIndex);
  } else if (dropIndex !== null && sourceStillPresent) {
    // Released over the strip on the same slot (e.g. a click that jittered past
    // the drag threshold): the compatibility `click` was suppressed by
    // `preventDefault` on the drag pointermove, so switch the tab explicitly
    // instead of relying on `click` firing. Releasing outside the strip
    // (dropIndex === null) is treated as a cancel.
    onSelect(current.sourcePath);
  }

  resetDrag(true);
}
