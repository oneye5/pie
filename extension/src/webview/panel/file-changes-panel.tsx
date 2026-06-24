/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FileChangeEntry, FileChangeKind } from '../../shared/protocol';
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

// Reading order for the collapsed sliver's hover `title` kind breakdown:
// created → modified → deleted (calm → concerning).
const KIND_ORDER: { kind: FileChangeKind; label: string }[] = [
  { kind: 'created', label: 'Added' },
  { kind: 'modified', label: 'Modified' },
  { kind: 'deleted', label: 'Deleted' },
];

// Hover-intent / dismiss delays for the peek overlay (STATE_CONTRACT
// § Webview-Local State — peek/hover overlays). Tunable; see
// CHANGED-FILES-UI-PLAN D9.
const PEEK_OPEN_DELAY = 160;
const PEEK_CLOSE_DELAY = 120;

interface DiffTotals {
  additions: number;
  deletions: number;
}

/** Per-kind counts + line churn (drives the collapsed sliver's hover `title`
 * kind breakdown; the per-file list colors each name by kind instead). */
interface KindStats {
  count: number;
  additions: number;
  deletions: number;
}

export function computeDiffTotals(changes: FileChangeEntry[]): DiffTotals {
  let additions = 0;
  let deletions = 0;
  for (const c of changes) {
    additions += c.additions ?? 0;
    deletions += c.deletions ?? 0;
  }
  return { additions, deletions };
}

export function computeKindStats(
  changes: FileChangeEntry[],
): Record<FileChangeKind, KindStats> {
  const stats: Record<FileChangeKind, KindStats> = {
    created: { count: 0, additions: 0, deletions: 0 },
    modified: { count: 0, additions: 0, deletions: 0 },
    deleted: { count: 0, additions: 0, deletions: 0 },
  };
  for (const c of changes) {
    const s = stats[c.kind];
    s.count += 1;
    s.additions += c.additions ?? 0;
    s.deletions += c.deletions ?? 0;
  }
  return stats;
}

/** Long-form kind name for the row path aria-label, the context-menu title,
 * and the collapsed-sliver hover titles. */
const KIND_LABEL: Record<FileChangeKind, string> = {
  created: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
};

function LineStats({
  additions,
  deletions,
  path,
  onDiff,
}: {
  additions?: number;
  deletions?: number;
  path: string;
  onDiff: () => void;
}) {
  if (!additions && !deletions) return null;
  return (
    <button
      class="file-change-stats"
      type="button"
      aria-label={`View diff of ${path}`}
      title={`Open diff: ${path}`}
      onClick={onDiff}
    >
      <span class="stat-additions">{additions ? `+${additions}` : ''}</span>
      <span class="stat-deletions">{deletions ? `-${deletions}` : ''}</span>
    </button>
  );
}

function FileName({
  path,
  kind,
  disabled,
  onClick,
}: {
  path: string;
  kind: FileChangeKind;
  disabled?: boolean;
  onClick: () => void;
}) {
  const parts = path.split(/[/\\]/);
  const name = parts.pop() ?? path;
  const dir = parts.join('/');
  const label = disabled
    ? `${KIND_LABEL[kind]}: ${path} (deleted)`
    : `${KIND_LABEL[kind]}: open ${path} in the editor`;
  return (
    <span class="file-change-path-text" title={path}>
      {dir ? <span class="file-change-dir">{dir}/</span> : null}
      <button
        class="file-change-name"
        type="button"
        disabled={disabled}
        aria-label={label}
        title={disabled ? `Deleted — ${path}` : `Open ${path} in the editor`}
        onClick={onClick}
      >
        {name}
      </button>
    </span>
  );
}

/** Last path segment — the file's name without its directory. */
function basename(path: string): string {
  // Find the last path separator ("/" or "\") without a regex literal so the
  // source has no backslash escapes to mangle across tool/JSON round-trips.
  let i = path.length;
  while (i-- > 0) {
    const c = path.charCodeAt(i);
    if (c === 47 || c === 92) break; // 47 = forward slash, 92 = backslash
  }
  return i < 0 ? path : path.slice(i + 1);
}

export interface FileChangeContextMenuState {
  x: number;
  y: number;
  path: string;
  kind: FileChangeKind;
}

/**
 * Self-contained right-click menu for a changed-file row. Hosts the secondary
 * actions (Copy path, Revert) that don't earn a spot in the per-row hover
 * buttons — those stay limited to the two primary actions (View diff, View in
 * editor). Revert is a two-step confirm (click -> "Confirm revert?" -> click) to
 * guard the destructive op, mirroring the old in-row RevertButton. Positioned
 * and clamped to the viewport, dismissed on click-outside / Escape / scroll /
 * resize (same posture as the transcript ContextMenu). Rendered at the rail
 * level (position: fixed) so it escapes the drawer's overflow clipping.
 */
function FileChangeContextMenu({
  menu,
  onRevert,
  onClose,
}: {
  menu: FileChangeContextMenuState;
  onRevert: (path: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: menu.y, left: menu.x });
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clamp to viewport after first paint so the corrected position is what the
  // user first sees (mirrors the transcript ContextMenu).
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const margin = 4;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    let top = menu.y;
    let left = menu.x;
    if (top + height > window.innerHeight - margin) {
      const flipped = menu.y - height;
      top = flipped >= margin ? flipped : Math.max(margin, window.innerHeight - margin - height);
    }
    if (left + width > window.innerWidth - margin) {
      const flipped = menu.x - width;
      left = flipped >= margin ? flipped : Math.max(margin, window.innerWidth - margin - width);
    }
    top = Math.max(margin, top);
    left = Math.max(margin, left);
    setPos({ top, left });
  }, [menu.x, menu.y]);

  // Focus the first item on open; clear the copied-feedback timer on close.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button.context-menu-item')?.focus();
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  // Dismiss on click-outside / Escape / scroll / resize.
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const scroll = () => onClose();
    const resize = () => onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [onClose]);

  const copyPath = () => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard
      .writeText(menu.path)
      .then(() => {
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1100);
      })
      .catch(() => {
        /* ignore */
      });
  };

  const onRevertClick = () => {
    if (confirming) {
      onRevert(menu.path);
      onClose();
    } else {
      setConfirming(true);
    }
  };

  return (
    <div
      ref={ref}
      class="block-context-menu file-change-context-menu"
      role="menu"
      style={`position:fixed;top:${pos.top}px;left:${pos.left}px`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div class="file-change-ctx-title" title={menu.path}>
        {KIND_LABEL[menu.kind]} · {basename(menu.path)}
      </div>
      <div class="context-menu-separator" />
      <button class="context-menu-item" role="menuitem" type="button" onClick={copyPath}>
        <span class="context-menu-check" aria-hidden="true" />
        {copied ? 'Copied!' : 'Copy path'}
      </button>
      <button
        class={`context-menu-item${confirming ? ' is-danger' : ''}`}
        role="menuitem"
        type="button"
        onClick={onRevertClick}
      >
        <span class="context-menu-check" aria-hidden="true" />
        {confirming ? 'Confirm revert?' : 'Revert changes'}
      </button>
    </div>
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

  const kindStats = useMemo(() => computeKindStats(fileChanges), [fileChanges]);

  // Right-click context menu for a row (Copy path / Revert) — webview-local,
  // dismissed like the peek overlay (STATE_CONTRACT § Webview-Local State).
  const [ctxMenu, setCtxMenu] = useState<FileChangeContextMenuState | null>(null);
  const openCtxMenu = useCallback((e: MouseEvent, change: FileChangeEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, path: change.path, kind: change.kind });
  }, []);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const { elRef, width: dragWidth, minWidth, maxWidth, startResize, resizeBy, reset } =
    useResizableWidth<HTMLDivElement>({ minWidth: 180, maxWidth: 520 });

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

  const kindBreakdown = KIND_ORDER
    .map(({ kind, label }) => {
      const n = kindStats[kind].count;
      return n ? `${n} ${label.toLowerCase()}` : '';
    })
    .filter(Boolean)
    .join(', ');
  const sliverTitle =
    `${count} changed file${count === 1 ? '' : 's'}` +
    (kindBreakdown ? ` · ${kindBreakdown}` : '') +
    ` · +${totals.additions} / -${totals.deletions}`;

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
          <span class="file-changes-sliver-summary">
            <span class="file-changes-sliver-count">{count}</span>
            {(totals.additions > 0 || totals.deletions > 0) && (
              <span class="file-changes-sliver-magnitude">
                {totals.additions > 0 ? <span class="sliver-add">+{totals.additions}</span> : null}
                {totals.deletions > 0 ? <span class="sliver-del">-{totals.deletions}</span> : null}
              </span>
            )}
          </span>
          <span class="file-changes-sliver-files" aria-hidden="true">
            {fileChanges.map((c) => {
              const a = c.additions ?? 0;
              const d = c.deletions ?? 0;
              return (
                <span key={c.path} class={`sliver-file kind-${c.kind}`} title={`${c.path} · ${KIND_LABEL[c.kind]}`}>
                  <span class="sliver-file-row">
                    <span class="sliver-file-name">{basename(c.path)}</span>
                  </span>
                  <span class="sliver-file-row sliver-file-stats">
                    {a ? <span class="sliver-file-add">+{a}</span> : null}
                    {d ? <span class="sliver-file-del">-{d}</span> : null}
                  </span>
                </span>
              );
            })}
          </span>
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
            <span class="file-changes-header-actions">
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
            </span>
          </div>
          <div class="file-changes-list" role="list">
            {fileChanges.map((change) => (
              <div
                key={change.path}
                class={`file-change-item kind-${change.kind}`}
                role="listitem"
                onContextMenu={(e) => openCtxMenu(e, change)}
              >
                <div class="file-change-main">
                  <FileName
                    path={change.path}
                    kind={change.kind}
                    disabled={change.kind === 'deleted'}
                    onClick={() => onOpenInEditor(change.path)}
                  />
                  <LineStats
                    additions={change.additions}
                    deletions={change.deletions}
                    path={change.path}
                    onDiff={() => onOpenDiff(change.path)}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {ctxMenu && (
        <FileChangeContextMenu menu={ctxMenu} onRevert={onRevertFile} onClose={closeCtxMenu} />
      )}
    </div>
  );
}
