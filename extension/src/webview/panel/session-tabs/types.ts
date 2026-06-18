import type { RefObject } from 'preact';
import type { SessionTabRunAction } from './run-state';

export type SessionTabContextAction = SessionTabRunAction | 'duplicate' | 'close';

export type TabDragCandidate = {
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

export type SessionTabDragState = {
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

export interface UseTabDragAndDropOptions {
  openTabPaths: string[];
  onMove: (sessionPath: string | undefined, fromIndex: number, toIndex: number) => void;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onDuplicate: (path: string) => void;
  onRunAction: (action: SessionTabRunAction, tabPath: string) => void;
  stripRef: RefObject<HTMLDivElement>;
}

export interface UseTabDragAndDropResult {
  dragState: SessionTabDragState | null;
  tabContextMenu: { x: number; y: number; tabPath: string } | null;
  setTabContextMenu: (v: { x: number; y: number; tabPath: string } | null) => void;
  onPointerDown: (event: PointerEvent, sourceIndex: number, sourcePath: string) => void;
  onClick: (tabPath: string) => void;
  onContextMenu: (event: MouseEvent, tabPath: string) => void;
  onContextAction: (action: SessionTabContextAction, tabPath: string) => void;
  autoScrollTickRef: RefObject<() => void>;
  dragCandidateRef: RefObject<TabDragCandidate | null>;
  dragStateRef: RefObject<SessionTabDragState | null>;
}