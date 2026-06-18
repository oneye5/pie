/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef } from 'preact/hooks';

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
  x: number;
  y: number;
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

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
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

  // Keep menu inside viewport
  const style = `position:fixed;top:${Math.min(menu.y, window.innerHeight - 120)}px;left:${Math.min(menu.x, window.innerWidth - 220)}px`;

  const prefType: ChatPrefContextType | null = menu.type === 'message' ? null : menu.type;
  const checked = prefType ? getChatPrefContextValue(prefs, prefType) : false;
  const expandLabel = prefType ? getChatPrefContextLabel(prefType) : '';
  const expandToggle = prefType ? (
    <button
      class="context-menu-item"
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

  return (
    <div ref={ref} class="block-context-menu" style={style} onMouseDown={(e) => e.stopPropagation()}>
      {expandToggle}
      <button
        class="context-menu-item"
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
