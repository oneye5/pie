/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from '../utils/cx';

interface DisclosureChevronProps {
  /** Whether the controlled content is expanded. */
  open: boolean;
  /** Square pixel size of the chevron. */
  size?: number;
  /** Extra classes (e.g. for color overrides). */
  class?: string;
}

/**
 * Single consistent disclosure chevron for dropdowns and expand/collapse
 * affordances across the panel (model picker, settings expand buttons,
 * pruning raw-output toggles). Points right when closed and rotates 90° to
 * point down when open. Styling lives under `.disclosure-chevron` in the
 * shared stylesheet so every call site stays visually identical.
 */
export function DisclosureChevron({ open, size = 10, class: className }: DisclosureChevronProps) {
  return (
    <svg
      class={cx('disclosure-chevron', open && 'disclosure-chevron-open', className)}
      width={size}
      height={size}
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}