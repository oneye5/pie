/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { FileChangeKind } from '../../shared/protocol';
import { KIND_LABEL, basename } from './file-changes-stats';

export interface FileChangeContextMenuState {
  x: number;
  y: number;
  path: string;
  kind: FileChangeKind;
  /** Captured at open time so the menu can label/perform mark-read vs unread. */
  read: boolean;
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
export function FileChangeContextMenu({
  menu,
  onRevert,
  onSetFileRead,
  onClose,
}: {
  menu: FileChangeContextMenuState;
  onRevert: (path: string) => void;
  onSetFileRead: (path: string, read: boolean) => void;
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
        class="context-menu-item"
        role="menuitem"
        type="button"
        onClick={() => {
          onSetFileRead(menu.path, !menu.read);
          onClose();
        }}
      >
        <span class="context-menu-check" aria-hidden="true" />
        {menu.read ? 'Mark as unread' : 'Mark as read'}
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
