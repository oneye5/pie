import { useCallback, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

export interface UseResizableHeightOptions {
  /** Minimum height in px. Default 120. */
  minHeight?: number;
  /** Maximum height in px. Defaults to 80% of the viewport at drag start. */
  maxHeight?: number;
  /** Called when a drag begins (e.g. to reset a stick-to-bottom flag). */
  onResizeStart?: () => void;
}

export interface ResizableHeight<T extends HTMLElement> {
  /** Attach to the scrollable element. */
  scrollRef: RefObject<T>;
  /** Resolved height in px once the user has resized; `null` until then (the
   *  element falls back to its CSS height/max-height). */
  height: number | null;
  /** Returns a mousedown handler bound to the given edge. */
  startResize: (edge: 'top' | 'bottom') => (e: MouseEvent) => void;
  /** Clear the user-set height, reverting to the CSS default. */
  reset: () => void;
}

/**
 * Vertical resize logic shared by every scrollable expanded section in the
 * transcript. Supports BOTH a top and a bottom drag handle so users can grow
 * the visible slice in place without scrolling. Height is ephemeral
 * webview-local state (STATE_CONTRACT § Webview-Local State — drag state); it
 * is intentionally not persisted.
 *
 * Generalises the original subagent top-only handle in tool-call-item.tsx.
 */
export function useResizableHeight<T extends HTMLElement = HTMLElement>(
  opts: UseResizableHeightOptions = {},
): ResizableHeight<T> {
  const { minHeight = 120, maxHeight, onResizeStart } = opts;
  const [height, setHeight] = useState<number | null>(null);
  const scrollRef = useRef<T>(null);

  // `edge` is a call-time argument (not a closure dep): each handle binds
  // `startResize('top')` / `startResize('bottom')` once, capturing its edge.
  const startResize = useCallback(
    (edge: 'top' | 'bottom') => (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = scrollRef.current;
      if (!el) return;
      const startY = e.clientY;
      const startH = el.clientHeight;
      const maxH = maxHeight ?? Math.round(window.innerHeight * 0.8);
      onResizeStart?.();
      const onMove = (ev: MouseEvent) => {
        const delta = edge === 'top' ? startY - ev.clientY : ev.clientY - startY;
        const next = Math.max(minHeight, Math.min(maxH, Math.round(startH + delta)));
        setHeight(next);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [minHeight, maxHeight, onResizeStart],
  );

  const reset = useCallback(() => setHeight(null), []);

  return { scrollRef, height, startResize, reset };
}
