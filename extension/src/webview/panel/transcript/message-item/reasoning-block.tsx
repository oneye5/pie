/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMemo } from 'preact/hooks';

import { renderMarkdown, reasoningSummary } from '../../markdown';
import { cx } from '../../utils/cx';
import { Disclosure } from '../../components/disclosure';
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
    <Disclosure
      open={open}
      onToggle={setOpen}
      ariaLabel="Toggle reasoning details"
      class={cx('rounded-md', open && 'bg-control/60')}
      headerClass="px-2 py-1"
      bodyClass="px-2.5 pb-2.5 leading-relaxed text-foreground"
      onContextMenu={onContextMenu}
      header={
        <>
          <span class="transcript-header-label">Reasoning</span>
          {!open ? (
            <span class="transcript-header-summary min-w-0 truncate">{reasoningSummary(text)}</span>
          ) : null}
        </>
      }
    >
      <div
        class="message-body"
        dangerouslySetInnerHTML={{ __html: html }}
        aria-live="polite"
      />
    </Disclosure>
  );
}
