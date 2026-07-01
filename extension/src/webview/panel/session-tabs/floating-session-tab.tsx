/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { RefObject } from 'preact';

import type { SessionSummary } from '../../../shared/protocol';
import type { SessionTabDragState } from './types';
import { getTabAvatarColor, getTabAvatarLabel } from './tab-avatar';

export interface FloatingSessionTabProps {
  dragState: SessionTabDragState;
  draggedPath: string;
  sessionByPath: Map<string, SessionSummary>;
  runningPathSet: Set<string>;
  activeSession: SessionSummary | null;
  isPinned: boolean;
  ghostRef: RefObject<HTMLDivElement>;
}

export function FloatingSessionTab({
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
