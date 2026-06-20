/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import type { RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { ActiveRunSummary, ExtensionUIRequestPayload, SessionSummary } from '../../../shared/protocol';
import { isPendingTabPath } from '../../../shared/tab-behavior';
import { getSessionTabRunBadge, getSessionTabRunMenuItems } from './run-state';
import type { SessionTabRunAction } from './run-state';
import { getTabAvatarColor, getTabAvatarLabel } from './tab-avatar';
import { useTabDragAndDrop } from './use-drag-and-drop.js';
import type { SessionTabContextAction, SessionTabDragState } from './types';

interface SessionTabsProps {
  sessions: SessionSummary[];
  openTabPaths: string[];
  pinnedTabPaths: string[];
  runningSessionPaths: string[];
  unreadFinishedSessionPaths: string[];
  activeSession: SessionSummary | null;
  activeRunSummary: ActiveRunSummary | null;
  backendReady?: boolean;
  hideConnectingWheel?: boolean;
  pendingExtensionUIRequestsBySession: Record<string, Record<string, import('../../../shared/protocol').ExtensionUIRequestPayload>>;
  runSummariesBySession: Record<string, ActiveRunSummary | null>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onMove: (sessionPath: string | undefined, fromIndex: number, toIndex: number) => void;
  onNew: () => void;
  onMarkComplete: () => void;
  onDuplicate: (path: string) => void;
  onTogglePin: (path: string) => void;
  onRunAction: (action: SessionTabRunAction, tabPath: string) => void;
}

interface DropGapProps {
  index: number;
  dropIndex: number | null;
  tabHeight: number;
  dragGapWidth: number;
}

// Memoized with primitive props so during a drag only the (at most two)
// DropGaps whose `dropIndex` matches re-render — not all of them — when the
// parent re-renders on each pointermove.
const DropGap = memo(function DropGap({ index, dropIndex, tabHeight, dragGapWidth }: DropGapProps) {
  if (dropIndex === null || dropIndex !== index) {
    return null;
  }

  return (
    <div
      key={`drop-gap:${index}`}
      class="session-tab-drop-gap"
      style={{ width: `${dragGapWidth}px`, height: `${tabHeight}px` }}
      aria-hidden="true"
    >
      <span class="session-tab-drop-slot" />
      <span class="session-tab-drop-marker" />
    </div>
  );
});

interface SessionTabProps {
  tabPath: string;
  index: number;
  sessionByPath: Map<string, SessionSummary>;
  openIndexByPath: Map<string, number>;
  runningPathSet: Set<string>;
  unreadFinishedPathSet: Set<string>;
  activeSession: SessionSummary | null;
  hasPendingExtensionUIRequest: boolean;
  activeRunSummary: ActiveRunSummary | null;
  isPinned: boolean;
  onContextMenu: (event: MouseEvent, tabPath: string) => void;
  onPointerDown: (event: PointerEvent, sourceIndex: number, sourcePath: string) => void;
  onClick: (tabPath: string) => void;
  onClose: (tabPath: string) => void;
  onMarkComplete: () => void;
}

// Memoized so non-source tabs skip re-render during a drag (the parent
// re-renders on every pointermove). Effectiveness depends on stable prop
// identities: the derived Maps/Sets are memoized in SessionTabs and the drag
// callbacks are useCallback-stabilized in the hook.
export const SessionTab = memo(function SessionTab({
  tabPath,
  index,
  sessionByPath,
  openIndexByPath,
  runningPathSet,
  unreadFinishedPathSet,
  activeSession,
  hasPendingExtensionUIRequest,
  activeRunSummary,
  isPinned,
  onContextMenu,
  onPointerDown,
  onClick,
  onClose,
  onMarkComplete,
}: SessionTabProps) {
  const session = sessionByPath.get(tabPath);
  const label = session?.name ?? 'New Session';
  const isActive = activeSession?.path === tabPath;
  const isAttention = !!hasPendingExtensionUIRequest;
  const isRunning = runningPathSet.has(tabPath);
  const isUnreadFinished = unreadFinishedPathSet.has(tabPath);
  const originalIndex = openIndexByPath.get(tabPath) ?? index;
  const title = hasPendingExtensionUIRequest
    ? `${label} (waiting for your answer)`
    : isUnreadFinished
      ? `${label} (finished, unread)`
      : label;

  const classBits = ['session-tab'];
  if (isActive) classBits.push('active');
  if (isAttention) classBits.push('attention');
  if (isUnreadFinished) classBits.push('unread-finished');
  if (isPinned) classBits.push('pinned');
  if (isRunning) classBits.push('running');

  return (
    <div
      key={tabPath}
      class={classBits.join(' ')}
      data-drop-target-tab="true"
      data-tab-path={tabPath}
      onContextMenu={(event) => onContextMenu(event as MouseEvent, tabPath)}
    >
      <span class="session-tab-shell" aria-hidden="true" />
      <button
        class="session-tab-main"
        type="button"
        role="tab"
        aria-selected={isActive}
        tabIndex={isActive ? 0 : -1}
        title={title}
        onPointerDown={(event) => onPointerDown(event as PointerEvent, originalIndex, tabPath)}
        onClick={() => onClick(tabPath)}
      >
        {isPinned ? (
          <span
            class="session-tab-avatar"
            style={{ background: getTabAvatarColor(tabPath) }}
            aria-hidden="true"
          >
            {getTabAvatarLabel(label)}
          </span>
        ) : (
          <>
            {isRunning
              ? <span class="session-tab-running" aria-hidden="true" />
              : isUnreadFinished
                ? <span class="session-tab-finished" aria-hidden="true" />
                : null}
            <span class="session-tab-label">{label}</span>
          </>
        )}
      </button>
      {isActive && !isPinned && (
        (() => {
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
        })()
      )}
      {!isPinned && (
        <button
          class="session-tab-close"
          type="button"
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
          onClick={() => onClose(tabPath)}
        >
          ×
        </button>
      )}
    </div>
  );
});

interface FloatingSessionTabProps {
  dragState: SessionTabDragState;
  draggedPath: string;
  sessionByPath: Map<string, SessionSummary>;
  runningPathSet: Set<string>;
  activeSession: SessionSummary | null;
  isPinned: boolean;
  ghostRef: RefObject<HTMLDivElement>;
}

function FloatingSessionTab({
  dragState,
  draggedPath,
  sessionByPath,
  runningPathSet,
  activeSession,
  isPinned,
  ghostRef,
}: FloatingSessionTabProps) {
  const floatingSession = sessionByPath.get(draggedPath);
  const floatingLabel = floatingSession?.name ?? 'New Session';
  const floatingRunning = runningPathSet.has(draggedPath);
  const floatingActive = activeSession?.path === draggedPath;

  const classBits = ['session-tab', 'session-tab-floating'];
  if (floatingActive) classBits.push('active');
  if (isPinned) classBits.push('pinned');
  if (floatingRunning) classBits.push('running');

  return (
    <div
      ref={ghostRef}
      class={classBits.join(' ')}
      style={{
        width: `${dragState.tabWidth}px`,
        height: `${dragState.tabHeight}px`,
        left: 0,
        top: `${dragState.tabTop}px`,
      }}
      aria-hidden="true"
    >
      <span class="session-tab-shell" aria-hidden="true" />
      <div class="session-tab-main">
        {isPinned ? (
          <span
            class="session-tab-avatar"
            style={{ background: getTabAvatarColor(draggedPath) }}
            aria-hidden="true"
          >
            {getTabAvatarLabel(floatingLabel)}
          </span>
        ) : (
          <>
            {floatingRunning && <span class="session-tab-running" aria-hidden="true" />}
            <span class="session-tab-label">{floatingLabel}</span>
          </>
        )}
      </div>
      {!isPinned && <div class="session-tab-close" aria-hidden="true">×</div>}
    </div>
  );
}

interface SessionTabContextMenuProps {
  tabContextMenu: { x: number; y: number; tabPath: string };
  sessionByPath: Map<string, SessionSummary>;
  runSummary: ActiveRunSummary | null;
  isPinned: boolean;
  onContextAction: (action: SessionTabContextAction, tabPath: string) => void;
}

function SessionTabContextMenu({
  tabContextMenu,
  sessionByPath,
  runSummary,
  isPinned,
  onContextAction,
}: SessionTabContextMenuProps) {
  const ctxSession = sessionByPath.get(tabContextMenu.tabPath);
  const ctxLabel = ctxSession?.name ?? 'New Session';
  const isPending = isPendingTabPath(tabContextMenu.tabPath);
  const menuTop = Math.min(tabContextMenu.y, window.innerHeight - 100);
  const menuLeft = Math.min(tabContextMenu.x, window.innerWidth - 210);
  const runItems = getSessionTabRunMenuItems(runSummary);

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
        onClick={() => onContextAction(isPinned ? 'unpin' : 'pin', tabContextMenu.tabPath)}
      >
        <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
        {isPinned ? 'Unpin Tab' : 'Pin Tab'}
      </button>
      <div class="context-menu-separator" />
      {runItems.map((item) => (
        <button
          key={item.action}
          class="context-menu-item"
          type="button"
          onClick={() => onContextAction(item.action, tabContextMenu.tabPath)}
        >
          <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
          {item.label}
        </button>
      ))}
      {runItems.length > 0 && <div class="context-menu-separator" />}
      <button
        class="context-menu-item"
        type="button"
        disabled={isPending}
        onClick={() => onContextAction('duplicate', tabContextMenu.tabPath)}
      >
        <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0">
          <rect x="2" y="2" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2" />
        </svg>
        Duplicate Tab
      </button>
      <button
        class="context-menu-item"
        type="button"
        onClick={() => onContextAction('close', tabContextMenu.tabPath)}
      >
        <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0">
          <line x1="3" y1="3" x2="10" y2="10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          <line x1="10" y1="3" x2="3" y2="10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        Close Tab
      </button>
    </div>
  );
}

function hasPendingRequest(
  map: Record<string, Record<string, ExtensionUIRequestPayload>>,
  sessionPath: string,
): boolean {
  const sessionMap = map[sessionPath];
  return !!sessionMap && Object.keys(sessionMap).length > 0;
}

export function SessionTabs({
  sessions,
  openTabPaths,
  pinnedTabPaths,
  runningSessionPaths,
  unreadFinishedSessionPaths,
  activeSession,
  activeRunSummary,
  backendReady,
  hideConnectingWheel,
  pendingExtensionUIRequestsBySession,
  runSummariesBySession,
  onSelect,
  onClose,
  onMove,
  onNew,
  onMarkComplete,
  onDuplicate,
  onTogglePin,
  onRunAction,
}: SessionTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);

  const {
    dragState,
    tabContextMenu,
    onPointerDown,
    onClick,
    onContextMenu,
    onContextAction,
    ghostElementRef,
  } = useTabDragAndDrop({
    openTabPaths,
    pinnedTabPaths,
    onMove,
    onSelect,
    onClose,
    onDuplicate,
    onTogglePin,
    onRunAction,
    stripRef,
  });

  // Stabilize derived collections so memoized children (SessionTab, DropGap)
  // skip re-render while their props are unchanged — essential during a drag,
  // where the parent re-renders on every pointermove.
  const sessionByPath = useMemo(() => new Map(sessions.map((session) => [session.path, session])), [sessions]);
  const openIndexByPath = useMemo(() => new Map(openTabPaths.map((path, index) => [path, index])), [openTabPaths]);
  const runningPathSet = useMemo(() => new Set(runningSessionPaths), [runningSessionPaths]);
  const unreadFinishedPathSet = useMemo(() => new Set(unreadFinishedSessionPaths), [unreadFinishedSessionPaths]);
  const pinnedPathSet = useMemo(() => new Set(pinnedTabPaths), [pinnedTabPaths]);

  // Re-resolve the dragged index from the source path each render so a tab
  // closing or being inserted elsewhere mid-drag doesn't float the wrong tab.
  const draggedSourcePath = dragState?.sourcePath ?? null;
  const draggedSourceIndex = draggedSourcePath !== null ? openTabPaths.indexOf(draggedSourcePath) : -1;
  const draggedPath = draggedSourceIndex >= 0 ? draggedSourcePath : null;
  const renderedTabPaths = draggedSourceIndex >= 0
    ? openTabPaths.filter((_, index) => index !== draggedSourceIndex)
    : openTabPaths;
  const dragGapWidth = dragState
    ? Math.max(18, Math.min(34, Math.round(dragState.tabWidth * 0.22)))
    : 0;
  // Primitives for the memoized DropGap: only `dropIndex` (and the static
  // geometry) reach it, so it skips re-render until the drop target changes.
  const activeDropIndex = dragState?.dropIndex ?? null;
  const dropTabHeight = dragState?.tabHeight ?? 0;

  // Tabs-1: scroll the active tab into view when the active session changes
  // (host selection, closing an adjacent tab, DnD commit near an edge).
  // `inline: 'nearest'` scrolls only the minimum needed; no-op if visible.
  const activePath = activeSession?.path ?? null;
  useEffect(() => {
    if (!activePath) return;
    const strip = stripRef.current;
    if (!strip) return;
    const tab = Array.from(strip.querySelectorAll<HTMLElement>('.session-tab[data-tab-path]'))
      .find((el) => el.getAttribute('data-tab-path') === activePath);
    tab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activePath]);

  // Tabs-4: surface horizontal overflow with edge fades. Re-measures on strip
  // resize (ResizeObserver), scroll position, and tab/content changes (deps).
  const [fadeLeft, setFadeLeft] = useState(false);
  const [fadeRight, setFadeRight] = useState(false);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const update = () => {
      const hasOverflow = strip.scrollWidth - strip.clientWidth > 1;
      setFadeLeft(hasOverflow && strip.scrollLeft > 1);
      setFadeRight(hasOverflow && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
    };
    update();
    strip.addEventListener('scroll', update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(strip);
    return () => {
      strip.removeEventListener('scroll', update);
      resizeObserver.disconnect();
    };
  }, [openTabPaths, sessions]);

  // Tabs-5: roving-tabindex keyboard navigation (WAI-ARIA Tabs). Arrow keys
  // move focus and select the adjacent tab; Home/End jump to the ends; Delete
  // closes the focused tab and restores focus to its neighbor (which the host
  // also selects as the next active tab, keeping roving consistent). Disabled
  // during an active pointer drag.
  const onTabListKeyDown = useCallback((event: KeyboardEvent) => {
    if (dragState) return;
    const strip = stripRef.current;
    if (!strip) return;
    const target = event.target as HTMLElement | null;
    const tabEl = target ? (target.closest('.session-tab[data-tab-path]') as HTMLElement | null) : null;
    if (!tabEl) return;
    const tabPath = tabEl.getAttribute('data-tab-path');
    if (!tabPath) return;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.session-tab[data-tab-path]'));
    const currentIndex = tabs.indexOf(tabEl);
    if (currentIndex === -1) return;

    if (event.key === 'Delete') {
      event.preventDefault();
      const fallbackIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : currentIndex - 1;
      const fallbackPath = fallbackIndex >= 0 ? tabs[fallbackIndex]?.getAttribute('data-tab-path') : null;
      onClose(tabPath);
      if (fallbackPath) {
        requestAnimationFrame(() => {
          const s = stripRef.current;
          if (!s) return;
          const next = Array.from(s.querySelectorAll<HTMLElement>('.session-tab[data-tab-path]'))
            .find((el) => el.getAttribute('data-tab-path') === fallbackPath);
          next?.querySelector<HTMLElement>('[role="tab"]')?.focus();
        });
      }
      return;
    }

    let targetIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      targetIndex = Math.min(currentIndex + 1, tabs.length - 1);
    } else if (event.key === 'ArrowLeft') {
      targetIndex = Math.max(currentIndex - 1, 0);
    } else if (event.key === 'Home') {
      targetIndex = 0;
    } else if (event.key === 'End') {
      targetIndex = tabs.length - 1;
    }
    if (targetIndex === null) return;
    event.preventDefault();
    const targetTab = tabs[targetIndex];
    const targetPath = targetTab?.getAttribute('data-tab-path');
    if (targetPath && targetPath !== tabPath) {
      onSelect(targetPath);
    }
    targetTab?.querySelector<HTMLElement>('[role="tab"]')?.focus();
  }, [dragState, onClose, onSelect]);

  const stripClass = `session-tabs-strip${fadeLeft ? ' fade-left' : ''}${fadeRight ? ' fade-right' : ''}`;

  return (
    <div class={`session-tabs${dragState ? ' dragging' : ''}`}>
      <div
        ref={stripRef}
        class={stripClass}
        role="tablist"
        aria-label="Sessions"
        onKeyDown={(event) => onTabListKeyDown(event as KeyboardEvent)}
      >
        {renderedTabPaths.map((tabPath, index) => [
          <DropGap key={`drop-gap:${index}`} index={index} dropIndex={activeDropIndex} tabHeight={dropTabHeight} dragGapWidth={dragGapWidth} />,
          <SessionTab
            key={tabPath}
            tabPath={tabPath}
            index={index}
            sessionByPath={sessionByPath}
            openIndexByPath={openIndexByPath}
            runningPathSet={runningPathSet}
            unreadFinishedPathSet={unreadFinishedPathSet}
            activeSession={activeSession}
            hasPendingExtensionUIRequest={hasPendingRequest(pendingExtensionUIRequestsBySession, tabPath)}
            activeRunSummary={activeRunSummary}
            isPinned={pinnedPathSet.has(tabPath)}
            onContextMenu={onContextMenu}
            onPointerDown={onPointerDown}
            onClick={onClick}
            onClose={onClose}
            onMarkComplete={onMarkComplete}
          />,
        ])}
        <DropGap index={renderedTabPaths.length} dropIndex={activeDropIndex} tabHeight={dropTabHeight} dragGapWidth={dragGapWidth} />
      </div>
      <div class="session-tabs-actions">
        <button
          class="session-tabs-new"
          type="button"
          title="New session"
          onClick={onNew}
          aria-label="New session"
        >
          +
        </button>
        {!backendReady && !hideConnectingWheel && (
          <span class="session-tabs-connecting" title="Connecting to backend…" aria-label="Connecting">
            <span class="loading-wheel loading-wheel-sm" aria-hidden="true" />
          </span>
        )}
      </div>
      {dragState && draggedPath && (
        <FloatingSessionTab
          dragState={dragState}
          draggedPath={draggedPath}
          sessionByPath={sessionByPath}
          runningPathSet={runningPathSet}
          activeSession={activeSession}
          isPinned={pinnedPathSet.has(draggedPath)}
          ghostRef={ghostElementRef}
        />
      )}
      {tabContextMenu && (
        <SessionTabContextMenu
          tabContextMenu={tabContextMenu}
          sessionByPath={sessionByPath}
          runSummary={runSummariesBySession[tabContextMenu.tabPath] ?? null}
          isPinned={pinnedPathSet.has(tabContextMenu.tabPath)}
          onContextAction={onContextAction}
        />
      )}
    </div>
  );
}
