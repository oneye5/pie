/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useRef } from 'preact/hooks';

import type { ActiveRunSummary, ExtensionUIRequestPayload, SessionSummary } from '../../../shared/protocol';
import { isPendingTabPath } from '../../../shared/tab-behavior';
import { getSessionTabRunBadge, getSessionTabRunMenuItems } from './run-state';
import type { SessionTabRunAction } from './run-state';
import { useTabDragAndDrop } from './use-drag-and-drop.js';
import type { SessionTabContextAction, SessionTabDragState } from './types';

interface SessionTabsProps {
  sessions: SessionSummary[];
  openTabPaths: string[];
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
  onRunAction: (action: SessionTabRunAction, tabPath: string) => void;
}

interface DropGapProps {
  index: number;
  dragState: SessionTabDragState | null;
  dragGapWidth: number;
}

function DropGap({ index, dragState, dragGapWidth }: DropGapProps) {
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
}

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
  onContextMenu: (event: MouseEvent, tabPath: string) => void;
  onPointerDown: (event: PointerEvent, sourceIndex: number, sourcePath: string) => void;
  onClick: (tabPath: string) => void;
  onClose: (tabPath: string) => void;
  onMarkComplete: () => void;
}

export function SessionTab({
  tabPath,
  index,
  sessionByPath,
  openIndexByPath,
  runningPathSet,
  unreadFinishedPathSet,
  activeSession,
  hasPendingExtensionUIRequest,
  activeRunSummary,
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

  return (
    <div
      key={tabPath}
      class={`session-tab${isActive ? ' active' : ''}${isAttention ? ' attention' : ''}${isUnreadFinished ? ' unread-finished' : ''}`}
      data-drop-target-tab="true"
      onContextMenu={(event) => onContextMenu(event as MouseEvent, tabPath)}
    >
      <span class="session-tab-shell" aria-hidden="true" />
      <button
        class="session-tab-main"
        type="button"
        role="tab"
        aria-selected={isActive}
        title={title}
        onPointerDown={(event) => onPointerDown(event as PointerEvent, originalIndex, tabPath)}
        onClick={() => onClick(tabPath)}
      >
        {isRunning
          ? <span class="session-tab-running" aria-hidden="true" />
          : isUnreadFinished
            ? <span class="session-tab-finished" aria-hidden="true" />
            : null}
        <span class="session-tab-label">{label}</span>
      </button>
      {isActive && (
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
      <button
        class="session-tab-close"
        type="button"
        aria-label={`Close ${label}`}
        title={`Close ${label}`}
        onClick={() => onClose(tabPath)}
      >
        ×
      </button>
    </div>
  );
}

interface FloatingSessionTabProps {
  dragState: SessionTabDragState;
  draggedPath: string;
  sessionByPath: Map<string, SessionSummary>;
  runningPathSet: Set<string>;
  activeSession: SessionSummary | null;
}

function FloatingSessionTab({
  dragState,
  draggedPath,
  sessionByPath,
  runningPathSet,
  activeSession,
}: FloatingSessionTabProps) {
  const floatingSession = sessionByPath.get(draggedPath);
  const floatingLabel = floatingSession?.name ?? 'New Session';
  const floatingRunning = runningPathSet.has(draggedPath);
  const floatingActive = activeSession?.path === draggedPath;

  return (
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
  );
}

interface SessionTabContextMenuProps {
  tabContextMenu: { x: number; y: number; tabPath: string };
  sessionByPath: Map<string, SessionSummary>;
  runSummary: ActiveRunSummary | null;
  onContextAction: (action: SessionTabContextAction, tabPath: string) => void;
}

function SessionTabContextMenu({
  tabContextMenu,
  sessionByPath,
  runSummary,
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
  } = useTabDragAndDrop({
    openTabPaths,
    onMove,
    onSelect,
    onClose,
    onDuplicate,
    onRunAction,
    stripRef,
  });

  const sessionByPath = new Map(sessions.map((session) => [session.path, session]));
  const openIndexByPath = new Map(openTabPaths.map((path, index) => [path, index]));
  const runningPathSet = new Set(runningSessionPaths);
  const unreadFinishedPathSet = new Set(unreadFinishedSessionPaths);

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

  return (
    <div class={`session-tabs${dragState ? ' dragging' : ''}`}>
      <div ref={stripRef} class="session-tabs-strip" role="tablist" aria-label="Sessions">
        {renderedTabPaths.map((tabPath, index) => [
          <DropGap key={`drop-gap:${index}`} index={index} dragState={dragState} dragGapWidth={dragGapWidth} />,
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
            onContextMenu={onContextMenu}
            onPointerDown={onPointerDown}
            onClick={onClick}
            onClose={onClose}
            onMarkComplete={onMarkComplete}
          />,
        ])}
        <DropGap index={renderedTabPaths.length} dragState={dragState} dragGapWidth={dragGapWidth} />
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
        />
      )}
      {tabContextMenu && (
        <SessionTabContextMenu
          tabContextMenu={tabContextMenu}
          sessionByPath={sessionByPath}
          runSummary={runSummariesBySession[tabContextMenu.tabPath] ?? null}
          onContextAction={onContextAction}
        />
      )}
    </div>
  );
}
