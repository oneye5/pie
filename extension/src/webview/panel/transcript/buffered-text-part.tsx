/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';

import { renderMarkdown } from '../markdown';
import { useBufferedText } from './use-buffered-text';

interface BufferedTextPartProps {
  messageId: string;
  index: number;
  text: string;
  streaming: boolean;
  onContextMenu: (e: Event) => void;
}

/** Re-parse streamed markdown at most this often (ms): bounds marked+DOMPurify cost and reduces mid-token flicker. */
const MARKDOWN_PARSE_THROTTLE_MS = 100;

/**
 * Renders a text part with buffered smooth streaming.
 *
 * During streaming, text is revealed progressively to prevent layout jumps
 * when large chunks arrive at once. Once streaming ends, full text is shown.
 *
 * Markdown is re-parsed at most every `MARKDOWN_PARSE_THROTTLE_MS` during
 * streaming instead of on every rAF tick: the buffered text is sliced to the
 * revealed length each frame, so re-parsing every frame both wastes work
 * (marked + DOMPurify) and flickers, since mid-token slices yield malformed
 * markdown. When streaming ends the complete text is parsed immediately.
 */
export function BufferedTextPart({ messageId, index, text, streaming, onContextMenu }: BufferedTextPartProps) {
  const visibleText = useBufferedText(text, streaming);
  const [html, setHtml] = useState(() => renderMarkdown(streaming ? visibleText : text));
  const lastParseAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const visibleTextRef = useRef(visibleText);
  visibleTextRef.current = visibleText;

  useEffect(() => {
    if (!streaming) {
      // Final render: parse the complete text immediately and cancel any
      // pending throttled parse.
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setHtml(renderMarkdown(visibleTextRef.current));
      return;
    }

    const now = Date.now();
    if (now - lastParseAtRef.current >= MARKDOWN_PARSE_THROTTLE_MS) {
      lastParseAtRef.current = now;
      setHtml(renderMarkdown(visibleTextRef.current));
      return;
    }

    // Schedule a parse at the end of the throttle window if one isn't already
    // pending. The scheduled parse reads the latest revealed text via the ref
    // so it always reflects the most recent frame.
    if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        lastParseAtRef.current = Date.now();
        setHtml(renderMarkdown(visibleTextRef.current));
      }, MARKDOWN_PARSE_THROTTLE_MS);
    }
  }, [visibleText, streaming]);

  // Clear any pending throttled parse on unmount.
  useEffect(() => () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return (
    <div
      key={`text-${messageId}-${index}`}
      class={`message-body${streaming ? ' streaming-text' : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
    />
  );
}
