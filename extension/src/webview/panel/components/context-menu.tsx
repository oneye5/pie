/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { ChatPrefs } from '../../../shared/protocol';
import {
  type ChatPrefContextType,
  type TranscriptContextMenuType,
  getChatPrefContextLabel,
  getChatPrefContextValue,
  toggleChatPrefForContext,
} from '../chat-prefs';

export interface ContextMenuState {
  type: TranscriptContextMenuType;
  rawData: string;
  /** The live text selection captured at the moment the menu was opened, so
   * the "Copy" item can copy just the user's selection instead of the whole
   * block. Captured in handleOpenContextMenu (use-app-handlers.ts) rather than
   * at click time because the menu's focus-management moves focus to the
   * first item on open, which can clear the document's live selection. */
  selectionText: string;
  x: number;
  y: number;
  /** The trigger element that opened the menu (the onContextMenu target),
   * used to mirror the menu's open state back onto the trigger via
   * aria-haspopup/aria-expanded. Captured from the contextmenu event's
   * currentTarget in handleOpenContextMenu (use-app-handlers.ts). */
  triggerEl: HTMLElement | null;
}

export function ContextMenu({
  menu,
  prefs,
  onSetPrefs,
  onClose,
}: {
  menu: ContextMenuState;
  prefs: ChatPrefs;
  onSetPrefs: (p: Partial<ChatPrefs>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: menu.y, left: menu.x });

  // Position: measure the RENDERED menu after mount and clamp to the viewport.
  // If it would overflow the bottom/right, flip it above/left of the cursor
  // instead of clamping it under. Uses offsetWidth/offsetHeight so the
  // panel-scale-in transform doesn't skew the measurement. Runs before paint
  // (useLayoutEffect) so the corrected position is what the user first sees.
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

  // Focus management: capture the trigger that opened the menu, move focus to
  // the first item on open, and restore focus to the trigger on close. Trigger-
  // side aria-haspopup/aria-expanded are toggled separately below, keyed on
  // menu.triggerEl (the element that opened the menu).
  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    const firstItem = ref.current?.querySelector<HTMLButtonElement>('button.context-menu-item');
    firstItem?.focus();
    return () => {
      triggerRef.current?.focus?.();
    };
  }, []);

  // Trigger-side ARIA (Overlays-3): mirror the menu's open state onto the
  // trigger that opened it. aria-haspopup="menu" declares the trigger opens a
  // menu (left in place even after close, since the element still opens a menu);
  // aria-expanded toggles true while the menu is open for this trigger and
  // false otherwise. Keyed on the trigger element so a menu switch (a second
  // trigger opening while the first is still mounted) resets the previous
  // trigger before marking the new one, and unmount resets the last open
  // trigger. Complements round-1's menu-internal roles/focus work without
  // changing it.
  useEffect(() => {
    const trigger = menu.triggerEl;
    if (!trigger) return;
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'true');
    return () => {
      trigger.setAttribute('aria-expanded', 'false');
    };
  }, [menu.triggerEl]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      const node = ref.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll<HTMLButtonElement>('button.context-menu-item'));
      if (items.length === 0) return;
      const currentIndex = items.findIndex((it) => it === document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = currentIndex === -1 ? 0 : (currentIndex + 1) % items.length;
        items[next].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
        items[prev].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1].focus();
      }
    };
    // Don't close on scroll: the menu is position:fixed so it stays correctly
    // placed, and a capture-phase window scroll listener would dismiss the menu
    // whenever the transcript auto-scrolls during a run. Close on resize since
    // viewport changes can leave the fixed menu misplaced.
    const resize = () => onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', resize);
    };
  }, [onClose]);

  const style = `position:fixed;top:${pos.top}px;left:${pos.left}px`;

  const prefType: ChatPrefContextType | null = menu.type === 'message' ? null : menu.type;
  const checked = prefType ? getChatPrefContextValue(prefs, prefType) : false;
  const expandLabel = prefType ? getChatPrefContextLabel(prefType) : '';
  const expandToggle = prefType ? (
    <button
      class="context-menu-item"
      role="menuitem"
      type="button"
      onClick={() => {
        onSetPrefs(toggleChatPrefForContext(prefs, prefType));
        onClose();
      }}
    >
      <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={checked ? '' : 'opacity:0'}>
        <polyline points="2.5,6.5 5,9 10.5,3.5" />
      </svg>
      {expandLabel}
    </button>
  ) : null;

  // Copy the user's current text selection. Only shown when a non-empty
  // selection was captured at open time, so right-clicking selected text gives
  // the familiar "copy what I highlighted" action instead of forcing the
  // whole-block "Copy raw".
  const copySelection = menu.selectionText ? (
    <button
      class="context-menu-item"
      role="menuitem"
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(menu.selectionText);
        onClose();
      }}
    >
      <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
      Copy
    </button>
  ) : null;

  return (
    <div ref={ref} class="block-context-menu" role="menu" style={style} onMouseDown={(e) => e.stopPropagation()}>
      {expandToggle}
      {copySelection}
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(menu.rawData);
          onClose();
        }}
      >
        <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
        Copy raw
      </button>
    </div>
  );
}
