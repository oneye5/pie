/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';

import { cx } from '../utils/cx';
import { DisclosureChevron } from './chevron';

export interface DisclosureProps {
  /** Controlled open state. Callers own this (useDisclosureOpen or useState). */
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Header content rendered on the leading side (label, summary, meta).
   *  Caller controls the full layout; Disclosure appends a trailing chevron. */
  header: ComponentChildren;
  /** Show the rotating chevron affordance. Default true. */
  chevron?: boolean;
  ariaLabel?: string;
  /** Outer wrapper classes (card surface, layout). */
  class?: string;
  /** Classes for the header `<button>` (padding, site-specific layout). */
  headerClass?: string;
  bodyClass?: string;
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
 * it — so expanded content stays selectable and nested disclosures compose
 * without propagation hacks.
 *
 * Controlled only — callers own the open state so streaming/auto-show sites
 * (tool calls, subagents) can keep their own open/close logic and still reuse
 * the same visual affordance via `DisclosureChevron` + `.disclosure-*` classes.
 */
export function Disclosure({
  open,
  onToggle,
  header,
  chevron = true,
  ariaLabel,
  class: className,
  headerClass,
  bodyClass,
  onContextMenu,
  dataAttrs,
  children,
}: DisclosureProps) {
  const toggle = () => onToggle(!open);

  return (
    <div
      class={cx('disclosure', open && 'disclosure-open', className)}
      {...(dataAttrs as Record<string, string> | undefined)}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); } : undefined}
    >
      <button
        type="button"
        class={cx('disclosure-header', headerClass)}
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={toggle}
      >
        <div class="disclosure-header-content">{header}</div>
        {chevron && <DisclosureChevron open={open} />}
      </button>
      {open && (
        <div class={cx('disclosure-body', bodyClass)}>
          {children}
        </div>
      )}
    </div>
  );
}
