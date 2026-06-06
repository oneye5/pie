/**
 * Hook for drag-and-drop tab reordering with edge scrolling,
 * context menu support, and click suppression.
 */

import { useState, useRef, useCallback, useEffect } from 'preact/hooks';

import { getHorizontalDropIndex, isPendingTabPath } from '../../../shared/tab-behavior';
import { getSessionTabRunBadge } from './run-state';
import type {
  TabDragCandidate,
  SessionTabDragState,
  UseTabDragAndDropOptions,
  UseTabDragAndDropResult,
} from './types';

const TAB_DRAG_THRESHOLD_PX = 6;
const TAB_DRAG_EDGE_SCROLL_PX = 40;
const TAB_DRAG_EDGE_SCROLL_MAX_STEP_PX = 14;
const TAB_DRAG_VERTICAL_SLOP_PX = 20;

export function useTabDragAndDrop({
  openTabPaths,
  onMove,
  onSelect,
  onClose,
  onDuplicate,
  stripRef,
}: UseTabDragAndDropOptions): UseTabDragAndDropResult {
  const openTabPathsRef = useRef(openTabPaths);
  const dragCandidateRef = useRef<TabDragCandidate | null>(null);
  const dragStateRef = useRef<SessionTabDragState | null>(null);
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const suppressClickTimerRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);
  const pointerMoveHandlerRef = useRef<(event: PointerEvent) => void>(() => undefined);
  const pointerUpHandlerRef = useRef<(event: PointerEvent) => void>(() => undefined);
  const pointerCancelHandlerRef = useRef<(event: PointerEvent) => void>(() => undefined);
  const windowBlurHandlerRef = useRef<() => void>(() => undefined);
  const autoScrollTickRef = useRef<() => void>(() => undefined);
  const [dragState, setDragState] = useState<SessionTabDragState | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabPath: string } | null>(null);

  openTabPathsRef.current = openTabPaths;

  const pointerMoveListener = useCallback((event: PointerEvent) => {
    pointerMoveHandlerRef.current(event);
  }, []);
  const pointerUpListener = useCallback((event: PointerEvent) => {
    pointerUpHandlerRef.current(event);
  }, []);
  const pointerCancelListener = useCallback((event: PointerEvent) => {
    pointerCancelHandlerRef.current(event);
  }, []);
  const windowBlurListener = useCallback(() => {
    windowBlurHandlerRef.current();
  }, []);
  const autoScrollRunner = useCallback(() => {
    autoScrollTickRef.current();
  }, []);

  const releaseSuppressedClickSoon = useCallback(() => {
    suppressNextClickRef.current = true;
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
    }
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = false;
      suppressClickTimerRef.current = null;
    }, 0);
  }, []);

  const stopAutoScrollLoop = useCallback(() => {
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  const beginTracking = useCallback(() => {
    window.addEventListener('pointermove', pointerMoveListener);
    window.addEventListener('pointerup', pointerUpListener);
    window.addEventListener('pointercancel', pointerCancelListener);
    window.addEventListener('blur', windowBlurListener);
  }, [pointerMoveListener, pointerUpListener, pointerCancelListener, windowBlurListener]);

  const endTracking = useCallback(() => {
    window.removeEventListener('pointermove', pointerMoveListener);
    window.removeEventListener('pointerup', pointerUpListener);
    window.removeEventListener('pointercancel', pointerCancelListener);
    window.removeEventListener('blur', windowBlurListener);
    stopAutoScrollLoop();
    document.body.classList.remove('session-tab-dragging');
  }, [pointerMoveListener, pointerUpListener, pointerCancelListener, windowBlurListener, stopAutoScrollLoop]);

  const computeDropIndex = useCallback((clientX: number, clientY: number): number | null => {
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
  }, [stripRef]);

  const syncDragFromPointer = useCallback((clientX: number, clientY: number) => {
    const current = dragStateRef.current;
    if (!current) {
      return;
    }

    const nextDropIndex = computeDropIndex(clientX, clientY);
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
  }, [computeDropIndex]);

  const ensureAutoScrollLoop = useCallback(() => {
    if (autoScrollFrameRef.current === null) {
      autoScrollFrameRef.current = window.requestAnimationFrame(autoScrollRunner);
    }
  }, [autoScrollRunner]);

  const resetDrag = useCallback((suppressClick: boolean) => {
    if (suppressClick) {
      releaseSuppressedClickSoon();
    }
    dragCandidateRef.current = null;
    dragStateRef.current = null;
    pointerPositionRef.current = null;
    setDragState(null);
    endTracking();
  }, [endTracking, releaseSuppressedClickSoon]);

  const commitDrag = useCallback(() => {
    const current = dragStateRef.current;
    if (!current) {
      resetDrag(false);
      return;
    }

    const currentPaths = openTabPathsRef.current;
    const sourceIndex = Math.min(current.sourceIndex, currentPaths.length - 1);
    const movedPath = currentPaths[sourceIndex] ?? current.sourcePath;
    const dropIndex = current.dropIndex;
    const shouldMove = sourceIndex >= 0 && dropIndex !== null && dropIndex !== sourceIndex;

    if (shouldMove) {
      onMove(movedPath, sourceIndex, dropIndex);
    }

    resetDrag(true);
  }, [onMove, resetDrag]);

  autoScrollTickRef.current = () => {
    const drag = dragStateRef.current;
    const pointer = pointerPositionRef.current;
    const strip = stripRef.current;
    if (!drag || !pointer || !strip) {
      autoScrollFrameRef.current = null;
      return;
    }

    const stripRect = strip.getBoundingClientRect();
    const withinVerticalBounds =
      pointer.y >= stripRect.top - TAB_DRAG_VERTICAL_SLOP_PX &&
      pointer.y <= stripRect.bottom + TAB_DRAG_VERTICAL_SLOP_PX;

    let nextDelta = 0;
    if (withinVerticalBounds && strip.scrollWidth > strip.clientWidth) {
      if (pointer.x < stripRect.left + TAB_DRAG_EDGE_SCROLL_PX) {
        const distance = Math.max(pointer.x - stripRect.left, 0);
        const ratio = 1 - (distance / TAB_DRAG_EDGE_SCROLL_PX);
        nextDelta = -Math.ceil(ratio * TAB_DRAG_EDGE_SCROLL_MAX_STEP_PX);
      } else if (pointer.x > stripRect.right - TAB_DRAG_EDGE_SCROLL_PX) {
        const distance = Math.max(stripRect.right - pointer.x, 0);
        const ratio = 1 - (distance / TAB_DRAG_EDGE_SCROLL_PX);
        nextDelta = Math.ceil(ratio * TAB_DRAG_EDGE_SCROLL_MAX_STEP_PX);
      }
    }

    if (nextDelta !== 0) {
      const previousScrollLeft = strip.scrollLeft;
      strip.scrollLeft += nextDelta;
      if (strip.scrollLeft !== previousScrollLeft) {
        syncDragFromPointer(pointer.x, pointer.y);
      }
    }

    autoScrollFrameRef.current = window.requestAnimationFrame(autoScrollRunner);
  };

  pointerMoveHandlerRef.current = (event: PointerEvent) => {
    const candidate = dragCandidateRef.current;
    if (!candidate || event.pointerId !== candidate.pointerId) {
      return;
    }

    pointerPositionRef.current = { x: event.clientX, y: event.clientY };

    if (!dragStateRef.current) {
      const deltaX = event.clientX - candidate.startX;
      const deltaY = event.clientY - candidate.startY;
      if (Math.hypot(deltaX, deltaY) < TAB_DRAG_THRESHOLD_PX) {
        return;
      }

      const nextState: SessionTabDragState = {
        pointerId: candidate.pointerId,
        sourceIndex: candidate.sourceIndex,
        sourcePath: candidate.sourcePath,
        currentX: event.clientX,
        currentY: event.clientY,
        offsetX: candidate.offsetX,
        tabWidth: candidate.tabWidth,
        tabHeight: candidate.tabHeight,
        tabTop: candidate.tabTop,
        dropIndex: candidate.sourceIndex,
      };
      dragStateRef.current = nextState;
      setDragState(nextState);
      document.body.classList.add('session-tab-dragging');
      ensureAutoScrollLoop();
      event.preventDefault();
      return;
    }

    syncDragFromPointer(event.clientX, event.clientY);
    event.preventDefault();
  };

  pointerUpHandlerRef.current = (event: PointerEvent) => {
    const candidate = dragCandidateRef.current;
    if (!candidate || event.pointerId !== candidate.pointerId) {
      return;
    }

    if (dragStateRef.current) {
      pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      syncDragFromPointer(event.clientX, event.clientY);
      commitDrag();
      return;
    }

    dragCandidateRef.current = null;
    pointerPositionRef.current = null;
    endTracking();
  };

  pointerCancelHandlerRef.current = () => {
    if (!dragCandidateRef.current) {
      return;
    }
    resetDrag(false);
  };

  windowBlurHandlerRef.current = () => {
    if (!dragCandidateRef.current) {
      return;
    }
    resetDrag(false);
  };

  useEffect(() => {
    return () => {
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      endTracking();
    };
  }, [endTracking]);

  useEffect(() => {
    if (!dragStateRef.current || !pointerPositionRef.current) {
      return;
    }

    syncDragFromPointer(pointerPositionRef.current.x, pointerPositionRef.current.y);
  }, [dragState?.pointerId, syncDragFromPointer]);

  useEffect(() => {
    if (!dragStateRef.current || !pointerPositionRef.current) {
      return;
    }

    if (dragStateRef.current.sourceIndex >= openTabPaths.length) {
      resetDrag(false);
      return;
    }

    syncDragFromPointer(pointerPositionRef.current.x, pointerPositionRef.current.y);
  }, [openTabPaths, resetDrag, syncDragFromPointer]);

  const onContextMenu = useCallback((event: MouseEvent, tabPath: string) => {
    event.preventDefault();
    setTabContextMenu({ x: event.clientX, y: event.clientY, tabPath });
  }, []);

  const onContextAction = useCallback((action: 'duplicate' | 'close', tabPath: string) => {
    setTabContextMenu(null);
    if (action === 'duplicate') {
      onDuplicate(tabPath);
    } else if (action === 'close') {
      onClose(tabPath);
    }
  }, [onDuplicate, onClose]);

  useEffect(() => {
    if (!tabContextMenu) return;
    const close = () => setTabContextMenu(null);
    const onDown = (e: MouseEvent) => {
      const menuEl = document.querySelector('.session-tab-context-menu');
      if (menuEl && menuEl.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [tabContextMenu]);

  const onPointerDown = useCallback((event: PointerEvent, sourceIndex: number, sourcePath: string) => {
    if (openTabPaths.length <= 1 || dragCandidateRef.current || event.button !== 0 || !event.isPrimary) {
      return;
    }

    const currentTarget = event.currentTarget as HTMLElement | null;
    const tabElement = currentTarget?.closest('.session-tab') as HTMLElement | null;
    const rect = tabElement?.getBoundingClientRect() ?? currentTarget?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    dragCandidateRef.current = {
      pointerId: event.pointerId,
      sourceIndex,
      sourcePath,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      tabWidth: rect.width,
      tabHeight: rect.height,
      tabTop: rect.top,
    };
    pointerPositionRef.current = { x: event.clientX, y: event.clientY };
    beginTracking();
    currentTarget?.setPointerCapture?.(event.pointerId);
  }, [beginTracking, openTabPaths.length]);

  const onClick = useCallback((tabPath: string) => {
    if (suppressNextClickRef.current) {
      return;
    }
    onSelect(tabPath);
  }, [onSelect]);

  return {
    dragState,
    tabContextMenu,
    setTabContextMenu,
    onPointerDown,
    onClick,
    onContextMenu,
    onContextAction,
    autoScrollTickRef,
    dragCandidateRef,
    dragStateRef,
  };
}