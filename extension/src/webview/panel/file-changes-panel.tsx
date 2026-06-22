/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FileChangeEntry } from '../../shared/protocol';
import { cx } from './utils/cx';
import { ResizeHandle } from './components/resize-handle';
import { useResizableWidth } from './components/use-resizable-width';

interface FileChangesPanelProps {
  fileChanges: FileChangeEntry[];
  expanded: boolean;
  onToggleExpanded: (expanded: boolean) => void;
  onOpenDiff: (filePath: string) => void;
  onOpenInEditor: (filePath: string) => void;
  onRevertFile: (filePath: string) => void;
}

const STATUS_LABELS: Record<FileChangeEntry['kind'], string> = {
  created: 'A',
  modified: 'M',
  deleted: 'D',
};

// Hover-intent / dismiss delays for the peek overlay (STATE_CONTRACT
// § Webview-Local State — peek/hover overlays). Tunable; see
// CHANGED-FILES-UI-PLAN D9.
const PEEK_OPEN_DELAY = 160;
const PEEK_CLOSE_DELAY = 120;

interface DiffTotals {
  additions: number;
  deletions: number;
  /** Largest single-file (additions + deletions) — ceiling for per-row bars
   *  so they are comparable by magnitude. */
  maxRowTotal: number;
}

export function computeDiffTotals(changes: FileChangeEntry[]): DiffTotals {
  let additions = 0;
  let deletions = 0;
  let maxRowTotal = 0;
  for (const c of changes) {
    const a = c.additions ?? 0;
    const d = c.deletions ?? 0;
    additions += a;
    deletions += d;
    const total = a + d;
    if (total > maxRowTotal) maxRowTotal = total;
  }
  return { additions, deletions, maxRowTotal };
}

/**
 * A stacked +/- diff bar — green (additions) + red (deletions). Vertical
 * (collapsed sliver; scaled to add+del so the bar fills and shows the add/del
 * split) or horizontal (per-row; scaled to the session's largest row so bars
 * are comparable by magnitude). Reused across collapsed and expanded states
 * for one magnitude language (CHANGED-FILES-UI-PLAN D2/D7).
 */
function DiffBar({
  additions,
  deletions,
  orientation,
  scale,
}: {
  additions: number;
  deletions: number;
  orientation: 'v' | 'h';
  scale: number;
}) {
  const denom = scale > 0 ? scale : 1;
  const addPct = Math.min(100, (additions / denom) * 100);
  const delPct = Math.min(100, (deletions / denom) * 100);
  if (orientation === 'v') {
    // column-reverse: additions (first child) anchor the bottom, deletions
    // stack above — additions-up reads like a growing bar.
    return (
      <span class="file-change-diff-bar is-vertical" aria-hidden="true">
        <span class="diff-bar-add" style={{ height: `${addPct}%` }} />
        <span class="diff-bar-del" style={{ height: `${delPct}%` }} />
      </span>
    );
  }
  return (
    <span class="file-change-diff-bar is-horizontal" aria-hidden="true">
      <span class="diff-bar-add" style={{ width: `${addPct}%` }} />
      <span class="diff-bar-del" style={{ width: `${delPct}%` }} />
    </span>
  );
}

function LineStats({ additions, deletions }: { additions?: number; deletions?: number }) {
  if (!additions && !deletions) return null;
  return (
    <span class="file-change-stats">
      {additions ? <span class="stat-additions">+{additions}</span> : null}
      {deletions ? <span class="stat-deletions">-{deletions}</span> : null}
    </span>
  );
}

function FilePath({ path }: { path: string }) {
  const parts = path.split(/[/\\]/);
  const name = parts.pop() ?? path;
  const dir = parts.join('/');
  return (
    <span class="file-change-path-text">
      {dir ? <span class="file-change-dir">{dir}/</span> : null}
      <span class="file-change-name">{name}</span>
    </span>
  );
}

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1100);
      })
      .catch(() => {
        /* ignore */
      });
  };

  return (
    <button
      class={`action-btn icon-only file-change-copy${copied ? ' is-copied' : ''}`}
      type="button"
      title={copied ? 'Copied!' : `Copy path: ${path}`}
      aria-label={copied ? 'Path copied' : `Copy path of ${path}`}
      onClick={onClick}
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="2.5,7 5.5,10 10.5,3.5" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7.5" height="7.5" rx="1" />
          <path d="M5.5 1.5 H10 a1 1 0 0 1 1 1 V6.5" />
        </svg>
      )}
    </button>
  );
}

function RevertButton({ path, onRevert }: { path: string; onRevert: (path: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (confirming) {
      onRevert(path);
      setConfirming(false);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    } else {
      setConfirming(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
    }
  };

  if (confirming) {
    return (
      <button
        class="action-btn danger file-change-revert file-change-revert-confirm"
        type="button"
        title="Click again to confirm revert"
        aria-label={`Confirm revert of ${path}`}
        onClick={onClick}
      >
        Confirm?
      </button>
    );
  }

  return (
    <button
      class="action-btn icon-only file-change-revert"
      type="button"
      title={`Revert changes to ${path}`}
      aria-label={`Revert ${path}`}
      onClick={onClick}
    >
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 6.5 a4.5 4.5 0 1 1 1.5 3" />
        <path d="M3 6.5 L3 3 L6 4" />
      </svg>
    </button>
  );
}

function StatusLabel({ kind }: { kind: FileChangeEntry['kind'] }) {
  return (
    <span class={`file-change-status file-change-status-${kind}`} role="img" aria-label={kind}>
      {STATUS_LABELS[kind]}
    </span>
  );
}

export function FileChangesPanel({
  fileChanges,
  expanded,
  onToggleExpanded,
  onOpenDiff,
  onOpenInEditor,
  onRevertFile,
}: FileChangesPanelProps) {
  const pinned = expanded;
  const [hasNewChanges, setHasNewChanges] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const prevCountRef = useRef(fileChanges.length);
  const railRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hover capability — touch devices get tap-to-peek instead of hover-peek
  // (CHANGED-FILES-UI-PLAN D8). SSR-safe (preact-render-to-string has no
  // window); the webview always has a window.
  const [canHover] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia('(hover: hover)').matches;
  });

  const totals = useMemo(() => computeDiffTotals(fileChanges), [fileChanges]);

  const { elRef, width: dragWidth, minWidth, maxWidth, startResize, resizeBy, reset } =
    useResizableWidth<HTMLDivElement>({ minWidth: 160, maxWidth: 480 });

  // hasNewChanges: pulse while unpinned and the count grows; clears on pin.
  useEffect(() => {
    const prev = prevCountRef.current;
    const curr = fileChanges.length;
    if (curr > prev && !pinned) setHasNewChanges(true);
    prevCountRef.current = curr;
    if (curr === 0) setHasNewChanges(false);
  }, [fileChanges.length, pinned]);

  // Pinning supersedes peek + clears the new-changes pulse. Also clear any
  // pending hover timer so a hover-then-quick-pin can't fire setPeeking(true)
  // after pinning (which would otherwise resurface the drawer as an overlay
  // when the user later unpins).
  useEffect(() => {
    if (pinned) {
      setHasNewChanges(false);
      setPeeking(false);
      if (openTimer.current) {
        clearTimeout(openTimer.current);
        openTimer.current = null;
      }
      if (closeTimer.current) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    }
  }, [pinned]);

  // Clear any pending hover timers on unmount.
  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const schedulePeekOpen = () => {
    if (!canHover || pinned) return;
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (peeking || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      setPeeking(true);
      openTimer.current = null;
    }, PEEK_OPEN_DELAY);
  };

  const schedulePeekClose = () => {
    if (!canHover) return;
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (!peeking || closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      setPeeking(false);
      closeTimer.current = null;
    }, PEEK_CLOSE_DELAY);
  };

  // Dismiss peek on click-outside / Escape (touch + desktop). Active only
  // while peeking and not pinned.
  useEffect(() => {
    if (!peeking || pinned) return;
    const onDown = (e: MouseEvent) => {
      const rail = railRef.current;
      if (rail && !rail.contains(e.target as Node)) setPeeking(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPeeking(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [peeking, pinned]);

  if (fileChanges.length === 0) return null;

  const count = fileChanges.length;
  const showDrawer = pinned || peeking;
  const drawerMode = pinned ? 'is-pinned' : 'is-peek';
  // Drag width applies only when pinned; peek always uses the CSS default
  // (peek is transient — resizing it is out of scope).
  const innerWidth = pinned && dragWidth ? dragWidth : undefined;

  const onSliverClick = () => {
    if (canHover) {
      // Desktop: click pins (durable). Hover handles the transient peek.
      onToggleExpanded(!pinned);
    } else {
      // Touch: tap toggles peek; pin via the header pin button.
      setPeeking((p) => !p);
    }
  };

  const sliverTitle = `${count} changed file${count === 1 ? '' : 's'} · +${totals.additions} / -${totals.deletions}`;

  return (
    <div
      ref={railRef}
      class={cx(
        'file-changes-rail',
        pinned && 'is-pinned',
        peeking && 'is-peeking',
        hasNewChanges && 'has-new-changes',
      )}
      onMouseEnter={schedulePeekOpen}
      onMouseLeave={schedulePeekClose}
    >
      {!pinned && (
        <button
          class="file-changes-sliver"
          type="button"
          onClick={onSliverClick}
          aria-expanded={peeking}
          aria-label={`File changes: ${count}. ${peeking ? 'Peeking' : canHover ? 'Hover or click to view' : 'Tap to view'}.`}
          title={sliverTitle}
        >
          <span class="file-changes-sliver-count">{count}</span>
          <DiffBar
            additions={totals.additions}
            deletions={totals.deletions}
            orientation="v"
            scale={totals.additions + totals.deletions}
          />
        </button>
      )}

      {pinned && (
        <ResizeHandle
          edge="left"
          onMouseDown={startResize('left')}
          width={dragWidth}
          minWidth={minWidth}
          maxWidth={maxWidth}
          onResizeBy={resizeBy}
          onReset={reset}
          label="Drag to resize file-changes rail"
        />
      )}

      <div
        class={cx('file-changes-drawer', showDrawer && drawerMode)}
        aria-hidden={!showDrawer}
        inert={!showDrawer}
      >
        <div
          ref={elRef}
          class="file-changes-drawer-inner"
          style={innerWidth ? { width: `${innerWidth}px` } : undefined}
        >
          <div class="file-changes-header">
            <span class="file-changes-aggregate">
              <span class="file-changes-aggregate-count">{count} file{count === 1 ? '' : 's'}</span>
              <span class="file-changes-aggregate-diff">
                <span class="stat-additions">+{totals.additions}</span>
                <span class="stat-deletions">-{totals.deletions}</span>
              </span>
            </span>
            {peeking && !pinned ? (
              <button
                class="action-btn icon-only file-changes-pin"
                type="button"
                aria-label="Keep file changes open (pin)"
                title="Keep open (pin)"
                onClick={() => onToggleExpanded(true)}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M4.5 1.5 H7.5 L6.6 4 V7 L8 8.5 H4 L5.4 7 V4 Z" />
                  <path d="M6 8.5 V10.5" />
                </svg>
              </button>
            ) : null}
            {pinned ? (
              <button
                class="action-btn icon-only file-changes-close"
                type="button"
                aria-label="Collapse file changes"
                title="Collapse file changes"
                onClick={() => onToggleExpanded(false)}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="9,3 6,6 9,9" />
                </svg>
              </button>
            ) : null}
          </div>
          <div class="file-changes-list" role="list">
            {fileChanges.map((change) => (
              <div key={change.path} class={`file-change-item kind-${change.kind}`} role="listitem">
                <div class="file-change-main">
                  <StatusLabel kind={change.kind} />
                  <button
                    class="file-change-path"
                    type="button"
                    title={`${change.kind}: ${change.path}\n${change.description}`}
                    onClick={() => onOpenDiff(change.path)}
                  >
                    <FilePath path={change.path} />
                  </button>
                  <DiffBar
                    additions={change.additions ?? 0}
                    deletions={change.deletions ?? 0}
                    orientation="h"
                    scale={totals.maxRowTotal}
                  />
                  <LineStats additions={change.additions} deletions={change.deletions} />
                </div>
                <div class="file-change-actions">
                  <button
                    class="action-btn icon-only file-change-open"
                    type="button"
                    title={change.kind === 'deleted' ? `${change.path} was deleted` : `Open ${change.path} in the editor`}
                    aria-label={change.kind === 'deleted' ? `${change.path} was deleted` : `Open ${change.path} in the editor`}
                    disabled={change.kind === 'deleted'}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (change.kind !== 'deleted') onOpenInEditor(change.path);
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M9 4.5 L11.5 2 L11.5 4.5" />
                      <path d="M11.5 2 L7 6.5" />
                      <path d="M11 8 V10.5 a0.5 0.5 0 0 1 -0.5 0.5 H2.5 a0.5 0.5 0 0 1 -0.5 -0.5 V2.5 a0.5 0.5 0 0 1 0.5 -0.5 H5" />
                    </svg>
                  </button>
                  <CopyPathButton path={change.path} />
                  <RevertButton path={change.path} onRevert={onRevertFile} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
