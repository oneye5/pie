/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from '../utils/cx';

interface ResizeHandleProps {
  edge: 'top' | 'bottom';
  onMouseDown: (e: MouseEvent) => void;
  class?: string;
  label?: string;
  /** Current height in px (for aria-valuenow); null until the user resizes. */
  height?: number | null;
  /** Min/max for aria-valuemin/aria-valuemax (and keyboard clamp). */
  minHeight?: number;
  maxHeight?: number;
  /** Keyboard resize: adjust height by delta px (clamped to min/max). */
  onResizeBy?: (delta: number) => void;
  /** Reset to the CSS default height (double-click). */
  onReset?: () => void;
}

/**
 * Visual + a11y wrapper for a vertical resize drag handle. Paired with
 * `useResizableHeight` (top + bottom handles) so any scrollable expanded
 * section can be grown in place from either edge. Styling lives under
 * `.resize-handle` in styles/highlight.css so every handle looks identical.
 *
 * Beyond pointer drag, the handle is keyboard-operable (role="separator"):
 * ArrowUp/ArrowDown nudge the height by 10px (direction matches the edge — up
 * grows a top handle, down grows a bottom handle) and double-click resets.
 */
export function ResizeHandle({
  edge,
  onMouseDown,
  class: className,
  label = 'Drag to resize',
  height,
  minHeight = 0,
  maxHeight,
  onResizeBy,
  onReset,
}: ResizeHandleProps) {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!onResizeBy) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      // Up grows a top handle (pull its edge up) and shrinks a bottom handle.
      onResizeBy(edge === 'top' ? 10 : -10);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      onResizeBy(edge === 'top' ? -10 : 10);
    }
  };

  return (
    <div
      class={cx('resize-handle', edge === 'top' ? 'resize-handle-top' : 'resize-handle-bottom', className)}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      title={label}
      tabIndex={0}
      aria-valuemin={minHeight}
      aria-valuemax={maxHeight}
      aria-valuenow={height ?? undefined}
      onMouseDown={onMouseDown}
      onKeyDown={handleKeyDown}
      onDblClick={onReset}
    />
  );
}
