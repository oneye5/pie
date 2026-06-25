/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';

import { cx } from '../utils/cx';
import { CollapsibleChevron } from './chevron';

export interface CollapsibleProps {
  /** Controlled open state. Callers own this (useCollapsibleOpen or useState). */
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Header content rendered on the leading side (label, summary, meta).
   *  Caller controls the full layout; Collapsible appends a trailing chevron. */
  header: ComponentChildren;
  /** Show the rotating chevron affordance. Default true. */
  chevron?: boolean;
  ariaLabel?: string;
  /** Outer wrapper classes (card surface, layout). */
  class?: string;
  /** Classes for the header `<button>` (padding, site-specific layout). */
  headerClass?: string;
  bodyClass?: string;
  /** Pin the header to the top of the transcript scroll viewport while the
   *  body is in view (`position: sticky`) so the collapse control stays
   *  reachable inside a tall open body (e.g. reasoning the user resized
   *  tall). Adds an opaque header surface so scrolling content stays hidden
   *  beneath the pinned header. Default off — other collapsibles are
   *  unaffected. */
  stickyHeader?: boolean;
  onContextMenu?: (e: MouseEvent) => void;
  /** Optional data-* attributes for the outer wrapper (e.g. scroll anchors). */
  dataAttrs?: Record<string, string>;
  children: ComponentChildren;
}

/**
 * Generic, consistent expand/collapse container for transcript sections
 * (reasoning, system prompts, pruning, …). Provides a single clear collapse
 * affordance: the header is a real `<button>` (native keyboard + a11y, no
 * div-onClick) carrying a trailing rotating chevron, hover/focus states, and
 * `aria-expanded`. The body is a sibling of the button — never nested inside
 * it — so expanded content stays selectable and nested collapsibles compose
 * without propagation hacks.
 *
 * Controlled only — callers own the open state so streaming/auto-show sites
 * (tool calls, subagents) can keep their own open/close logic and still reuse
 * the same visual affordance via `CollapsibleChevron` + `.collapsible-*` classes.
 */
export function Collapsible({
  open,
  onToggle,
  header,
  chevron = true,
  ariaLabel,
  class: className,
  headerClass,
  bodyClass,
  stickyHeader = false,
  onContextMenu,
  dataAttrs,
  children,
}: CollapsibleProps) {
  const toggle = () => onToggle(!open);
  // Stable id for the body region so the header button can reference it via
  // `aria-controls`. Only set on the header when the body is actually mounted
  // (open) — the body is lazily rendered for perf, so referencing a missing
  // id when collapsed would be invalid per WAI-ARIA.
  const bodyId = useId();

  return (
    <div
      class={cx('collapsible', open && 'collapsible-open', className)}
      {...(dataAttrs as Record<string, string> | undefined)}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); } : undefined}
    >
      <button
        type="button"
        class={cx('collapsible-header', stickyHeader && 'collapsible-sticky-header', headerClass)}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        aria-label={ariaLabel}
        onClick={toggle}
      >
        <div class="collapsible-header-content">{header}</div>
        {chevron && <CollapsibleChevron open={open} />}
      </button>
      {open && (
        <div id={bodyId} class={cx('collapsible-body', bodyClass)}>
          {children}
        </div>
      )}
    </div>
  );
}
