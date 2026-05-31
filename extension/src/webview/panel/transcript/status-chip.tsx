/** @jsxRuntime automatic */
/** @jsxImportSource preact */

/**
 * Shared status chip building block.
 *
 * A single visual primitive used across the transcript — message headers,
 * tool-call headers, and subagent headers — so that runtime status (running,
 * completed, failed, …) always looks and behaves identically regardless of
 * which surface renders it.
 *
 * Visuals (dot, border, colors, typography) live in `.status-chip` /
 * `.status-chip-<tone>` in `styles/status-chip.css`. Layout-specific concerns
 * (e.g. the fixed-width column used inside tool/subagent headers) are passed in
 * via `className` so the primitive stays presentation-only.
 */

export type StatusTone =
  | 'neutral'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'error';

export interface StatusChipProps {
  tone: StatusTone;
  label: string;
  /** Extra class for layout-specific concerns (e.g. fixed column width). */
  className?: string;
  /**
   * When set, the chip becomes an interactive control that copies this text to
   * the clipboard on click / Enter / Space and briefly flashes "Copied!".
   */
  copyText?: string;
  /** Accessible label for the interactive (copy) variant. */
  copyAriaLabel?: string;
  title?: string;
}

export function StatusChip({ tone, label, className, copyText, copyAriaLabel, title }: StatusChipProps) {
  const classes = `status-chip status-chip-${tone}${copyText ? ' has-error-detail' : ''}${className ? ` ${className}` : ''}`;

  if (!copyText) {
    return (
      <span class={classes} title={title}>
        <span class="status-chip-label">{label}</span>
      </span>
    );
  }

  const copy = (target: HTMLElement) => {
    navigator.clipboard.writeText(copyText);
    target.dataset.copied = '';
    setTimeout(() => {
      delete target.dataset.copied;
    }, 1200);
  };

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    copy(e.currentTarget as HTMLElement);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    copy(e.currentTarget as HTMLElement);
  };

  return (
    <span
      class={classes}
      title={title ?? copyText}
      role="button"
      tabIndex={0}
      aria-label={copyAriaLabel}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span class="status-chip-label">{label}</span>
    </span>
  );
}
