import { useEffect } from 'preact/hooks';

import type { SessionTabDragState } from '../types';

export function useDragEffects({
  dragState,
  dragStateRef,
  pointerPositionRef,
  openTabPaths,
  suppressClickTimerRef,
  endTracking,
  resetDrag,
  syncDragFromPointer,
}: {
  dragState: SessionTabDragState | null;
  dragStateRef: { current: SessionTabDragState | null };
  pointerPositionRef: { current: { x: number; y: number } | null };
  openTabPaths: string[];
  suppressClickTimerRef: { current: number | null };
  endTracking: () => void;
  resetDrag: (suppressClick: boolean) => void;
  syncDragFromPointer: (clientX: number, clientY: number) => void;
}) {
  useEffect(() => {
    return () => {
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      endTracking();
    };
  }, [endTracking, suppressClickTimerRef]);

  useEffect(() => {
    if (!dragStateRef.current || !pointerPositionRef.current) {
      return;
    }

    syncDragFromPointer(pointerPositionRef.current.x, pointerPositionRef.current.y);
  }, [dragState?.pointerId, syncDragFromPointer, dragStateRef, pointerPositionRef]);

  useEffect(() => {
    if (!dragStateRef.current || !pointerPositionRef.current) {
      return;
    }

    if (dragStateRef.current.sourceIndex >= openTabPaths.length) {
      resetDrag(false);
      return;
    }

    syncDragFromPointer(pointerPositionRef.current.x, pointerPositionRef.current.y);
  }, [openTabPaths, resetDrag, syncDragFromPointer, dragStateRef, pointerPositionRef]);
}
