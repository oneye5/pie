/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef } from 'preact/hooks';

import { ResizeHandle } from '../../components/resize-handle';
import { useResizableHeight } from '../../components/use-resizable-height';

export function TerminalOutput({ text, running }: { text: string; running: boolean }) {
  const { scrollRef, height, startResize, minHeight, maxHeight, canResize, resizeBy, reset } = useResizableHeight<HTMLPreElement>();
  const stickToBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  };

  // Keep the pane pinned to the latest output as it streams in, unless the
  // user has scrolled up to read earlier output.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div class="resizable-scroll-area">
      {canResize && (
        <ResizeHandle
          edge="top"
          onMouseDown={startResize('top')}
          height={height}
          minHeight={minHeight}
          maxHeight={maxHeight}
          onResizeBy={resizeBy}
          onReset={reset}
        />
      )}
      <pre
        ref={scrollRef}
        class="tool-call-terminal-pre"
        onScroll={handleScroll}
        style={height ? { height: `${height}px`, maxHeight: 'none' } : undefined}
      >
        <code>{text}</code>
        {running && <span class="tool-call-terminal-cursor" aria-hidden="true" />}
      </pre>
      {canResize && (
        <ResizeHandle
          edge="bottom"
          onMouseDown={startResize('bottom')}
          height={height}
          minHeight={minHeight}
          maxHeight={maxHeight}
          onResizeBy={resizeBy}
          onReset={reset}
        />
      )}
    </div>
  );
}
