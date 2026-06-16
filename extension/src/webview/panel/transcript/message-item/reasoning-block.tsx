/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMemo } from 'preact/hooks';

import { renderMarkdown, reasoningSummary } from '../../markdown';
import { cx } from '../../utils/cx';
import { useDisclosureOpen } from '../use-disclosure-open';

interface ReasoningBlockProps {
  text: string;
  autoExpand: boolean;
  disclosureKey: string;
  onContextMenu: (e: MouseEvent) => void;
}

export function ReasoningBlock({ text, autoExpand, disclosureKey, onContextMenu }: ReasoningBlockProps) {
  const [open, setOpen] = useDisclosureOpen(disclosureKey, autoExpand);

  const html = useMemo(() => (open ? renderMarkdown(text) : ''), [open, text]);

  return (
    <div
      class={cx(
        'cursor-pointer select-none rounded-md transition-colors duration-150 hover:bg-control-hover',
        open && 'bg-control/60',
      )}
      role="button"
      aria-expanded={open}
      aria-label="Toggle reasoning details"
      tabIndex={0}
      onClick={() => setOpen((v) => !v)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
    >
      <div class="flex items-center gap-1.5 px-2 py-1">
        <span class="transcript-header-label">Reasoning</span>
        {!open && (
          <span class="transcript-header-summary min-w-0 truncate">{reasoningSummary(text)}</span>
        )}
      </div>
      {open && (
        <div class="px-2.5 pb-2.5 text-xs leading-relaxed text-foreground select-text">
          <div
            class="message-body"
            dangerouslySetInnerHTML={{ __html: html }}
            aria-live="polite"
          />
        </div>
      )}
    </div>
  );
}
