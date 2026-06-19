/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from '../utils/cx';

interface ResizeHandleProps {
  edge: 'top' | 'bottom';
  onMouseDown: (e: MouseEvent) => void;
  class?: string;
  label?: string;
}

/**
 * Visual + a11y wrapper for a vertical resize drag handle. Paired with
 * `useResizableHeight` (top + bottom handles) so any scrollable expanded
 * section can be grown in place from either edge. Styling lives under
 * `.resize-handle` in styles/highlight.css so every handle looks identical.
 */
export function ResizeHandle({ edge, onMouseDown, class: className, label = 'Drag to resize' }: ResizeHandleProps) {
  return (
    <div
      class={cx('resize-handle', edge === 'top' ? 'resize-handle-top' : 'resize-handle-bottom', className)}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      title={label}
      tabIndex={-1}
      onMouseDown={onMouseDown}
    />
  );
}
