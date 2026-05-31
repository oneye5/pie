/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';

interface MessageHeaderProps {
  label?: string | null;
  timestamp?: string | null;
  duration?: string | null;
  durationTitle?: string;
  meta?: string | null;
  metaTitle?: string;
  title?: string;
  actions?: ComponentChildren;
}

export function MessageHeader({ label, timestamp, duration, durationTitle, meta, metaTitle, title, actions }: MessageHeaderProps) {
  return (
    <div class="flex items-start justify-between gap-3">
      <div class="flex min-w-0 flex-wrap items-center gap-[5px]" title={title}>
        {label && <span class="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</span>}
        {timestamp && <span class="text-[11px] text-muted">{timestamp}</span>}
        {duration && <span class="text-[10px] text-muted/60" title={durationTitle}>{duration}</span>}
        {meta && <span class="min-w-0 break-words font-mono text-[10px] text-muted/60" title={metaTitle}>{meta}</span>}
      </div>
      {actions && (
        <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-[5px]">
          {actions}
        </div>
      )}
    </div>
  );
}
