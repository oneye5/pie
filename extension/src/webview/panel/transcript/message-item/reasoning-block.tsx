/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';

import { renderMarkdown, reasoningSummary } from '../../markdown';
import { cx } from '../../utils/cx';
import { Collapsible } from '../../components/collapsible';
import { ResizeHandle } from '../../components/resize-handle';
import { useResizableHeight } from '../../components/use-resizable-height';
import { useCollapsibleOpen } from '../use-collapsible-open';

interface ReasoningBlockProps {
  text: string;
  autoExpand: boolean;
  collapsibleKey: string;
  onContextMenu: (e: MouseEvent) => void;
}

/** Reasoning streams token-by-token; re-parsing the full markdown on every
 *  token is wasteful (marked + DOMPurify over a growing string) and flickers.
 *  Re-parse at most this often (ms) while text keeps changing. Mirrors the
 *  throttle constant in buffered-text-part.tsx. */
const REASONING_PARSE_THROTTLE_MS = 100;
/** Trailing parse delay (ms) after the last text change so the final text is
 *  always rendered, even without an explicit streaming-end signal. */
const REASONING_PARSE_TRAILING_MS = 120;

export function ReasoningBlock({ text, autoExpand, collapsibleKey, onContextMenu }: ReasoningBlockProps) {
  const [open, setOpen] = useCollapsibleOpen(collapsibleKey, autoExpand);
  const { scrollRef, height, startResize, minHeight, maxHeight, resizeBy, reset } = useResizableHeight<HTMLDivElement>();

  // Throttled markdown re-parse: leading parse at most once per
  // REASONING_PARSE_THROTTLE_MS while text keeps changing, plus a trailing
  // parse REASONING_PARSE_TRAILING_MS after the last change so the final text
  // is always rendered. When closed, render '' (no parse). This mirrors the
  // BufferedTextPart throttle but reasoning reveals the full text immediately
  // (no progressive reveal), so only the parse is throttled.
  const [html, setHtml] = useState(() => (open ? renderMarkdown(text) : ''));
  const lastParseAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // Latest text read by the scheduled (trailing) parse so it always reflects
  // the most recent token, not the token that scheduled it.
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    if (!open) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setHtml('');
      return;
    }

    // Leading parse: at most once per throttle window.
    const now = Date.now();
    if (now - lastParseAtRef.current >= REASONING_PARSE_THROTTLE_MS) {
      lastParseAtRef.current = now;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setHtml(renderMarkdown(textRef.current));
      return;
    }

    // Trailing parse: (re)schedule so it fires REASONING_PARSE_TRAILING_MS
    // after the last text change, guaranteeing the final text renders even
    // without a streaming-end signal.
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      lastParseAtRef.current = Date.now();
      setHtml(renderMarkdown(textRef.current));
    }, REASONING_PARSE_TRAILING_MS);
  }, [text, open]);

  // Clear any pending trailing parse on unmount.
  useEffect(() => () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return (
    <Collapsible
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
      <div class="resizable-scroll-area">
        <ResizeHandle
          edge="top"
          onMouseDown={startResize('top')}
          height={height}
          minHeight={minHeight}
          maxHeight={maxHeight}
          onResizeBy={resizeBy}
          onReset={reset}
        />
        <div
          ref={scrollRef}
          class="message-body reasoning-scroll"
          dangerouslySetInnerHTML={{ __html: html }}
          aria-live="polite"
          style={height ? { height: `${height}px`, maxHeight: 'none' } : undefined}
        />
        <ResizeHandle
          edge="bottom"
          onMouseDown={startResize('bottom')}
          height={height}
          minHeight={minHeight}
          maxHeight={maxHeight}
          onResizeBy={resizeBy}
          onReset={reset}
        />
      </div>
    </Collapsible>
  );
}
