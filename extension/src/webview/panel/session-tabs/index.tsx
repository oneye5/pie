/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

import type { ActiveRunSummary, SessionSummary } from '../../../shared/protocol';
import { getHorizontalDropIndex, isPendingTabPath } from '../../../shared/tab-behavior';
import { getSessionTabRunBadge } from './run-state';

const TAB_DRAG_THRESHOLD_PX = 6;
const TAB_DRAG_EDGE_SCROLL_PX = 40;
const TAB_DRAG_EDGE_SCROLL_MAX_STEP_PX = 14;
const TAB_DRAG_VERTICAL_SLOP_PX = 20;

interface SessionTabsProps {
  sessions: SessionSummary[];
  openTabPaths: string[];
  runningSessionPaths: string[];
  unreadFinishedSessionPaths: string[];
  activeSession: SessionSummary | null;
  activeRunSummary: ActiveRunSummary | null;
  backendReady?: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onMove: (sessionPath: string | undefined, fromIndex: number, toIndex: number) => void;
  onNew: () => void;
  onMarkComplete: () => void;
  onDuplicate: (path: string) => void;
}

type TabDragCandidate = {
  pointerId: number;
  sourceIndex: number;
  sourcePath: string;
  startX: number;
  startY: number;
  offsetX: number;
  tabWidth: number;
  tabHeight: number;
  tabTop: number;
};

type SessionTabDragState = {
  pointerId: number;
  sourceIndex: number;
  sourcePath: string;
  currentX: number;
  currentY: number;
  offsetX: number;
  tabWidth: number;
  tabHeight: number;
  tabTop: number;
  dropIndex: number | null;
};

export function SessionTabs({
  sessions,
  openTabPaths,
  runningSessionPaths,
  unreadFinishedSessionPaths,
  activeSession,
  activeRunSummary,
  backendReady,
  onSelect,
  onClose,
  onMove,
  onNew,
  onMarkComplete,
  onDuplicate,
}: SessionTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);
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

  const sessionByPath = new Map(sessions.map((session) => [session.path, session]));
  const openIndexByPath = new Map(openTabPaths.map((path, index) => [path, index]));
  const runningPathSet = new Set(runningSessionPaths);
  const unreadFinishedPathSet = new Set(unreadFinishedSessionPaths);

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
  }, []);

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

  const handleTabContextMenu = useCallback((tabPath: string, event: MouseEvent) => {
    event.preventDefault();
    setTabContextMenu({ x: event.clientX, y: event.clientY, tabPath });
  }, []);

  const handleTabContextAction = useCallback((action: 'duplicate' | 'close', tabPath: string) => {
    setTabContextMenu(null);
    if (action === 'duplicate') {
      onDuplicate(tabPath);
    } else if (action === 'close') {
      onClose(tabPath);
    }
  }, [onDuplicate, onClose]);

  // Close context menu on any outside click or Escape.
  useEffect(() => {
    if (!tabContextMenu) return;
    const close = () => setTabContextMenu(null);
    const onDown = (e: MouseEvent) => {
      // Keep menu open if clicking inside it (for item selection).
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

  const handleTabPointerDown = useCallback((tabPath: string, sourceIndex: number, event: PointerEvent) => {
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
      sourcePath: tabPath,
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

  const handleTabClick = useCallback((tabPath: string) => {
    if (suppressNextClickRef.current) {
      return;
    }
    onSelect(tabPath);
  }, [onSelect]);

  const draggedSourceIndex = dragState ? Math.min(dragState.sourceIndex, openTabPaths.length - 1) : -1;
  const draggedPath = draggedSourceIndex >= 0 ? (openTabPaths[draggedSourceIndex] ?? dragState?.sourcePath ?? null) : null;
  const renderedTabPaths = draggedSourceIndex >= 0
    ? openTabPaths.filter((_, index) => index !== draggedSourceIndex)
    : openTabPaths;
  const dragGapWidth = dragState
    ? Math.max(18, Math.min(34, Math.round(dragState.tabWidth * 0.22)))
    : 0;

  const renderDropGap = (index: number) => {
    if (!dragState || dragState.dropIndex !== index) {
      return null;
    }

    return (
      <div
        key={`drop-gap:${index}`}
        class="session-tab-drop-gap"
        style={{ width: `${dragGapWidth}px`, height: `${dragState.tabHeight}px` }}
        aria-hidden="true"
      >
        <span class="session-tab-drop-slot" />
        <span class="session-tab-drop-marker" />
      </div>
    );
  };

  const floatingSession = draggedPath ? sessionByPath.get(draggedPath) : null;
  const floatingLabel = floatingSession?.name ?? 'New Session';
  const floatingRunning = draggedPath !== null ? runningPathSet.has(draggedPath) : false;
  const floatingActive = draggedPath !== null && activeSession?.path === draggedPath;

  return (
    <div class={`session-tabs${dragState ? ' dragging' : ''}`}>
      <div ref={stripRef} class="session-tabs-strip" role="tablist" aria-label="Sessions">
        {renderedTabPaths.map((tabPath, index) => {
          const session = sessionByPath.get(tabPath);
          const label = session?.name ?? 'New Session';
          const isActive = activeSession?.path === tabPath;
          const isRunning = runningPathSet.has(tabPath);
          const isUnreadFinished = unreadFinishedPathSet.has(tabPath);
          const originalIndex = openIndexByPath.get(tabPath) ?? index;
          const title = isUnreadFinished ? `${label} (finished, unread)` : label;

          return [
            renderDropGap(index),
            <div
              key={tabPath}
              class={`session-tab${isActive ? ' active' : ''}${isUnreadFinished ? ' unread-finished' : ''}`}
              data-drop-target-tab="true"
              onContextMenu={(event) => handleTabContextMenu(tabPath, event as MouseEvent)}
            >
              <span class="session-tab-shell" aria-hidden="true" />
              <button
                class="session-tab-main"
                type="button"
                role="tab"
                aria-selected={isActive}
                title={title}
                onPointerDown={(event) => handleTabPointerDown(tabPath, originalIndex, event as PointerEvent)}
                onClick={() => handleTabClick(tabPath)}
              >
                {isRunning
                  ? <span class="session-tab-running" aria-hidden="true" />
                  : isUnreadFinished
                    ? <span class="session-tab-finished" aria-hidden="true" />
                    : null}
                <span class="session-tab-label">{label}</span>
              </button>
              {isActive && (() => {
                const badge = getSessionTabRunBadge(activeRunSummary);
                if (!badge) return null;
                return (
                  <button
                    class={`session-tab-run-badge ${badge.tone}`}
                    type="button"
                    title={badge.title}
                    aria-label={badge.title}
                    onClick={onMarkComplete}
                  >
                    {badge.text}
                  </button>
                );
              })()}
              <button
                class="session-tab-close"
                type="button"
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                onClick={() => onClose(tabPath)}
              >
                ×
              </button>
            </div>,
          ];
        })}
        {renderDropGap(renderedTabPaths.length)}
        <button
          class="session-tabs-new"
          type="button"
          title="New session"
          onClick={onNew}
          aria-label="New session"
        >
          +
        </button>
        {!backendReady && (
          <span class="session-tabs-connecting" title="Connecting to backend…" aria-label="Connecting">
            <span class="loading-wheel loading-wheel-sm" aria-hidden="true" />
          </span>
        )}
      </div>
      {dragState && draggedPath && (
        <div
          class={`session-tab session-tab-floating${floatingActive ? ' active' : ''}`}
          style={{
            width: `${dragState.tabWidth}px`,
            height: `${dragState.tabHeight}px`,
            left: `${dragState.currentX - dragState.offsetX}px`,
            top: `${dragState.tabTop}px`,
          }}
          aria-hidden="true"
        >
          <span class="session-tab-shell" aria-hidden="true" />
          <div class="session-tab-main">
            {floatingRunning && <span class="session-tab-running" aria-hidden="true" />}
            <span class="session-tab-label">{floatingLabel}</span>
          </div>
          <div class="session-tab-close" aria-hidden="true">×</div>
        </div>
      )}
      {tabContextMenu && (() => {
        const ctxSession = sessionByPath.get(tabContextMenu.tabPath);
        const ctxLabel = ctxSession?.name ?? 'New Session';
        const isPending = isPendingTabPath(tabContextMenu.tabPath);
        const menuTop = Math.min(tabContextMenu.y, window.innerHeight - 100);
        const menuLeft = Math.min(tabContextMenu.x, window.innerWidth - 210);
        return (
          <div
            class="block-context-menu session-tab-context-menu"
            style={`position:fixed;top:${menuTop}px;left:${menuLeft}px`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div class="session-tab-context-title" title={ctxLabel}>{ctxLabel}</div>
            <button
              class="context-menu-item"
              type="button"
              disabled={isPending}
              onClick={() => handleTabContextAction('duplicate', tabContextMenu.tabPath)}
            >
              <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0">
                <rect x="2" y="2" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2" />
              </svg>
              Duplicate Tab
            </button>
            <button
              class="context-menu-item"
              type="button"
              onClick={() => handleTabContextAction('close', tabContextMenu.tabPath)}
            >
              <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0">
                <line x1="3" y1="3" x2="10" y2="10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                <line x1="10" y1="3" x2="3" y2="10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              </svg>
              Close Tab
            </button>
          </div>
        );
      })()}
    </div>
  );
}
